import { existsSync } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ManagedPlugin, ProfileState } from '../src/types'
import { readPluginReceipts } from './plugin-receipts'

interface PackageManifest {
  name?: string
  version?: string
  description?: string
  repository?: string | { type?: string; url?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: {
    profile?: { bundles?: string[] }
    bundle?: { patch?: string }
  }
}

const CORE_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/**
 * Packages published under the DeepSeek namespace are supplied by the
 * launcher-managed DSH runtime. Keep this predicate shared with the Profile
 * service so runtime packages declared by older/imported Profiles do not get
 * counted as missing third-party plugins.
 */
export function isDshCorePackage(packageName: string): boolean {
  return /^@deepseek-ai\//.test(packageName) || packageName === 'cordis' || /^@cordisjs\//.test(packageName)
}

function profilePaths(dshHome: string, profileName: string) {
  const profileDir = path.join(dshHome, 'profiles', profileName)
  return { profileDir, manifestPath: path.join(profileDir, 'package.json') }
}

function repositoryUrl(manifest: PackageManifest): string | undefined {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (!raw) return undefined
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

export function repositoryFullNameFromSpecifier(value?: string): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/^git\+/, '')
  const urlMatch = /(?:github\.com[/:]|codeload\.github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(normalized)
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/i, '')}`
  const shortcutMatch = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#.*)?$/i.exec(normalized)
  return shortcutMatch ? `${shortcutMatch[1]}/${shortcutMatch[2]}` : undefined
}

function displayName(packageName: string): string {
  return packageName.split('/').at(-1)?.replace(/^dsh[-_]?/i, '').replace(/[-_]+/g, ' ') || packageName
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw error
  }
}

interface ResolvedDependency {
  manifest: PackageManifest | null
  bundleAvailable: boolean
}

interface ProfilePluginInventory {
  names: Set<string>
  specifiers: Map<string, string>
  bodyDirectories: Map<string, string>
}

async function bundlePatchExists(packageDirectory: string, manifest: PackageManifest | null): Promise<boolean> {
  const patchFile = manifest?.dsh?.bundle?.patch
  if (!patchFile || path.isAbsolute(patchFile)) return false
  const resolved = path.resolve(packageDirectory, patchFile)
  if (resolved !== packageDirectory && !resolved.startsWith(`${packageDirectory}${path.sep}`)) return false
  try {
    await access(resolved)
    return true
  } catch {
    return false
  }
}

async function readResolvedManifest(packageDirectory: string): Promise<ResolvedDependency | null> {
  const manifestPath = path.join(packageDirectory, 'package.json')
  const manifest = await readJson<PackageManifest>(manifestPath)
  if (!manifest) return null
  return {
    manifest,
    bundleAvailable: await bundlePatchExists(packageDirectory, manifest),
  }
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

function dependencyEntries(manifest: PackageManifest): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field]
    if (!value || typeof value !== 'object') continue
    for (const [name, specifier] of Object.entries(value)) {
      if (isSafePackageName(name) && typeof specifier === 'string' && specifier.trim()) {
        entries.push([name, specifier])
      }
    }
  }
  return entries
}

function dependencyNames(manifest: PackageManifest): Set<string> {
  return new Set(dependencyEntries(manifest).map(([name]) => name))
}

function receiptSpecifier(packageName: string, receipt: Awaited<ReturnType<typeof readPluginReceipts>>[number]): string | null {
  if (receipt.source === 'npm') return receipt.version ? `${packageName}@${receipt.version}` : packageName
  if (receipt.source === 'github' || receipt.source === 'archive-subdirectory' || receipt.source === 'release') {
    const repository = repositoryFullNameFromSpecifier(receipt.repository)
    if (repository) return `github:${repository}${receipt.commit ? `#${receipt.commit}` : ''}`
  }
  if (receipt.source === 'local-directory' && receipt.repository.startsWith('file:')) return receipt.repository
  return null
}

function preferSpecifier(existing: string | undefined, candidate: string): string {
  if (!existing || existing.trim() === '*' || existing.trim() === 'latest') return candidate
  if (candidate.startsWith('file:') && !existing.startsWith('file:')) return candidate
  return existing
}

/** Return an exact npm version when a dependency specifier pins one. */
function exactVersionFromSpecifier(packageName: string, specifier?: string): string | null {
  if (typeof specifier !== 'string') return null
  let value = specifier.trim()
  if (!value || value.startsWith('file:') || value.startsWith('github:') || value.startsWith('git+')) return null
  if (value.startsWith(`${packageName}@`)) value = value.slice(packageName.length + 1)
  // npm aliases and ranges are intentionally treated as non-exact. A sibling
  // body may satisfy them, but we must not claim that a different exact body
  // is the requested version when the current link layer is absent.
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value.replace(/^v/, '') : null
}

/**
 * Enumerate the launcher-owned plugin pool once, then let every Profile render
 * that same set with its own activation sequence. The old implementation only
 * looked at the current Profile's dependencies, which made a plugin installed
 * in `web` disappear when `desktop` was selected even though its physical body
 * was already available locally.
 */
async function collectPluginInventory(
  dshHome: string,
  currentProfile: string,
  receipts: Awaited<ReturnType<typeof readPluginReceipts>>,
): Promise<ProfilePluginInventory> {
  const names = new Set<string>()
  const specifiers = new Map<string, string>()
  const bodyDirectories = new Map<string, string>()
  const profilesRoot = path.join(dshHome, 'profiles')
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  const orderedEntries = [...entries].sort((left, right) => {
    if (left.name === currentProfile) return -1
    if (right.name === currentProfile) return 1
    return left.name.localeCompare(right.name)
  })

  for (const entry of orderedEntries) {
    if (!entry.isDirectory() || !isSafeProfileName(entry.name)) continue
    const profileManifest = await readJson<PackageManifest>(path.join(profilesRoot, entry.name, 'package.json'))
    if (!profileManifest) continue
    for (const bundle of profileManifest.dsh?.profile?.bundles ?? []) {
      if (isSafePackageName(bundle)) names.add(bundle)
    }
    for (const [name, specifier] of dependencyEntries(profileManifest)) {
      names.add(name)
      // The current Profile wins, followed by the first deterministic sibling.
      specifiers.set(name, preferSpecifier(specifiers.get(name), specifier))
    }
  }

  for (const receipt of receipts) {
    if (!isSafePackageName(receipt.packageName)) continue
    names.add(receipt.packageName)
    const specifier = receiptSpecifier(receipt.packageName, receipt)
    if (specifier) specifiers.set(receipt.packageName, preferSpecifier(specifiers.get(receipt.packageName), specifier))
  }

  // Shared bodies are laid out as <package>/<version> (and, for older
  // imports, may have one extra staging directory). Walk only package.json
  // candidates and stop descending once a package body is found.
  const bodyRoots = ['.dsh-launcher-plugin-bodies', '.dsh-launcher-pack-bodies']
  const visitBodies = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const manifestPath = path.join(directory, 'package.json')
    const bodyManifest = await readJson<PackageManifest>(manifestPath)
    if (bodyManifest?.name && isSafePackageName(bodyManifest.name)
      && (bodyManifest.dsh?.bundle?.patch || names.has(bodyManifest.name))) {
      if (!isDshCorePackage(bodyManifest.name) || names.has(bodyManifest.name)) {
        names.add(bodyManifest.name)
        if (!bodyDirectories.has(bodyManifest.name)) bodyDirectories.set(bodyManifest.name, directory)
      }
      return
    }
    const children = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || child.name === 'node_modules') continue
      await visitBodies(path.join(directory, child.name), depth + 1)
    }
  }
  for (const rootName of bodyRoots) {
    const root = path.join(dshHome, rootName)
    if (await pathExists(root)) await visitBodies(root, 0)
  }
  for (const [name, directory] of bodyDirectories) {
    specifiers.set(name, preferSpecifier(specifiers.get(name), `file:${directory}`))
  }

  return { names, specifiers, bodyDirectories }
}

/**
 * Profiles keep separate pnpm link layers, while the launcher shares the
 * physical plugin pool. During an import the target Profile may be installed
 * before another Profile's links are materialized. Resolve a manifest from
 * the declared file source or a sibling link as a read-only fallback so every
 * Profile can still display the complete installed plugin pool.
 */
async function resolveDependencyManifest(
  dshHome: string,
  profileName: string,
  profileDir: string,
  packageName: string,
  specifier?: string,
): Promise<ResolvedDependency> {
  const directPackageDirectory = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  const directPath = path.join(directPackageDirectory, 'package.json')
  let manifestPath = directPath
  try {
    manifestPath = await realpath(directPath)
  } catch {
    // Keep the direct path for nodeLinker layouts where realpath is unavailable.
  }
  const direct = await readResolvedManifest(path.dirname(manifestPath))
  if (direct) return direct

  const candidates: string[] = []
  if (typeof specifier === 'string' && specifier.startsWith('file:')) {
    const rawPath = specifier.slice('file:'.length)
    candidates.push(path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(profileDir, rawPath)))
  }

  const profilesRoot = path.join(dshHome, 'profiles')
  const siblingEntries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of siblingEntries) {
    if (!entry.isDirectory() || entry.name === profileName) continue
    candidates.push(path.join(profilesRoot, entry.name, 'node_modules', ...packageName.split('/')))
  }

  // Imported local bodies are copied here by the shared-pool migration. Pick
  // the declared file source first; otherwise any available exact body is
  // enough to render its version and Bundle metadata.
  for (const rootName of ['.dsh-launcher-plugin-bodies', '.dsh-launcher-pack-bodies']) {
    const packageRoot = path.join(dshHome, rootName, ...packageName.split('/'))
    const versions = await readdir(packageRoot, { withFileTypes: true }).catch(() => [])
    for (const version of versions.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      candidates.push(path.join(packageRoot, version.name))
    }
  }

  const resolvedCandidates: ResolvedDependency[] = []
  for (const candidate of candidates) {
    const resolved = await readResolvedManifest(candidate)
    if (resolved) resolvedCandidates.push(resolved)
  }
  const exactVersion = exactVersionFromSpecifier(packageName, specifier)
  if (exactVersion) {
    const exact = resolvedCandidates.find(candidate => candidate.manifest?.version === exactVersion)
    if (exact) return exact
  }
  return resolvedCandidates[0] ?? { manifest: null, bundleAvailable: false }
}

export async function readProfile(dshHome: string, profileName: string, pluginReceiptsPath?: string): Promise<ProfileState> {
  const { profileDir, manifestPath } = profilePaths(dshHome, profileName)
  const manifest = await readJson<PackageManifest>(manifestPath)
  if (!manifest) {
    return {
      initialized: false,
      profileDir,
      manifestPath,
      plugins: [],
      activeBundles: [],
      dependencyCount: 0,
      disabledCount: 0,
    }
  }

  const profileBundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  let receipts: Awaited<ReturnType<typeof readPluginReceipts>> = []
  if (pluginReceiptsPath) {
    try {
      receipts = await readPluginReceipts(pluginReceiptsPath)
    } catch {
      // 安装收据只是来源补充，损坏时不能阻塞 Profile 本身的读取。
    }
  }
  const currentDependencies = dependencyNames(manifest)
  const currentSpecifiers = new Map(dependencyEntries(manifest))
  const inventory = await collectPluginInventory(dshHome, profileName, receipts)
  const allNames = [...new Set([...profileBundles, ...inventory.names])]
  const manifests = new Map<string, ResolvedDependency>()
  await Promise.all([...currentDependencies].map(async packageName => {
    manifests.set(packageName, await resolveDependencyManifest(
      dshHome,
      profileName,
      profileDir,
      packageName,
      currentSpecifiers.get(packageName) ?? inventory.specifiers.get(packageName),
    ))
  }))

  // Resolve shared/sibling-only packages as well. They are intentionally
  // rendered as inactive candidates until this Profile activates them.
  await Promise.all(allNames.filter(name => !manifests.has(name)).map(async packageName => {
    manifests.set(packageName, await resolveDependencyManifest(dshHome, profileName, profileDir, packageName, inventory.specifiers.get(packageName)))
  }))

  const managedComponents: ManagedPlugin[] = allNames
    .map(packageName => {
      const resolvedDependency = manifests.get(packageName)
      const dependencyManifest = resolvedDependency?.manifest
      const enabled = profileBundles.includes(packageName)
      const declaredInProfile = currentDependencies.has(packageName)
      const builtin = isDshCorePackage(packageName)
      const compatible = builtin || enabled || Boolean(resolvedDependency?.bundleAvailable)
      const manifestRepo = repositoryUrl(dependencyManifest ?? {})
      const dependencyRepo = repositoryFullNameFromSpecifier(inventory.specifiers.get(packageName))
      const packageReceipts = receipts.filter(receipt => receipt.packageName === packageName)
      // Receipts are profile-scoped for activation/export, but the physical
      // plugin is shared. If this Profile only inherited the dependency
      // specification, reuse a matching sibling receipt for source metadata.
      const receipt = packageReceipts.find(item => item.profileName === profileName)
        ?? packageReceipts.find(item => !dependencyManifest?.version || !item.version || item.version === dependencyManifest.version)
        ?? packageReceipts[0]
      const receiptRepo = repositoryFullNameFromSpecifier(receipt?.repository)
      const repositoryFullName = dependencyRepo ?? repositoryFullNameFromSpecifier(manifestRepo) ?? receiptRepo
      // Always expose a browser-ready GitHub URL when the source can be normalized.
      // This also fixes manifests that use `github:owner/repo`, `git+https://...`,
      // or a repository URL containing `/tree/<branch>/<subdirectory>`.
      const repo = repositoryFullName
        ? `https://github.com/${repositoryFullName}`
        : manifestRepo
      return {
        packageName,
        displayName: displayName(packageName),
        version: dependencyManifest?.version ?? receipt?.version ?? (builtin ? '随 DSH 提供' : '未知版本'),
        description: dependencyManifest?.description ?? (builtin ? 'DeepSeek Harness 核心组合层' : '未提供插件说明'),
        repository: repo,
        repositoryFullName,
        enabled,
        builtin,
        locked: CORE_BUNDLES.has(packageName),
        compatible,
        order: enabled
          ? profileBundles.indexOf(packageName) + 1
          : null,
        declaredInProfile,
        ...(receipt?.actualSource ? { actualSource: receipt.actualSource } : {}),
        ...(receipt?.packName && receipt.packRepository ? {
          packOrigin: {
            packName: receipt.packName,
            packRepository: receipt.packRepository,
            packCommit: receipt.packCommit ?? null,
            componentId: receipt.componentId ?? packageName,
          },
        } : {}),
      }
    })
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      if (a.order !== null && b.order !== null) return a.order - b.order
      return a.packageName.localeCompare(b.packageName)
    })

  return {
    initialized: true,
    profileDir,
    manifestPath,
    plugins: managedComponents,
    activeBundles: profileBundles,
    dependencyCount: managedComponents.filter(plugin => !plugin.builtin).length,
    disabledCount: managedComponents.filter(plugin => !plugin.builtin && !plugin.enabled).length,
  }
}

