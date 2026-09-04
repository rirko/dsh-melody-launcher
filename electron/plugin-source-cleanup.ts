import { access, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { PluginInstallReceipt } from './plugin-receipts'

/**
 * The plugin source directory contains two kinds of persistent artifacts:
 * GitHub snapshots (`owner/repository/commit`) and release archives. Local
 * `file:` receipts may also point at a directory below the same root. This
 * module only removes paths that can be derived from a receipt and that are
 * no longer referenced by another receipt or Profile manifest.
 */
export interface PluginSourceCleanupOptions {
  sourceRoot: string
  removedReceipts: readonly PluginInstallReceipt[]
  remainingReceipts: readonly PluginInstallReceipt[]
  /** `file:` dependency targets captured before their Profile entry was removed. */
  removedFileReferences?: readonly string[]
  profileRoot?: string
}

interface CacheCandidate {
  path: string
  kind: 'directory' | 'file'
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  // Windows paths are case-insensitive. Lower-casing on every platform is
  // harmless for the comparison keys and keeps tests deterministic.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = normalizedPath(root)
  const normalizedTarget = normalizedPath(target)
  return normalizedTarget !== normalizedRoot && normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
}

function githubRepository(value: string | undefined): { owner: string; name: string } | null {
  if (!value) return null
  const normalized = value.trim().replace(/^git\+/, '')
  const match = normalized.match(/(?:github:|github\.com[/:]|codeload\.github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i)
  if (match) return { owner: match[1], name: match[2].replace(/\.git$/i, '') }
  const shortcut = normalized.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/i)
  return shortcut ? { owner: shortcut[1], name: shortcut[2] } : null
}

function safePackagePart(packageName: string): string {
  return packageName.replace(/[^a-z0-9._-]+/gi, '-')
}

function safePackageName(packageName: string): boolean {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)
}

function safeToken(value: string | null | undefined): string | null {
  const token = value?.trim()
  return token && /^[A-Za-z0-9._+~-]{1,256}$/.test(token) ? token : null
}

function decodeFileSpecifier(value: string): string | null {
  let raw = value.slice('file:'.length).trim()
  if (!raw) return null
  try {
    raw = decodeURIComponent(raw)
  } catch {
    // Keep the original path when a legacy receipt contains malformed escapes.
  }
  // Installer-generated receipts use `file:<absolute path>`. Accommodate the
  // common URL form too, without accepting a host component.
  if (/^\/\//.test(raw)) {
    try {
      const parsed = new URL(`file:${raw}`)
      if (parsed.host && parsed.host !== 'localhost') return null
      raw = decodeURIComponent(parsed.pathname)
      if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1)
    } catch {
      return null
    }
  }
  return raw
}

function candidateForReceipt(sourceRoot: string, receipt: PluginInstallReceipt): CacheCandidate | null {
  if (receipt.source === 'archive-subdirectory' || receipt.source === 'github') {
    const repository = githubRepository(receipt.repository)
    const commit = receipt.commit?.trim()
    if (!repository || !commit || !/^[a-f0-9]{40}$/i.test(commit)) return null
    const relativeSubdirectory = receipt.subdirectory?.trim() ?? ''
    if (relativeSubdirectory) {
      const normalized = path.posix.normalize(relativeSubdirectory.replaceAll('\\', '/'))
      if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
      return {
        path: path.join(sourceRoot, repository.owner, repository.name, commit, ...normalized.split('/')),
        kind: 'directory',
      }
    }
    return {
      path: path.join(sourceRoot, repository.owner, repository.name, commit),
      kind: 'directory',
    }
  }

  if (receipt.source === 'release') {
    const token = safeToken(receipt.version) ?? safeToken(receipt.commit)
    if (!token || !safePackageName(receipt.packageName)) return null
    return {
      path: path.join(sourceRoot, `${safePackagePart(receipt.packageName)}-${token}.tgz`),
      kind: 'file',
    }
  }

  // Local installs can be sourced from a downloaded pack snapshot or a
  // release archive. Only paths explicitly prefixed with `file:` and located
  // below the launcher's source root are eligible; arbitrary user directories
  // must never be deleted by uninstall.
  if (receipt.source === 'local-directory' && receipt.repository.startsWith('file:')) {
    const raw = decodeFileSpecifier(receipt.repository)
    if (!raw) return null
    return { path: path.resolve(raw), kind: 'directory' }
  }
  return null
}

