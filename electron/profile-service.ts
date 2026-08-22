import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import type { AppSettings, ProfileState } from '../src/types'
import { readPackRegistry, type PackRecord } from './pack-registry'
import { readPluginReceipts, removePluginReceipt } from './plugin-receipts'
import { readPackManifest } from './pack-manifest-store'
import { readProfile, isSafePackageName, isSafeProfileName } from './profile'

/** Metadata stored next to the DSH package manifest. It is deliberately not
 * used by DSH itself; package.json remains the runtime source of truth. */
export interface ProfileMetadata {
  name: string
  description: string
  dshVersion: string | null
  source: ProfileSource | null
  createdAt: string
  updatedAt: string
  exportedAt?: string | null
}

export type ProfileSource =
  | { kind: 'local'; path?: string }
  | { kind: 'github'; repository: string; branch?: string; commit?: string }
  | { kind: 'import'; format: 'zip' | 'yaml' | 'github'; reference?: string }

export interface ProfileSummary extends ProfileMetadata {
  id: string
  profileDir: string
  initialized: boolean
  pluginCount: number
  enabledPluginCount: number
  disabledPluginCount: number
  missingDependencies: string[]
  hasNodeModules: boolean
  selected: boolean
}

export interface ProfileCreateOptions {
  name: string
  description?: string
  dshVersion?: string | null
  cloneFrom?: string
}

export interface ProfileServiceOptions {
  dshHome: string | (() => Promise<string>)
  readSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  pluginReceiptsPath?: string
  registryPath?: string
  manifestRoot?: string
  /** Shared offline body cache root. Profile deletion must not leave a
   * profile-owned copy behind, but it must never remove the shared pnpm store. */
  packBodiesRoot?: string | (() => Promise<string>)
  isRuntimeRunning?: () => boolean
  /** Optional repair hook used only after the user explicitly confirms a
   * switch into a Profile with missing node_modules links. */
  fillMissingDependencies?: (profileName: string, missing: string[]) => Promise<void>
}

export interface ProfileService {
  list(): Promise<ProfileSummary[]>
  create(input: ProfileCreateOptions): Promise<ProfileSummary>
  clone(sourceName: string, targetName: string, description?: string): Promise<ProfileSummary>
  switch(profileName: string, fillMissing?: boolean | ((missing: string[]) => Promise<void>)): Promise<AppSettings>
  remove(profileName: string): Promise<void>
  metadata(profileName: string): Promise<ProfileSummary>
}

const PROFILE_METADATA_FILENAME = 'profile.yaml'
const PACKAGE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
/** Core bundles are supplied by the selected DSH runtime, but every Profile
 * must keep them in its own activation sequence. */
export const CORE_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

async function homeOf(options: ProfileServiceOptions): Promise<string> {
  return typeof options.dshHome === 'function' ? options.dshHome() : options.dshHome
}

async function packBodiesRootOf(options: ProfileServiceOptions): Promise<string | null> {
  if (!options.packBodiesRoot) return null
  return typeof options.packBodiesRoot === 'function' ? options.packBodiesRoot() : options.packBodiesRoot
}

function metadataPath(profileDir: string): string {
  return path.join(profileDir, PROFILE_METADATA_FILENAME)
}

function profileDirFor(dshHome: string, name: string): string {
  if (!isSafeProfileName(name)) throw new Error('Profile 名称只能包含字母、数字、点、横线或下划线。')
  return path.join(dshHome, 'profiles', name)
}

function isDshCorePackage(packageName: string): boolean {
  return /^@deepseek-ai\//.test(packageName) || packageName === 'cordis' || /^@cordisjs\//.test(packageName)
}

function defaultMetadata(name: string, dshVersion: string | null = null): ProfileMetadata {
  const now = new Date().toISOString()
  return { name, description: '', dshVersion, source: null, createdAt: now, updatedAt: now, exportedAt: null }
}