export async function updateBundles(
  dshHome: string,
  profileName: string,
  transform: (bundles: string[], manifest: PackageManifest) => string[],
  pluginReceiptsPath?: string,
  prepare?: (manifest: PackageManifest) => Promise<void>,
): Promise<ProfileState> {
  const { profileDir, manifestPath } = profilePaths(dshHome, profileName)
  const manifest = await readJson<PackageManifest>(manifestPath)
  if (!manifest) throw new Error('此配置尚未初始化。请先启动 DSH，或从“资源市场”安装一个 Plugin。')

  await prepare?.(manifest)
  const existing = [...(manifest.dsh?.profile?.bundles ?? [])]
  const next = transform(existing, manifest)
  if (new Set(next).size !== next.length) throw new Error('插件顺序中存在重复项。')
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: next },
  }
  await mkdir(profileDir, { recursive: true })
  const temporaryPath = `${manifestPath}.dsh-launcher.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, manifestPath)
  } catch {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await unlink(temporaryPath).catch(() => undefined)
  }
  return readProfile(dshHome, profileName, pluginReceiptsPath)
}

export async function togglePlugin(
  dshHome: string,
  profileName: string,
  packageName: string,
  enabled: boolean,
  pluginReceiptsPath?: string,
): Promise<ProfileState> {
  // A shared-pool plugin may be visible in this Profile without a local
  // dependency declaration yet. Disabling that already-inactive candidate is
  // a harmless no-op; it must not be reported as a stale/missing plugin.
  if (!enabled) {
    const currentManifest = await readJson<PackageManifest>(profilePaths(dshHome, profileName).manifestPath)
    const declared = currentManifest ? dependencyNames(currentManifest) : new Set<string>()
    const bundles = currentManifest?.dsh?.profile?.bundles ?? []
    if (!declared.has(packageName) && !bundles.includes(packageName)) {
      const receipts = pluginReceiptsPath
        ? await readPluginReceipts(pluginReceiptsPath).catch(() => [])
        : []
      const inventory = await collectPluginInventory(dshHome, profileName, receipts)
      if (inventory.names.has(packageName)) return readProfile(dshHome, profileName, pluginReceiptsPath)
    }
  }
  return updateBundles(dshHome, profileName, (bundles, manifest) => {
    if (CORE_BUNDLES.has(packageName) && !enabled) {
      throw new Error('核心组合层不能停用，否则 DSH 无法正常启动。')
    }
    const available = new Set([...bundles, ...dependencyNames(manifest)])
    if (!available.has(packageName)) throw new Error('插件已不在当前配置中，请刷新后重试。')
    if (enabled && !bundles.includes(packageName)) return [...bundles, packageName]
    if (!enabled) return bundles.filter(name => name !== packageName)
    return bundles
  }, pluginReceiptsPath, async manifest => {
    if (!enabled || dependencyNames(manifest).has(packageName) || CORE_BUNDLES.has(packageName)) return
    const receipts = pluginReceiptsPath
      ? await readPluginReceipts(pluginReceiptsPath).catch(() => [])
      : []
    const inventory = await collectPluginInventory(dshHome, profileName, receipts)
    const specifier = inventory.specifiers.get(packageName)
    if (!specifier) throw new Error('插件来源不可用，请先从资源市场或整合包安装后再启用。')
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [packageName]: specifier }
  })
}

/**
 * Remove a dependency without invoking pnpm. DSH's `plugin remove` normally
 * reifies the whole Profile and can therefore be blocked by an unrelated Git
 * dependency or a missing system git executable. This fallback only changes
 * the target Profile's manifest/activation sequence and its local link; the
 * shared physical plugin store is intentionally left untouched.
 */
export async function removePluginFromProfile(
  dshHome: string,
  profileName: string,
  packageName: string,
): Promise<boolean> {
  if (!isSafeProfileName(profileName)) throw new Error('Profile 名称无效。')
  if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
  if (CORE_BUNDLES.has(packageName)) throw new Error('核心组合层不能卸载，否则 DSH 无法正常启动。')
  const { profileDir, manifestPath } = profilePaths(dshHome, profileName)
  const directPackagePath = path.join(profileDir, 'node_modules', ...packageName.split('/'))
  const manifest = await readJson<PackageManifest>(manifestPath)
  if (!manifest) {
    // Legacy or partially imported Profiles may have a link layer but no
    // package.json. A complete purge must still remove that package link.
    if (!(await pathExists(directPackagePath))) return false
    await removePnpmVirtualPackage(profileDir, packageName, directPackagePath)
    await rm(directPackagePath, { recursive: true, force: true })
    return true
  }
  const nextManifest: PackageManifest = { ...manifest }
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
  let dependencyPresent = false
  for (const field of DEPENDENCY_FIELDS) {
    const current = manifest[field]
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, packageName)) continue
    dependencyPresent = true
    const next = { ...current }
    delete next[packageName]
    if (Object.keys(next).length > 0) nextManifest[field] = next
    else delete nextManifest[field]
  }
  const bundlePresent = bundles.includes(packageName)
  if (!dependencyPresent && !bundlePresent && !(await pathExists(directPackagePath))) return false

  nextManifest.dsh = {
    ...nextManifest.dsh,
    profile: {
      ...nextManifest.dsh?.profile,
      bundles: bundles.filter(name => name !== packageName),
    },
  }
  const temporaryPath = `${manifestPath}.dsh-launcher.remove.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, manifestPath)
  } catch {
    await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
    await unlink(temporaryPath).catch(() => undefined)
  }

  const lockfilePath = path.join(profileDir, 'pnpm-lock.yaml')
  try {
    const lockText = await readFile(lockfilePath, 'utf8')
    const lock = parseYaml(lockText) as Record<string, unknown> | null
    const importers = lock?.importers
    let lockChanged = false
    if (importers && typeof importers === 'object') {
      for (const importer of Object.values(importers as Record<string, unknown>)) {
        if (!importer || typeof importer !== 'object') continue
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
          const entries = (importer as Record<string, unknown>)[field]
          if (!entries || typeof entries !== 'object') continue
          if (Object.prototype.hasOwnProperty.call(entries, packageName)) {
            delete (entries as Record<string, unknown>)[packageName]
            lockChanged = true
          }
        }
      }
    }
    if (lockChanged) {
      const lockTemporaryPath = `${lockfilePath}.dsh-launcher.remove.tmp`
      await writeFile(lockTemporaryPath, stringifyYaml(lock), 'utf8')
      try {
        await rename(lockTemporaryPath, lockfilePath)
      } catch {
        await writeFile(lockfilePath, stringifyYaml(lock), 'utf8')
        await unlink(lockTemporaryPath).catch(() => undefined)
      }
    }
  } catch {
    // The manifest and local link are the source of truth for this fallback.
    // A malformed or missing lockfile must not turn an otherwise successful
    // local uninstall into a failure.
  }

  // pnpm's node linker exposes a symlink into `.pnpm/<key>/node_modules`.
  // Remove the real package directory first so its hard links no longer keep
  // the launcher store alive; the final rm removes the top-level link itself.
  await removePnpmVirtualPackage(profileDir, packageName, directPackagePath)
  await rm(directPackagePath, { recursive: true, force: true })
  return true
}

