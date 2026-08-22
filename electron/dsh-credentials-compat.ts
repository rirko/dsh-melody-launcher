import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument, stringify } from 'yaml'

const CREDENTIALS_FILENAME = '.credentials.yaml'
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const NEW_CREDENTIALS_VERSION = 1

export interface LegacyCredentialsSession {
  restore(): Promise<void>
}

export type DshCredentialsFormat = 'legacy' | 'modern' | 'unknown'

/** Only this startup-schema error is safe to use as a legacy-format retry signal. */
export function isLegacyCredentialsFormatError(text: string): boolean {
  return /(?:credentials-local|credentials)[\s\S]{0,500}(?:value for\s+["']version["']|version)[\s\S]{0,200}must be a string/i.test(text)
}

interface RecoveryRecord {
  targetPath: string
  backupPath: string
  metadataPath: string
}

interface ParsedModernCredentials {
  document: ReturnType<typeof parseDocument>
  refs: Record<string, string>
}

function credentialsPath(dshHome: string): string {
  return path.join(dshHome, CREDENTIALS_FILENAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseModernCredentials(source: string): ParsedModernCredentials | null {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) return null
  const value = document.toJS() as unknown
  if (!isRecord(value) || value.version !== NEW_CREDENTIALS_VERSION || !isRecord(value.refs)) return null

  const refs: Record<string, string> = {}
  for (const [name, secret] of Object.entries(value.refs)) {
    // The legacy parser only understands non-empty string values. Unknown or
    // structured metadata is intentionally omitted from the compatibility view.
    if (CREDENTIAL_NAME.test(name) && typeof secret === 'string' && secret.length > 0) refs[name] = secret
  }
  return { document, refs }
}

function parseLegacyCredentials(source: string): Record<string, string> | null {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) return null
  const value = document.toJS() as unknown
  if (!isRecord(value)) return null
  const result: Record<string, string> = {}
  for (const [name, secret] of Object.entries(value)) {
    if (!CREDENTIAL_NAME.test(name) || typeof secret !== 'string' || secret.length === 0) return null
    result[name] = secret
  }
  return result
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 })
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, targetPath)
    await chmod(targetPath, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function modernDocumentWithRefs(source: string, refs: Record<string, string>): string | null {
  const parsed = parseModernCredentials(source)
  if (!parsed) return null
  parsed.document.set('refs', refs)
  return parsed.document.toString({ lineWidth: 0 })
}

function isLegacyDshVersion(version: string | null | undefined): boolean {
  if (!version) return false
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  // The 0.1.0 line uses the flat credentials document. The 0.1.1 line and
  // later use versioned refs, including 0.1.1 prereleases.
  return Number(match[1]) === 0 && Number(match[2]) === 1 && Number(match[3]) === 0
}

export async function detectDshCredentialsFormat(
  dshVersion: string | null | undefined,
  executable: string,
): Promise<DshCredentialsFormat> {
  const resolvedVersion = await readDshVersionFromExecutable(executable) ?? dshVersion
  if (!resolvedVersion) return 'unknown'
  return isLegacyDshVersion(resolvedVersion) ? 'legacy' : 'modern'
}

async function readDshVersionFromExecutable(executable: string): Promise<string | null> {
  const executableDirectory = path.dirname(executable)
  const candidates = new Set<string>()
  let current = executableDirectory
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.add(path.join(current, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    candidates.add(path.join(current, '@deepseek-ai', 'dsh', 'package.json'))
    // Application add-ons are installed with pnpm. Their entry script is
    // usually below `.pnpm/<package>/node_modules/...`, while the DSH runtime
    // itself lives in a sibling `.pnpm/@deepseek-ai+dsh@...` package. Discover
    // that layout without recursively scanning the whole add-on directory.
    const pnpmRoot = path.join(current, 'node_modules', '.pnpm')
    const pnpmEntries = await readdir(pnpmRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of pnpmEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith('@deepseek-ai+dsh@')) continue
      candidates.add(path.join(pnpmRoot, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(candidate, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version
    } catch {
      // Try the next npm/pnpm layout.
    }
  }
  return null
}

function sessionId(): string {
  return `legacy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Temporarily exposes a 0.1.x-compatible flat credentials document to an old
 * DSH process. The original versioned document remains in a private backup
 * outside DSH_HOME and is restored when the process exits.
 */
export async function prepareLegacyCredentials(
  dshHome: string,
  dshVersion: string | null | undefined,
  executable: string,
  backupRoot: string,
  options: { force?: boolean } = {},
): Promise<LegacyCredentialsSession | null> {
  // Prefer the package manifest next to the actual executable. This avoids
  // applying the old format when a stale settings entry disagrees with the
  // selected executable; the setting remains the fallback for test shims and
  // npx-managed layouts where no local manifest is discoverable.
  const resolvedVersion = await readDshVersionFromExecutable(executable) ?? dshVersion
  if (!options.force && !isLegacyDshVersion(resolvedVersion)) return null

  const targetPath = credentialsPath(dshHome)
  let originalSource: string
  try {
    originalSource = await readFile(targetPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const modern = parseModernCredentials(originalSource)
  if (!modern) return null

  const id = sessionId()
  const backupPath = path.join(backupRoot, `${id}.yaml`)
  const metadataPath = path.join(backupRoot, `${id}.json`)
  const record: RecoveryRecord = { targetPath, backupPath, metadataPath }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  try {
    await writeFile(backupPath, originalSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await writeFile(metadataPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await atomicWrite(targetPath, stringify(modern.refs, { lineWidth: 0 }))
  } catch (error) {
    await rm(metadataPath, { force: true }).catch(() => undefined)
    await rm(backupPath, { force: true }).catch(() => undefined)
    throw error
  }

  let restored = false
  return {
    async restore(): Promise<void> {
      if (restored) return
      restored = true
      try {
        const currentSource = await readFile(targetPath, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        const backupSource = await readFile(backupPath, 'utf8')
        // If DSH itself already wrote the new structure, never overwrite it.
        const currentModern = currentSource === null ? null : parseModernCredentials(currentSource)
        const restoredSource = currentModern
          ? currentSource
          : currentSource === null
            ? backupSource
            : modernDocumentWithRefs(backupSource, parseLegacyCredentials(currentSource) ?? modern.refs)
        if (restoredSource !== null) await atomicWrite(targetPath, restoredSource)
      } finally {
        await rm(metadataPath, { force: true }).catch(() => undefined)
        await rm(backupPath, { force: true }).catch(() => undefined)
      }
    },
  }
}

/** Recover sessions left behind if the launcher or DSH was terminated abruptly. */
export async function recoverLegacyCredentials(backupRoot: string): Promise<void> {
  const entries = await readdir(backupRoot, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const metadataFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
  for (const entry of metadataFiles) {
    const metadataPath = path.join(backupRoot, entry.name)
    try {
      const record = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<RecoveryRecord>
      if (!record.targetPath || !record.backupPath) throw new Error('凭据恢复记录无效。')
      const backupSource = await readFile(record.backupPath, 'utf8')
      const currentSource = await readFile(record.targetPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (currentSource === null || !parseModernCredentials(currentSource)) await atomicWrite(record.targetPath, backupSource)
    } finally {
      const backupPath = path.join(backupRoot, entry.name.replace(/\.json$/, '.yaml'))
      await rm(metadataPath, { force: true }).catch(() => undefined)
      await rm(backupPath, { force: true }).catch(() => undefined)
    }
  }
}