function normalizeMetadata(raw: unknown, fallbackName: string): ProfileMetadata {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const source = value.source && typeof value.source === 'object' ? value.source as Record<string, unknown> : null
  const sourceKind = source?.kind
  const normalizedSource: ProfileSource | null = sourceKind === 'github' && typeof source?.repository === 'string'
    ? { kind: 'github', repository: source.repository, ...(typeof source.branch === 'string' ? { branch: source.branch } : {}), ...(typeof source.commit === 'string' ? { commit: source.commit } : {}) }
    : sourceKind === 'import' && (source?.format === 'zip' || source?.format === 'yaml' || source?.format === 'github')
      ? { kind: 'import', format: source.format, ...(typeof source.reference === 'string' ? { reference: source.reference } : {}) }
      : sourceKind === 'local'
        ? { kind: 'local', ...(typeof source?.path === 'string' ? { path: source.path } : {}) }
        : null
  const name = typeof value.name === 'string' && isSafeProfileName(value.name) ? value.name : fallbackName
  return {
    name,
    description: typeof value.description === 'string' ? value.description.slice(0, 500) : '',
    dshVersion: typeof value.dshVersion === 'string' ? value.dshVersion : null,
    source: normalizedSource,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : null,
  }
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true } catch { return false }
}

/**
 * Keep every Profile on the same pnpm link strategy.
 *
 * Profile dependencies are local plugin bodies and DSH supplies the peer
 * packages at runtime. If pnpm's default `autoInstallPeers` behavior is left
 * enabled, a local link operation can query npm for an unpublished DSH preview
 * package and fail with `NO_MATCHING_VERSION`.
 */
export async function ensureProfileWorkspaceConfig(profileDir: string): Promise<void> {
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml')
  let raw = ''
  try {
    raw = await readFile(workspacePath, 'utf8')
  } catch {
    // Profiles created by older versions may not have a workspace file yet.
  }

  let workspace: Record<string, unknown>
  try {
    const parsed = raw.trim() === '' ? {} : parse(raw)
    workspace = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    // Replace only this launcher-owned control file. package.json and the lock
    // file remain untouched so pnpm can still report their diagnostics.
    workspace = {}
  }

  const packages = Array.isArray(workspace.packages) && workspace.packages.length > 0
    ? workspace.packages
    : ['.']
  const normalized = {
    ...workspace,
    packages,
    nodeLinker: 'hoisted',
    autoInstallPeers: false,
  }
  const next = stringify(normalized, { lineWidth: 0 })
  if (next !== raw) {
    await mkdir(profileDir, { recursive: true })
    await writeFile(workspacePath, next, 'utf8')
  }
}