/**
 * Remove the target package's physical directory from pnpm's per-Profile
 * virtual store. This is deliberately conservative: if the direct link does
 * not resolve inside this Profile's `.pnpm` directory (for example a local
 * source or a legacy hoisted layout), the normal link removal still proceeds.
 */
async function removePnpmVirtualPackage(profileDir: string, packageName: string, directPackagePath: string): Promise<void> {
  let resolved: string
  try {
    resolved = await realpath(directPackagePath)
  } catch {
    return
  }
  // realpath can expand Windows short names (RUNNER~1) while resolving the
  // direct junction. Compare both against the expanded virtual root or
  // path.relative incorrectly reports the real package as outside `.pnpm`.
  const virtualRoot = path.resolve(await realpath(path.join(profileDir, 'node_modules', '.pnpm')).catch(() => path.join(profileDir, 'node_modules', '.pnpm')))
  const relative = path.relative(virtualRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
  const segments = relative.split(path.sep).filter(Boolean)
  const nodeModulesIndex = segments.indexOf('node_modules')
  if (nodeModulesIndex <= 0) return
  const packageSegments = packageName.split('/')
  const resolvedPackageSegments = segments.slice(nodeModulesIndex + 1)
  if (resolvedPackageSegments.join('/') !== packageSegments.join('/')) return
  if (await hasOtherPackageLink(path.join(profileDir, 'node_modules'), resolved, directPackagePath)) return
  // A virtual entry contains the target package plus symlinks to its
  // dependencies. Once no other package points at this target, the whole
  // entry is unreachable and can be removed without touching dependencies.
  await rm(path.join(virtualRoot, segments[0]), { recursive: true, force: true })
  await pruneOrphanedPnpmVirtualEntries(profileDir)
}

async function hasOtherPackageLink(nodeModulesRoot: string, target: string, directLink: string): Promise<boolean> {
  const normalizedTarget = normalizeFsPath(target)
  const normalizedDirectLink = normalizeFsPath(directLink)

  async function visit(directory: string): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      // Only top-level Profile dependencies keep a virtual entry reachable.
      // Do not descend into `.pnpm`: a canonicalization mismatch on Windows
      // (for example short names returned by realpath) could make the target
      // look like a second consumer and silently skip removal.
      if (entry.name === '.pnpm' || entry.name === '.bin') continue
      const candidate = path.join(directory, entry.name)
      const normalizedCandidate = normalizeFsPath(candidate)
      if (normalizedCandidate === normalizedDirectLink || normalizedCandidate === normalizedTarget) continue
      if (entry.isSymbolicLink()) {
        try {
          if (normalizeFsPath(await realpath(candidate)) === normalizedTarget) return true
        } catch {
          // Broken links do not keep a package body in use.
        }
        continue
      }
      if (entry.isDirectory() && !normalizedCandidate.startsWith(`${normalizedTarget}${path.sep}`)) {
        if (await visit(candidate)) return true
      }
    }
    return false
  }

  return visit(nodeModulesRoot)
}

function normalizeFsPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Remove `.pnpm/<key>` entries that are no longer reachable from a Profile's
 * top-level links. pnpm's store prune only sees hard-link counts; leaving an
 * orphaned virtual entry would therefore keep the removed package in the
 * shared store. Unknown/hoisted layouts are left untouched for safety.
 */
async function pruneOrphanedPnpmVirtualEntries(profileDir: string): Promise<void> {
  const nodeModulesRoot = path.join(profileDir, 'node_modules')
  const virtualRoot = path.join(nodeModulesRoot, '.pnpm')
  const canonicalVirtualRoot = path.resolve(await realpath(virtualRoot).catch(() => virtualRoot))
  const entries = await readdir(virtualRoot, { withFileTypes: true }).catch(() => [])
  const packageEntries = entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
  if (packageEntries.length === 0) return

  const reachable = new Set<string>()
  const visited = new Set<string>()
  const markResolved = async (resolvedPath: string): Promise<void> => {
    const relative = path.relative(canonicalVirtualRoot, resolvedPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return
    const segments = relative.split(path.sep).filter(Boolean)
    const nodeModulesIndex = segments.indexOf('node_modules')
    if (nodeModulesIndex <= 0) return
    const key = segments[0]
    if (reachable.has(key)) return
    reachable.add(key)
    const packageNodeModules = path.join(canonicalVirtualRoot, key, 'node_modules')
    const marker = normalizeFsPath(packageNodeModules)
    if (visited.has(marker)) return
    visited.add(marker)
    await visitPackageLinks(packageNodeModules, markResolved)
  }

  await visitPackageLinks(nodeModulesRoot, markResolved, new Set(['.pnpm', '.bin', '.modules.yaml']))
  // pnpm may place public-hoist aliases below `.pnpm/node_modules`.
  const hoistedRoot = path.join(virtualRoot, 'node_modules')
  const hoisted = await readdir(hoistedRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of hoisted) {
    if (!entry.isSymbolicLink()) continue
    try { await markResolved(await realpath(path.join(hoistedRoot, entry.name))) } catch { /* broken link */ }
  }

  // If no top-level link could be resolved, the layout is not recognizable;
  // retaining the entries is safer than deleting a potentially hoisted tree.
  if (reachable.size === 0) return
  for (const entry of packageEntries) {
    if (!reachable.has(entry.name)) await rm(path.join(virtualRoot, entry.name), { recursive: true, force: true })
  }
}

async function visitPackageLinks(
  directory: string,
  onLink: (resolvedPath: string) => Promise<void>,
  skip = new Set<string>(),
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (skip.has(entry.name)) continue
    const candidate = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      try { await onLink(await realpath(candidate)) } catch { /* broken link */ }
      continue
    }
    // Only scoped package containers need a second level of traversal. Do not
    // descend into actual package contents or arbitrary user directories.
    if (entry.isDirectory() && entry.name.startsWith('@')) await visitPackageLinks(candidate, onLink)
  }
}