function candidateForFileReference(sourceRoot: string, reference: string): CacheCandidate | null {
  const target = path.resolve(reference)
  if (!isInside(sourceRoot, target)) return null
  const relative = path.relative(sourceRoot, target)
  const parts = relative.split(path.sep).filter(Boolean)
  if (parts.length === 0) return null

  // Non-standard pack snapshots are created as one launcher-owned `pack-*`
  // directory. Remove the snapshot as a unit; any other package still using
  // it will be detected by the remaining Profile file-reference scan.
  if (/^pack-[A-Za-z0-9._-]+$/.test(parts[0])) {
    return { path: path.join(sourceRoot, parts[0]), kind: 'directory' }
  }
  if (parts.length === 1 && parts[0].toLowerCase().endsWith('.tgz')) {
    return { path: target, kind: 'file' }
  }
  return { path: target, kind: 'directory' }
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right)
}

function pathReferencesCandidate(reference: string, candidate: CacheCandidate): boolean {
  if (candidate.kind === 'file') return samePath(reference, candidate.path)
  return samePath(reference, candidate.path) || normalizedPath(reference).startsWith(`${normalizedPath(candidate.path)}${path.sep}`)
}

function candidatesOverlap(left: CacheCandidate, right: CacheCandidate): boolean {
  if (left.kind === 'file' || right.kind === 'file') return left.kind === 'file' && right.kind === 'file' && samePath(left.path, right.path)
  const a = normalizedPath(left.path)
  const b = normalizedPath(right.path)
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
}

async function profileFileReferences(profileRoot: string | undefined): Promise<string[]> {
  if (!profileRoot) return []
  const references: string[] = []
  const entries = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(profileRoot, entry.name, 'package.json')
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = manifest[field]
      if (!dependencies || typeof dependencies !== 'object') continue
      for (const specifier of Object.values(dependencies as Record<string, unknown>)) {
        if (typeof specifier !== 'string' || !specifier.startsWith('file:')) continue
        const raw = decodeFileSpecifier(specifier)
        if (!raw) continue
        references.push(path.resolve(path.dirname(manifestPath), raw))
      }
    }
  }
  return references
}

async function removeEmptyAncestors(sourceRoot: string, start: string): Promise<void> {
  let current = path.dirname(start)
  const root = path.resolve(sourceRoot)
  while (isInside(root, current)) {
    try {
      const children = await readdir(current)
      if (children.length > 0) break
      await rm(current, { recursive: false, force: true })
    } catch {
      break
    }
    current = path.dirname(current)
  }
}

/** Remove source caches that are provably unused after a plugin uninstall. */
export async function purgeUnusedPluginSources(options: PluginSourceCleanupOptions): Promise<string[]> {
  const root = path.resolve(options.sourceRoot)
  const references = await profileFileReferences(options.profileRoot)
  const remainingCandidates: CacheCandidate[] = []
  for (const receipt of options.remainingReceipts) {
    const candidate = candidateForReceipt(root, receipt)
    if (candidate && isInside(root, candidate.path)) remainingCandidates.push(candidate)
  }

  const candidates = new Map<string, CacheCandidate>()
  for (const receipt of options.removedReceipts) {
    const candidate = candidateForReceipt(root, receipt)
    if (!candidate || !isInside(root, candidate.path)) continue
    candidates.set(normalizedPath(candidate.path), candidate)
  }
  for (const reference of options.removedFileReferences ?? []) {
    const candidate = candidateForFileReference(root, reference)
    if (candidate) candidates.set(normalizedPath(candidate.path), candidate)
  }

  const removed: string[] = []
  for (const candidate of candidates.values()) {
    if (remainingCandidates.some(other => candidatesOverlap(other, candidate)) || references.some(reference => pathReferencesCandidate(reference, candidate))) continue
    try {
      await access(candidate.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    await rm(candidate.path, { recursive: candidate.kind === 'directory', force: true })
    removed.push(candidate.path)
    if (candidate.kind === 'directory') await removeEmptyAncestors(root, candidate.path)
  }
  return removed
}

// Exported for focused tests and future diagnostics without exposing the
// receipt-to-path implementation to renderer code.
export function sourceCacheCandidatePath(sourceRoot: string, receipt: PluginInstallReceipt): string | null {
  const root = path.resolve(sourceRoot)
  const candidate = candidateForReceipt(root, receipt)
  return candidate && isInside(root, candidate.path) ? candidate.path : null
}