/** Restore the runtime-owned core bundles without adding them to dependencies. */
export async function ensureProfileCoreBundles(profileDir: string): Promise<void> {
  const manifestPath = path.join(profileDir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    manifest = parsed as Record<string, unknown>
  } catch {
    return
  }
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' && !Array.isArray(manifest.dsh)
    ? manifest.dsh as Record<string, unknown>
    : {}
  const profile = dsh.profile && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile)
    ? dsh.profile as Record<string, unknown>
    : {}
  const existing = Array.isArray(profile.bundles)
    ? profile.bundles.filter((name): name is string => typeof name === 'string')
    : []
  const bundles = [...CORE_PROFILE_BUNDLES, ...existing.filter(name => !CORE_PROFILE_BUNDLES.includes(name as typeof CORE_PROFILE_BUNDLES[number]))]
  if (JSON.stringify(existing) === JSON.stringify(bundles)) return
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    dsh: { ...dsh, profile: { ...profile, bundles } },
  }, null, 2)}\n`, 'utf8')
}

export async function readProfileMetadata(dshHome: string, profileName: string): Promise<ProfileMetadata> {
  const directory = profileDirFor(dshHome, profileName)
  try {
    return normalizeMetadata(parse(await readFile(metadataPath(directory), 'utf8')), profileName)
  } catch {
    return defaultMetadata(profileName)
  }
}

export async function writeProfileMetadata(dshHome: string, profileName: string, metadata: Partial<ProfileMetadata>): Promise<ProfileMetadata> {
  const directory = profileDirFor(dshHome, profileName)
  const current = await readProfileMetadata(dshHome, profileName)
  const next = normalizeMetadata({ ...current, ...metadata, name: profileName, updatedAt: new Date().toISOString() }, profileName)
  await mkdir(directory, { recursive: true })
  await writeFile(metadataPath(directory), stringify(next, { lineWidth: 0 }), 'utf8')
  return next
}

async function missingDependencies(profile: ProfileState): Promise<string[]> {
  const missing: string[] = []
  for (const plugin of profile.plugins) {
    // A disabled dependency is still declared by package.json and must have a
    // valid link before switching. Otherwise enabling it later would produce a
    // Profile that only fails after the user has already switched environments.
    if (plugin.builtin) continue
    const manifest = path.join(profile.profileDir, 'node_modules', ...plugin.packageName.split('/'), 'package.json')
    if (!await exists(manifest)) missing.push(plugin.packageName)
  }
  return missing
}

/**
 * A dependency can be absent from this Profile's link layer while its actual
 * package is already available locally through another Profile or the shared
 * offline body pool. Such packages should be linked automatically instead of
 * being presented as a missing dependency to the user.
 */
async function locallyAvailableDependencies(dshHome: string, profileName: string, packageNames: string[]): Promise<string[]> {
  const wanted = new Set(packageNames)
  const available = new Set<string>()
  const profilesRoot = path.join(dshHome, 'profiles')
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === profileName || !isSafeProfileName(entry.name)) continue
    const siblingDir = path.join(profilesRoot, entry.name)
    let manifest: { dependencies?: Record<string, unknown> } | null = null
    try {
      manifest = JSON.parse(await readFile(path.join(siblingDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
    } catch {
      // A sibling without a manifest cannot provide a reusable dependency spec.
    }
    for (const packageName of wanted) {
      if (available.has(packageName)) continue
      const directNodeModule = path.join(siblingDir, 'node_modules', ...packageName.split('/'), 'package.json')
      if (await exists(directNodeModule)) {
        available.add(packageName)
        continue
      }
      const specifier = manifest?.dependencies?.[packageName]
      if (typeof specifier === 'string' && specifier.startsWith('file:')) {
        const rawPath = specifier.slice('file:'.length)
        const sourcePath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(siblingDir, rawPath))
        if (await exists(path.join(sourcePath, 'package.json'))) available.add(packageName)
      }
    }
  }

  // Shared imported bodies are laid out as <package-name>/<version>. Seeing
  // the package directory is enough: the installer will choose the exact
  // version declared by the Profile when it materializes the link layer.
  for (const packageName of wanted) {
    if (available.has(packageName)) continue
    for (const rootName of ['.dsh-launcher-plugin-bodies', '.dsh-launcher-pack-bodies']) {
      if (await exists(path.join(dshHome, rootName, ...packageName.split('/')))) {
        available.add(packageName)
        break
      }
    }
  }
  return [...available]
}

async function summaryFor(options: ProfileServiceOptions, name: string, selected: boolean): Promise<ProfileSummary> {
  const dshHome = await homeOf(options)
  const profileDir = profileDirFor(dshHome, name)
  const metadata = await readProfileMetadata(dshHome, name)
  const profile = await readProfile(dshHome, name, options.pluginReceiptsPath)
  const missingRaw = profile.initialized ? await missingDependencies(profile) : []
  const locallyAvailable = await locallyAvailableDependencies(dshHome, name, missingRaw)
  const missing = missingRaw.filter(packageName => !locallyAvailable.includes(packageName))
  return {
    ...metadata,
    id: name,
    profileDir,
    initialized: profile.initialized,
    pluginCount: profile.plugins.filter(plugin => !plugin.builtin).length,
    enabledPluginCount: profile.plugins.filter(plugin => !plugin.builtin && plugin.enabled).length,
    disabledPluginCount: profile.disabledCount,
    missingDependencies: missing,
    hasNodeModules: await exists(path.join(profileDir, 'node_modules')),
    selected,
  }
}

export async function listProfiles(options: ProfileServiceOptions): Promise<ProfileSummary[]> {
  const dshHome = await homeOf(options)
  const current = await options.readSettings()
  const root = path.join(dshHome, 'profiles')
  await mkdir(root, { recursive: true })
  const entries = await readdir(root, { withFileTypes: true })
  const names = entries.filter(entry => entry.isDirectory() && isSafeProfileName(entry.name)).map(entry => entry.name)
  if (!names.includes(current.profileName)) names.push(current.profileName)
  // Existing installations predate profile.yaml. Materialize metadata lazily
  // while scanning so every visible Profile is self-contained afterwards.
  for (const name of names) {
    const directory = profileDirFor(dshHome, name)
    if (!await exists(metadataPath(directory))) await writeProfileMetadata(dshHome, name, { dshVersion: current.dshVersion ?? null, source: { kind: 'local' } })
  }
  const scoped = { ...options, dshHome }
  return Promise.all(names.sort((a, b) => a.localeCompare(b)).map(name => summaryFor(scoped, name, name === current.profileName)))
}

/**
 * Consolidate legacy per-pack offline bodies into one launcher-owned pool.
 * Profile package manifests are rewritten to point at that pool, while each
 * Profile keeps its own package.json and node_modules link layer.
 *
 * The migration is deliberately copy-based: existing links may still point at
 * the old cache until the next Profile install, so removing the old directory
 * here would turn a harmless upgrade into a broken runtime.
 */
export async function consolidatePluginPool(dshHome: string): Promise<{ profiles: number; dependencies: number; bodies: number }> {
  const legacyRoot = path.join(dshHome, '.dsh-launcher-pack-bodies')
  const sharedRoot = path.join(dshHome, '.dsh-launcher-plugin-bodies')
  const bodySources = new Map<string, string>()
  const sourceMap = new Map<string, string>()
  let bodies = 0

  async function visit(directory: string): Promise<void> {
    const manifestPath = path.join(directory, 'package.json')
    if (await exists(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (typeof manifest.name === 'string' && isSafePackageName(manifest.name)) {
          const version = typeof manifest.version === 'string' && manifest.version.trim()
            ? manifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
            : 'local'
          const destination = path.join(sharedRoot, ...manifest.name.split('/'), version)
          if (!await exists(destination)) {
            await mkdir(path.dirname(destination), { recursive: true })
            await cp(directory, destination, { recursive: true })
          }
          const source = path.resolve(directory)
          sourceMap.set(source, destination)
          if (!bodySources.has(manifest.name)) bodySources.set(manifest.name, destination)
          bodies += 1
        }
      } catch {
        // Invalid cache entries are ignored; pnpm/installer will report them
        // if a Profile still references one.
      }
      return
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'node_modules') await visit(path.join(directory, entry.name))
    }
  }

  if (await exists(legacyRoot)) await visit(legacyRoot)
  const profilesRoot = path.join(dshHome, 'profiles')
  const profileEntries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  const profileData: Array<{ directory: string; manifestPath: string; manifest: { dependencies?: Record<string, unknown>; [key: string]: unknown } }> = []
  const sharedSpecs = new Map<string, string>()

  // First normalize the sources already declared by every Profile and build
  // the union of installed plugin specifications. This makes a newly-created
  // Profile see the same physical plugin pool while keeping bundles/order local.
  for (const entry of profileEntries) {
    if (!entry.isDirectory() || !isSafeProfileName(entry.name)) continue
    const directory = path.join(profilesRoot, entry.name)
    await ensureProfileWorkspaceConfig(directory)
    await ensureProfileCoreBundles(directory)
    const manifestPath = path.join(directory, 'package.json')
    let manifest: { dependencies?: Record<string, unknown>; [key: string]: unknown }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest
    } catch {
      continue
    }
    profileData.push({ directory, manifestPath, manifest })
    const currentDependencies = manifest.dependencies && typeof manifest.dependencies === 'object'
      ? manifest.dependencies as Record<string, unknown>
      : {}
    for (const [packageName, rawSpecifier] of Object.entries(currentDependencies)) {
      if (isDshCorePackage(packageName) || !isSafePackageName(packageName) || typeof rawSpecifier !== 'string') continue
      let normalized = rawSpecifier
      if (rawSpecifier.trim() === '*') {
        const sharedBody = bodySources.get(packageName)
        if (sharedBody) normalized = `file:${sharedBody}`
      } else if (rawSpecifier.startsWith('file:')) {
        const rawPath = rawSpecifier.slice('file:'.length)
        const sourcePath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(directory, rawPath))
        const sharedBody = sourceMap.get(sourcePath)
        if (sharedBody) normalized = `file:${sharedBody}`
      }
      const previous = sharedSpecs.get(packageName)
      if (!previous || previous === '*' || (normalized.startsWith('file:') && !previous.startsWith('file:'))) sharedSpecs.set(packageName, normalized)
    }
  }

  let profiles = 0
  let dependencies = 0
  for (const { directory: profileDirectory, manifestPath, manifest } of profileData) {
    const currentDependencies = manifest.dependencies && typeof manifest.dependencies === 'object'
      ? manifest.dependencies as Record<string, unknown>
      : {}
    const nextDependencies = { ...currentDependencies }
    let changed = false
    for (const [packageName, rawSpecifier] of Object.entries(currentDependencies)) {
      if (isDshCorePackage(packageName) || !isSafePackageName(packageName) || typeof rawSpecifier !== 'string') continue
      let normalized = rawSpecifier
      if (rawSpecifier.trim() === '*') {
        const shared = bodySources.get(packageName)
        if (shared) normalized = `file:${shared}`
      } else if (rawSpecifier.startsWith('file:')) {
        const rawPath = rawSpecifier.slice('file:'.length)
        const sourcePath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(profileDirectory, rawPath))
        const shared = sourceMap.get(sourcePath)
        if (shared) normalized = `file:${shared}`
      }
      if (normalized !== rawSpecifier) {
        nextDependencies[packageName] = normalized
        changed = true
        dependencies += 1
      }
    }
    for (const [packageName, sharedSpecifier] of sharedSpecs) {
      if (nextDependencies[packageName] === undefined) {
        nextDependencies[packageName] = sharedSpecifier
        changed = true
        dependencies += 1
      } else if (nextDependencies[packageName] === '*' && sharedSpecifier !== '*') {
        nextDependencies[packageName] = sharedSpecifier
        changed = true
        dependencies += 1
      }
    }
    if (changed) {
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, dependencies: nextDependencies }, null, 2)}\n`, 'utf8')
      profiles += 1
    }
  }
  return { profiles, dependencies, bodies }
}