/**
 * Remove launcher-owned plugin bodies after all Profile link layers have been
 * updated. pnpm's content-addressed store is intentionally not touched: its
 * files are shared by many packages and cannot be mapped safely by package
 * name without pnpm itself. The body pool, however, is package/version scoped.
 */
export async function removeUnusedSharedPluginBodies(dshHome: string, packageName: string): Promise<boolean> {
  if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
  const profilesRoot = path.join(dshHome, 'profiles')
  const profileEntries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of profileEntries) {
    if (!entry.isDirectory() || !isSafeProfileName(entry.name)) continue
    const manifest = await readJson<PackageManifest>(path.join(profilesRoot, entry.name, 'package.json'))
    for (const field of DEPENDENCY_FIELDS) {
      if (manifest?.[field] && Object.prototype.hasOwnProperty.call(manifest[field], packageName)) return false
    }
    if (manifest?.dsh?.profile?.bundles?.includes(packageName)) return false
  }

  let removed = false
  for (const rootName of ['.dsh-launcher-plugin-bodies', '.dsh-launcher-pack-bodies']) {
    const packageRoot = path.join(dshHome, rootName, ...packageName.split('/'))
    if (!existsSync(packageRoot)) continue
    await rm(packageRoot, { recursive: true, force: true })
    removed = true
  }
  return removed
}

export async function reorderPlugins(
  dshHome: string,
  profileName: string,
  packageNames: string[],
  pluginReceiptsPath?: string,
): Promise<ProfileState> {
  return updateBundles(dshHome, profileName, bundles => {
    if (packageNames.length !== bundles.length) throw new Error('新的加载顺序不完整，请刷新后重试。')
    const current = new Set(bundles)
    if (packageNames.some(name => !current.has(name))) throw new Error('新的加载顺序包含未知插件。')
    return packageNames
  }, pluginReceiptsPath)
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export function isSafeProfileName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)
}

export function isSafeRepositoryName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

export function isSafePackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
}
