import { lstat, mkdir, readFile, readdir, realpath, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'

export const STANDALONE_PLUGIN_DIRECTORY = '.dsh-launcher-standalone-plugins'
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

function safePackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
}

function assertProfileName(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || value.replace(/\.+$/, '').toLowerCase() === 'node_modules') {
    throw new Error('Profile name is invalid.')
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

export function standalonePluginPackageRoot(dshHome: string, packageName: string): string {
  if (!safePackageName(packageName)) throw new Error('Standalone plugin package name is invalid.')
  return path.resolve(dshHome, STANDALONE_PLUGIN_DIRECTORY, ...packageName.split('/'))
}

function referenceDirectory(reference: string, baseDirectory: string): string | null {
  const prefix = reference.startsWith('link:') ? 'link:' : reference.startsWith('file:') ? 'file:' : ''
  const raw = prefix ? reference.slice(prefix.length) : reference
  if (!raw || (!prefix && !path.isAbsolute(raw))) return null
  return path.resolve(baseDirectory, raw)
}

export function isStandalonePluginReference(dshHome: string, packageName: string, reference: string, baseDirectory = dshHome): boolean {
  const directory = referenceDirectory(reference, baseDirectory)
  if (!directory || !safePackageName(packageName)) return false
  return samePath(path.dirname(directory), standalonePluginPackageRoot(dshHome, packageName))
    && /^[a-f0-9]{64}$/i.test(path.basename(directory))
}

/** Only launcher-owned, content-addressed bodies with an explicit marker qualify. */
export async function resolveStandalonePluginDirectory(dshHome: string, packageName: string, reference: string, baseDirectory = dshHome): Promise<string | null> {
  if (!isStandalonePluginReference(dshHome, packageName, reference, baseDirectory)) return null
  const directory = referenceDirectory(reference, baseDirectory)!
  try {
    const canonicalHome = await realpath(dshHome)
    const expected = path.join(canonicalHome, STANDALONE_PLUGIN_DIRECTORY, ...packageName.split('/'), path.basename(directory))
    const canonical = await realpath(directory)
    if (!samePath(canonical, expected) || !(await lstat(directory)).isDirectory()) return null
    const manifestPath = path.join(directory, 'package.json')
    if ((await lstat(manifestPath)).isSymbolicLink()) return null
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; dsh?: { standalone?: { schemaVersion?: unknown } } }
    if (manifest.name !== packageName || manifest.dsh?.standalone?.schemaVersion !== 1) return null
    return directory
  } catch {
    return null
  }
}

export async function findStandalonePluginDirectories(dshHome: string, packageName: string): Promise<string[]> {
  const root = standalonePluginPackageRoot(dshHome, packageName)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const result: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = await resolveStandalonePluginDirectory(dshHome, packageName, path.join(root, entry.name))
    if (directory) result.push(directory)
  }
  return result
}

/** This only materializes the outer package link; private dependencies remain untouched. */
export async function ensureStandalonePluginLink(dshHome: string, profileName: string, packageName: string, directory: string): Promise<void> {
  assertProfileName(profileName)
  const source = await resolveStandalonePluginDirectory(dshHome, packageName, directory)
  if (!source) throw new Error(`Standalone plugin body is missing or invalid: ${packageName}`)
  const profileDirectory = path.resolve(dshHome, 'profiles', profileName)
  const canonicalHome = await realpath(dshHome)
  if (!samePath(await realpath(profileDirectory), path.join(canonicalHome, 'profiles', profileName))) {
    throw new Error('Profile directory must not redirect outside its managed location.')
  }
  const target = path.join(profileDirectory, 'node_modules', ...packageName.split('/'))
  let parent = profileDirectory
  let expectedParent = path.join(canonicalHome, 'profiles', profileName)
  // Check each parent before creating its child to avoid writing through a redirected node_modules.
  for (const segment of ['node_modules', ...packageName.split('/').slice(0, -1)]) {
    parent = path.join(parent, segment)
    expectedParent = path.join(expectedParent, segment)
    await mkdir(parent).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    if (!samePath(await realpath(parent), expectedParent)) throw new Error('Plugin link parent redirects outside its managed location.')
  }
  const existing = await lstat(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`Cannot replace an existing plugin directory: ${packageName}`)
    const previous = await realpath(target).catch(() => null)
    if (previous && samePath(previous, source)) return
    // Unlinking a junction removes the link itself, never its previous body.
    await unlink(target)
  }
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

export async function repairStandalonePluginLinks(dshHome: string, profileName: string, packageNames: readonly string[]): Promise<string[]> {
  assertProfileName(profileName)
  const profileDirectory = path.resolve(dshHome, 'profiles', profileName)
  const manifest = JSON.parse(await readFile(path.join(profileDirectory, 'package.json'), 'utf8')) as Record<string, unknown>
  const repaired: string[] = []
  for (const packageName of packageNames) {
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = manifest[field]
      if (!dependencies || typeof dependencies !== 'object') continue
      const specifier = (dependencies as Record<string, unknown>)[packageName]
      if (typeof specifier !== 'string' || !isStandalonePluginReference(dshHome, packageName, specifier, profileDirectory)) continue
      const directory = await resolveStandalonePluginDirectory(dshHome, packageName, specifier, profileDirectory)
      if (!directory) throw new Error(`Standalone plugin body is missing or invalid: ${packageName}`)
      await ensureStandalonePluginLink(dshHome, profileName, packageName, directory)
      repaired.push(packageName)
      break
    }
  }
  return repaired
}