export async function createProfile(options: ProfileServiceOptions, input: ProfileCreateOptions): Promise<ProfileSummary> {
  const dshHome = await homeOf(options)
  const scoped = { ...options, dshHome }
  const directory = profileDirFor(dshHome, input.name)
  if (await exists(directory)) throw new Error(`Profile「${input.name}」已存在。`)
  await mkdir(directory, { recursive: true })
  if (input.cloneFrom) {
    const source = profileDirFor(dshHome, input.cloneFrom)
    if (!await exists(source)) throw new Error(`源 Profile「${input.cloneFrom}」不存在。`)
    for (const file of PACKAGE_FILES) {
      if (await exists(path.join(source, file))) await cp(path.join(source, file), path.join(directory, file))
    }
  } else {
    // A new Profile starts with no active bundles, but it participates in the
    // same installed-plugin pool. Copy only non-core dependency specs from the
    // currently selected Profile; links are materialized lazily on switch.
    let dependencies: Record<string, string> = {}
    try {
      const current = await options.readSettings()
      const currentManifest = JSON.parse(await readFile(path.join(dshHome, 'profiles', current.profileName, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
      dependencies = Object.fromEntries(Object.entries(currentManifest.dependencies ?? {}).filter(([name, spec]) =>
        isSafePackageName(name) && !isDshCorePackage(name) && typeof spec === 'string',
      )) as Record<string, string>
    } catch {
      // An empty pool is valid before the first plugin is installed.
    }
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${input.name}`, private: true, dependencies, dsh: { profile: { bundles: [] } } }, null, 2)}\n`, 'utf8')
  }
  // Clones may carry a legacy workspace file as well; normalize both creation
  // paths before the first switch or install can invoke pnpm.
  await ensureProfileWorkspaceConfig(directory)
  await ensureProfileCoreBundles(directory)
  const sourceMetadata = input.cloneFrom ? await readProfileMetadata(dshHome, input.cloneFrom) : null
  await writeProfileMetadata(dshHome, input.name, {
    description: input.description ?? sourceMetadata?.description ?? '',
    dshVersion: input.dshVersion ?? sourceMetadata?.dshVersion ?? null,
    source: { kind: 'local' },
  })
  return summaryFor(scoped, input.name, false)
}

export async function cloneProfile(options: ProfileServiceOptions, sourceName: string, targetName: string, description?: string): Promise<ProfileSummary> {
  return createProfile(options, { name: targetName, cloneFrom: sourceName, description })
}

export async function switchProfile(options: ProfileServiceOptions, profileName: string, fillMissing?: boolean | ((missing: string[]) => Promise<void>)): Promise<AppSettings> {
  if (options.isRuntimeRunning?.()) throw new Error('请先停止 DSH，再切换 Profile。')
  const dshHome = await homeOf(options)
  const targetDir = profileDirFor(dshHome, profileName)
  if (!await exists(targetDir)) throw new Error(`Profile「${profileName}」不存在。`)
  const profile = await readProfile(dshHome, profileName, options.pluginReceiptsPath)
  const initialMissing = profile.initialized ? await missingDependencies(profile) : []
  // Materialize links for packages that already exist in another Profile or
  // the shared body pool without requiring a second confirmation dialog.
  const locallyAvailable = await locallyAvailableDependencies(dshHome, profileName, initialMissing)
  if (locallyAvailable.length > 0 && options.fillMissingDependencies) {
    await options.fillMissingDependencies(profileName, locallyAvailable).catch(() => undefined)
  }
  const missing = profile.initialized ? await missingDependencies(await readProfile(dshHome, profileName, options.pluginReceiptsPath)) : []
  if (missing.length > 0) {
    const repair = typeof fillMissing === 'function'
      ? fillMissing
      : fillMissing === true && options.fillMissingDependencies
        ? (items: string[]) => options.fillMissingDependencies!(profileName, items)
        : null
    if (!repair) throw new Error(`Profile「${profileName}」缺少插件：${missing.join('、')}。确认补齐依赖后再切换。`)
    await repair(missing)
    const afterRepair = await missingDependencies(await readProfile(dshHome, profileName, options.pluginReceiptsPath))
    if (afterRepair.length > 0) throw new Error(`Profile「${profileName}」仍缺少插件：${afterRepair.join('、')}`)
  }
  const settings = await options.readSettings()
  const metadata = await readProfileMetadata(dshHome, profileName)
  // DSH version is part of the Profile transfer metadata. Switching the
  // Profile therefore also switches the selected launcher-managed runtime;
  // null intentionally restores the automatic version strategy.
  return options.saveSettings({ ...settings, profileName, dshVersion: metadata.dshVersion })
}

export async function deleteProfile(options: ProfileServiceOptions, profileName: string): Promise<void> {
  if (options.isRuntimeRunning?.()) throw new Error('请先停止 DSH，再删除 Profile。')
  const current = await options.readSettings()
  if (current.profileName === profileName) throw new Error('当前 Profile 不能删除。')
  const dshHome = await homeOf(options)
  await rm(profileDirFor(dshHome, profileName), { recursive: true, force: true })
  // Receipts are profile-scoped source metadata. Removing them prevents a
  // later export from accidentally attributing another Profile's repository
  // to this one. The physical pnpm store is deliberately untouched.
  if (options.pluginReceiptsPath) {
    const receipts = await readPluginReceipts(options.pluginReceiptsPath).catch(() => [])
    for (const receipt of receipts.filter(item => item.profileName === profileName)) {
      await removePluginReceipt(options.pluginReceiptsPath, profileName, receipt.packageName)
    }
  }
  const packBodiesRoot = await packBodiesRootOf(options)
  if (packBodiesRoot) {
    await rm(path.join(packBodiesRoot, profileName), { recursive: true, force: true }).catch(() => undefined)
  }
}

function migratedPackageManifest(profileName: string, record: PackRecord, base?: Record<string, unknown>): Record<string, unknown> {
  const dependencies: Record<string, string> = {}
  const bundles: string[] = []
  const baseDependencies = base?.dependencies && typeof base.dependencies === 'object' ? base.dependencies as Record<string, unknown> : {}
  const baseBundles = base?.dsh && typeof base.dsh === 'object' && (base.dsh as Record<string, unknown>).profile && typeof (base.dsh as Record<string, unknown>).profile === 'object'
    ? ((base.dsh as Record<string, unknown>).profile as Record<string, unknown>).bundles
    : []
  // Keep the launcher/DSH core layer from the existing Profile. User plugin
  // dependencies are rebuilt from the legacy pack record below.
  for (const [packageName, specifier] of Object.entries(baseDependencies)) {
    if (!isSafePackageName(packageName) || (!/^@deepseek-ai\//.test(packageName) && packageName !== 'cordis' && !/^@cordisjs\//.test(packageName))) continue
    if (typeof specifier === 'string') dependencies[packageName] = specifier
  }
  if (Array.isArray(baseBundles)) {
    for (const packageName of baseBundles) {
      if (typeof packageName === 'string' && dependencies[packageName]) bundles.push(packageName)
    }
  }
  for (const plugin of record.plugins) {
    if (!isSafeProfileName(profileName)) continue
    if (!isSafePackageName(plugin.packageName)) continue
    // Legacy records did not always persist a version. Prefer the exact source
    // already used by the current Profile (especially file: pack bodies) so
    // migrated Profiles share the same physical plugin pool instead of
    // falling back to an offline registry lookup for `*`.
    const inheritedSpecifier = baseDependencies[plugin.packageName]
    dependencies[plugin.packageName] = plugin.version?.trim() || (typeof inheritedSpecifier === 'string' ? inheritedSpecifier : '*')
    if (plugin.enabled) bundles.push(plugin.packageName)
  }
  return {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }
}

/** One-time migration. It only creates metadata and backups legacy registry
 * files; it intentionally does not perform network installs during startup. */
export async function migrateLegacyPacks(options: ProfileServiceOptions): Promise<{ migrated: number; backupPath: string | null }> {
  if (!options.registryPath && !options.manifestRoot) return { migrated: 0, backupPath: null }
  let records = options.registryPath ? await readPackRegistry(options.registryPath) : []
  // Some older builds persisted only pack-manifests/*.yaml. Treat those files
  // as the same legacy source and convert them before backing the directory up.
  if (records.length === 0 && options.manifestRoot && await exists(options.manifestRoot)) {
    const entries = await readdir(options.manifestRoot, { withFileTypes: true }).catch(() => [])
    const manifestRecords: PackRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
      const id = entry.name.slice(0, -'.yaml'.length)
      if (!isSafeProfileName(id)) continue
      const manifest = await readPackManifest(options.manifestRoot, id).catch(() => null)
      if (!manifest) continue
      manifestRecords.push({
        id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        ...(manifest.dshVersion ? { dshVersion: manifest.dshVersion } : {}),
        source: 'manifest',
        installedAt: new Date(0).toISOString(),
        updatedAt: new Date().toISOString(),
        state: 'complete',
        plugins: manifest.plugins.map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled !== false, version: plugin.version })),
        ...(manifest.skills?.length ? { skills: manifest.skills.map(skill => ({ name: skill.name, format: skill.format, enabled: true })) } : {}),
        ...(manifest.presets?.length ? { presets: manifest.presets.map(preset => ({ name: preset.name, enabled: true })) } : {}),
      })
    }
    records = manifestRecords
  }
  if (records.length === 0) return { migrated: 0, backupPath: null }
  let migrated = 0
  const settings = await options.readSettings()
  let baseManifest: Record<string, unknown> | undefined
  try {
    const basePath = path.join(await homeOf(options), 'profiles', settings.profileName, 'package.json')
    baseManifest = JSON.parse(await readFile(basePath, 'utf8')) as Record<string, unknown>
  } catch {
    baseManifest = undefined
  }
  const activeRecord = typeof settings.activePackId === 'string'
    ? records.find(record => record.id === settings.activePackId) ?? null
    : null
  let activeMappedToCurrent = false
  for (const record of records) {
    // The active pack historically described the already-installed Profile.
    // Keep that physical directory and only attach metadata to it instead of
    // creating a second copy that would split the user's runtime state.
    const profileName = activeRecord?.id === record.id ? settings.profileName : record.id
    if (!isSafeProfileName(profileName)) continue
    const dshHome = await homeOf(options)
    const directory = profileDirFor(dshHome, profileName)
    if (!await exists(directory)) await mkdir(directory, { recursive: true })
    if (!await exists(path.join(directory, 'package.json'))) {
      await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(migratedPackageManifest(profileName, record, baseManifest), null, 2)}\n`, 'utf8')
    }
    await ensureProfileWorkspaceConfig(directory)
    await ensureProfileCoreBundles(directory)
    await writeProfileMetadata(dshHome, profileName, {
      description: record.description,
      dshVersion: record.dshVersion ?? null,
      source: record.source === 'zip' || record.source === 'manifest' ? { kind: 'import', format: record.source === 'zip' ? 'zip' : 'yaml' } : { kind: 'local' },
    })
    if (activeRecord?.id === record.id) activeMappedToCurrent = true
    migrated += 1
  }
  if (activeMappedToCurrent || (typeof settings.activePackId === 'string' && isSafeProfileName(settings.activePackId))) {
    // The old active pack is now the selected Profile. Clear the legacy flag
    // so future runtime decisions only consult settings.profileName. When the
    // active pack mapped to the existing Profile, preserve that Profile name.
    await options.saveSettings({ ...settings, profileName: activeMappedToCurrent ? settings.profileName : settings.activePackId!, activePackId: null })
  }
  const backupPath = options.registryPath ? `${options.registryPath}.legacy.bak` : null
  if (options.registryPath && backupPath && await exists(options.registryPath) && !await exists(backupPath)) await rename(options.registryPath, backupPath)
  if (options.manifestRoot && await exists(options.manifestRoot)) {
    const backupManifestRoot = `${options.manifestRoot}.legacy.bak`
    if (!await exists(backupManifestRoot)) await rename(options.manifestRoot, backupManifestRoot)
  }
  return { migrated, backupPath }
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  return {
    list: () => listProfiles(options),
    create: input => createProfile(options, input),
    clone: (sourceName, targetName, description) => cloneProfile(options, sourceName, targetName, description),
    switch: (profileName, fillMissing) => switchProfile(options, profileName, fillMissing),
    remove: profileName => deleteProfile(options, profileName),
    async metadata(profileName) {
      const all = await listProfiles(options)
      const result = all.find(item => item.id === profileName)
      if (!result) throw new Error(`Profile「${profileName}」不存在。`)
      return result
    },
  }
}

export const PROFILE_METADATA_FILE = PROFILE_METADATA_FILENAME
