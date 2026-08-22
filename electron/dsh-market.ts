import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppSettings,
  DshMarketCatalog,
  DshMarketInstalledPlugin,
  DshMarketPlugin,
  DshMarketProgress,
  DshMarketUpdateStatus,
} from '../src/types'
import { DSH_PACKAGE_NAME } from '../src/constants'
import { runCommand, type CommandOptions, type CommandResult, type OutputLevel } from './command'
import { approveAllIgnoredBuilds } from './plugin-install'
import { readProfile } from './profile'
import { resolveNodeExecutable, ensureNodeRuntime, ensurePnpmRuntime, type NodeRuntime, type PnpmRuntime } from './node-runtime'
import { withExecutableDirectoryOnPath } from './process'

const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CORE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])

export interface DshMarketOptions {
  readSettings: () => Promise<AppSettings>
  prepareNodeRuntime: () => Promise<NodeRuntime>
  preparePnpmRuntime: (node: NodeRuntime) => Promise<PnpmRuntime>
  fetchImpl?: typeof fetch
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>
  emitProgress: (progress: DshMarketProgress) => void
  emitOutput: (level: OutputLevel, text: string) => void
  packageStoreRoot?: string
}

interface RegistryPlugin {
  name: string
  owner: string
  url: string
  category: string
  description?: Record<string, string>
  npm?: string | null
  stars?: number | null
  added?: string
  install?: string
}

interface Registry {
  updated?: string
  count?: number
  categories?: Record<string, Record<string, string>>
  plugins?: RegistryPlugin[]
}

interface InstalledRecord {
  name: string
  spec: string
  version: string | null
  enabled: boolean
}

export function parseDshMarketSourceUrl(url: string): { repo: string; subpath: string | null } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(url)
  if (!match || !GITHUB_REPO.test(match[1])) return null
  const subpath = match[2] ?? null
  if (subpath !== null && (!/^[A-Za-z0-9_./-]+$/.test(subpath) || subpath.split('/').some(part => part === '' || part === '.' || part === '..'))) return null
  return { repo: match[1], subpath }
}

export function dshMarketInstallTarget(entry: { url: string; npm?: string | null }): string | null {
  const source = parseDshMarketSourceUrl(entry.url)
  if (!source) return null
  if (typeof entry.npm === 'string' && NPM_NAME.test(entry.npm)) return entry.npm
  return source.subpath === null ? `github:${source.repo}` : `github:${source.repo}#path:/${source.subpath}`
}

function entryIdentities(entry: { name: string; url: string; npm?: string | null }): Set<string> {
  const ids = new Set([entry.name.toLowerCase()])
  if (entry.npm) ids.add(entry.npm.toLowerCase())
  const source = parseDshMarketSourceUrl(entry.url)
  if (source) ids.add(source.subpath === null ? source.repo.toLowerCase() : `${source.repo.toLowerCase()}#path:/${source.subpath.toLowerCase()}`)
  return ids
}

function installedIdentities(name: string, spec: string): Set<string> {
  const ids = new Set([name.toLowerCase()])
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  if (scoped) ids.add(`${scoped[1]}/${scoped[2]}`.toLowerCase())
  const github = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec)
  if (github) {
    ids.add(github[1].toLowerCase())
    if (github[2]) ids.add(`${github[1].toLowerCase()}#path:/${github[2].toLowerCase()}`)
  }
  return ids
}

export function findDshMarketInstalledAlias(entry: { name: string; url: string; npm?: string | null }, installed: Record<string, string>): string | null {
  const entryIds = entryIdentities(entry)
  const source = parseDshMarketSourceUrl(entry.url)
  const entryRepo = source === null ? null : source.subpath === null
    ? source.repo.toLowerCase()
    : `${source.repo.toLowerCase()}#path:/${source.subpath.toLowerCase()}`
  for (const [name, spec] of Object.entries(installed)) {
    const depIds = installedIdentities(name, spec)
    if (entryRepo !== null && /github:/i.test(spec)) {
      if (depIds.has(entryRepo)) return name
      continue
    }
    for (const id of depIds) if (entryIds.has(id)) return name
  }
  return null
}

export function compareDshMarketVersions(left: string | null, right: string | null): number | null {
  if (!left || !right) return null
  const parse = (value: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value)
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') ?? [] } : null
  }
  const a = parse(left); const b = parse(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  return a.pre.join('.') === b.pre.join('.') ? 0 : a.pre.join('.') < b.pre.join('.') ? -1 : 1
}

function sourceRepo(spec: string): string | null {
  const match = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(spec)
  return match?.[1]?.toLowerCase() ?? null
}

async function readGitLockCommit(settings: AppSettings, repository: string): Promise<string | null> {
  try {
    const file = path.join(settings.dshHome, 'profiles', settings.profileName, 'pnpm-lock.yaml')
    const lock = await readFile(file, 'utf8')
    const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return lock.match(new RegExp(`codeload\\.github\\.com\\/${escaped}\\/tar\\.gz\\/([a-f0-9]{40})`, 'i'))?.[1] ?? null
  } catch { return null }
}

function normalizeRegistry(value: Registry): Registry {
  const plugins = Array.isArray(value.plugins) ? value.plugins.filter(item =>
    item && typeof item.name === 'string' && typeof item.owner === 'string' && typeof item.url === 'string' && parseDshMarketSourceUrl(item.url) !== null,
  ) : []
  if (plugins.length === 0) throw new Error('dsh-market 目录为空或格式无效。')
  return { ...value, plugins }
}

export function createDshMarketService(options: DshMarketOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const execute = options.runCommand ?? runCommand
  let catalogCache: Registry | null = null
  let catalogValidator: string | null = null
  let registryLoading: Promise<Registry> | null = null
  let updatesCache: { at: number; data: Record<string, DshMarketUpdateStatus> } | null = null
  let active = false

  const progress = (name: string, phase: DshMarketProgress['phase'], message: string, percent: number | null = null): void => {
    options.emitProgress({ name, phase, message, percent })
  }

  async function loadRegistry(): Promise<Registry> {
    if (registryLoading) return registryLoading

    const request = (async (): Promise<Registry> => {
      const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'dsh-melody-launcher/dsh-market' }
      if (catalogValidator) headers['if-none-match'] = catalogValidator
      let last: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetchImpl(REGISTRY_URL, { headers, signal: AbortSignal.timeout(15_000) })
          if (response.status === 304 && catalogCache) return catalogCache
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = normalizeRegistry(await response.json() as Registry)
          catalogCache = data
          catalogValidator = response.headers.get('etag')
          return data
        } catch (error) { last = error }
      }
      if (catalogCache) return catalogCache
      throw new Error(`dsh-market 目录获取失败：${last instanceof Error ? last.message : String(last)}`)
    })()
    registryLoading = request
    try {
      return await request
    } finally {
      if (registryLoading === request) registryLoading = null
    }
  }

  async function readInstalled(settings: AppSettings): Promise<{ map: Record<string, string>; records: InstalledRecord[] }> {
    const profileDir = path.join(settings.dshHome, 'profiles', settings.profileName)
    let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
    try { manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8')) as typeof manifest } catch { return { map: {}, records: [] } }
    const map = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => !CORE.has(name)))
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    const records = await Promise.all(Object.entries(map).map(async ([name, spec]) => {
      let version: string | null = null
      try {
        const packagePath = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
        version = (JSON.parse(await readFile(packagePath, 'utf8')) as { version?: string }).version ?? null
      } catch { /* package may be a failed/partial install */ }
      return { name, spec: String(spec), version, enabled: bundles.has(name) }
    }))
    return { map, records }
  }

  async function buildCatalog(): Promise<DshMarketCatalog> {
    progress('', 'loading', '正在读取 dsh-market 精选目录')
    const registry = await loadRegistry()
    const settings = await options.readSettings()
    const installed = await readInstalled(settings)
    const plugins: DshMarketPlugin[] = registry.plugins!.map(entry => {
      const alias = findDshMarketInstalledAlias(entry, installed.map)
      const record = alias ? installed.records.find(item => item.name === alias) : undefined
      return {
        name: entry.name,
        owner: entry.owner,
        url: entry.url,
        category: entry.category,
        description: entry.description ?? {},
        npm: entry.npm ?? null,
        stars: entry.stars ?? 0,
        added: entry.added ?? '',
        install: entry.install ?? `dsh plugin --profile ${settings.profileName} add ${dshMarketInstallTarget(entry) ?? ''}`,
        installed: alias !== null,
        enabled: record?.enabled ?? false,
        version: record?.version ?? null,
        updateAvailable: false,
        updateVersion: null,
      }
    })
    return {
      updated: registry.updated ?? '',
      count: registry.count ?? plugins.length,
      categories: registry.categories ?? {},
      plugins,
    }
  }

  async function runPlugin(name: string, args: string[], repository: string): Promise<CommandResult> {
    const settings = await options.readSettings()
    const node = await options.prepareNodeRuntime()
    const pnpm = await options.preparePnpmRuntime(node)
    const executable = resolveNodeExecutable(settings.launchExecutable, node)
    const packageIndex = settings.launchArgs.indexOf(DSH_PACKAGE_NAME)
    const prefix = packageIndex >= 0
      ? settings.launchArgs.slice(0, packageIndex + 1)
      : path.basename(executable).toLowerCase().startsWith('dsh') ? [] : ['--yes', DSH_PACKAGE_NAME]
    const commandArgs = [...prefix, 'plugin', '--profile', settings.profileName, ...args]
    const commandEnv = {
      ...process.env,
      DSH_HOME: settings.dshHome,
      FORCE_COLOR: '0',
      CI: 'true',
      ...(options.packageStoreRoot ? {
        npm_config_store_dir: options.packageStoreRoot,
        NPM_CONFIG_STORE_DIR: options.packageStoreRoot,
        pnpm_config_store_dir: options.packageStoreRoot,
        PNPM_CONFIG_STORE_DIR: options.packageStoreRoot,
      } : {}),
    }
    const dshEnv = withExecutableDirectoryOnPath(pnpm.executable, withExecutableDirectoryOnPath(node.node, commandEnv))
    const handleOutput = (text: string, level: OutputLevel) => {
      options.emitOutput(level, text)
      const match = /downloaded\s+(\d+)\s+of\s+(\d+)/i.exec(text)
      if (match) progress(name, 'downloading', `正在下载 ${match[1]} / ${match[2]} 个包`, Math.min(82, 20 + Math.round(Number(match[1]) / Number(match[2]) * 60)))
      else if (/build|prepare|prepack/i.test(text)) progress(name, 'building', '正在执行插件构建步骤', 84)
      else progress(name, 'downloading', '正在下载插件及依赖', null)
    }
    const runDshPlugin = () => execute(executable, commandArgs, {
      cwd: settings.workspace,
      env: dshEnv,
      onOutput: handleOutput,
    })
    options.emitOutput('info', `dsh-market 插件操作：${args.join(' ')}`)
    progress(name, 'resolving', '正在解析精选插件来源', 12)
    let result = await runDshPlugin()
    // Existing Profiles may still have node_modules linked to the system pnpm
    // store. Move the links to the launcher's shared store before retrying the
    // DSH command; otherwise pnpm refuses to touch the Profile at all.
    if (result.exitCode !== 0 && /ERR_PNPM_UNEXPECTED_STORE/i.test(result.output)) {
      const profilePath = path.join(settings.dshHome, 'profiles', settings.profileName)
      options.emitOutput('info', '检测到 Profile 使用旧 pnpm store，正在迁移依赖后自动重试。')
      progress(name, 'resolving', '正在迁移 Profile 依赖到启动器插件池', 78)
      const migrate = await execute(pnpm.executable, ['install'], {
        cwd: profilePath,
        env: dshEnv,
        onOutput: (text, level) => options.emitOutput(level, text),
      })
      if (migrate.exitCode !== 0) {
        throw new Error(`插件依赖迁移失败（代码 ${migrate.exitCode}）：${migrate.output.slice(-800)}`)
      }
      progress(name, 'resolving', 'Profile 依赖已迁移，正在重试插件操作', 80)
      result = await runDshPlugin()
    }
    // Keep dsh-market's recovery behavior: an ignored build approval or a
    // transient network failure gets exactly one automatic retry.
    if (result.exitCode !== 0 && /ERR_PNPM_IGNORED_BUILDS/i.test(result.output)) {
      const approved = await approveAllIgnoredBuilds(path.join(settings.dshHome, 'profiles', settings.profileName, 'pnpm-workspace.yaml'), result.output)
      if (approved.length > 0) {
        progress(name, 'building', `已允许 ${approved.length} 个构建脚本，正在重试`, 86)
        result = await runDshPlugin()
      }
    } else if (result.exitCode !== 0 && /ERR_PNPM_FETCH_5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(result.output)) {
      progress(name, 'resolving', '网络临时失败，按 dsh-market 规则自动重试一次', 18)
      result = await runDshPlugin()
    }
    return result
  }

  async function mutate(name: string, action: 'install' | 'update' | 'uninstall'): Promise<DshMarketInstalledPlugin[]> {
    if (active) throw new Error('dsh-market 正在执行另一个插件操作，请等待完成。')
    active = true
    try {
      const registry = await loadRegistry()
      const entry = registry.plugins!.find(item => item.name === name || item.npm === name)
      if (!entry) throw new Error('插件不在 dsh-market 精选目录中。')
      const target = dshMarketInstallTarget(entry)
      if (!target) throw new Error('dsh-market 不支持此插件的来源地址。')
      const settings = await options.readSettings()
      const before = await readInstalled(settings)
      const alias = findDshMarketInstalledAlias(entry, before.map)
      if (action === 'install' && alias) throw new Error(`插件已安装（${alias}）。`)
      if (action === 'update' && !alias) throw new Error('插件尚未安装，不能更新。')
      if (action === 'install' && alias === null) {
        const names = [entry.npm, entry.name].filter((value): value is string => typeof value === 'string' && value !== '')
        const collision = names.find(value => before.map[value] !== undefined)
        if (collision !== undefined) throw new Error(`同名冲突：Profile 已安装「${collision}」，请先卸载后再从 dsh-market 安装。`)
      }
      progress(name, action === 'uninstall' ? 'resolving' : 'checking', action === 'uninstall' ? '正在准备卸载' : '正在核对 dsh-market 来源', 8)
      const result = await runPlugin(name, action === 'uninstall' ? ['remove', alias ?? name] : ['add', target], entry.url)
      if (result.exitCode !== 0) throw new Error(`dsh-market 插件操作失败（代码 ${result.exitCode}）：${result.output.slice(-800)}`)
      const after = await readInstalled(settings)
      if (action !== 'uninstall') {
        const installedName = findDshMarketInstalledAlias(entry, after.map)
        if (!installedName) throw new Error('pnpm 已完成，但 dsh-market 未检测到安装结果。')
        const profile = await readProfile(settings.dshHome, settings.profileName)
        const component = profile.plugins.find(item => item.packageName === installedName)
        if (!component || !component.compatible) throw new Error('插件已下载，但没有检测到可加载的 DSH Bundle。')
      }
      updatesCache = null
      progress(name, 'verifying', '正在刷新 dsh-market 安装状态', 94)
      const catalog = await buildCatalog()
      progress(name, 'complete', action === 'install' ? '插件安装完成' : action === 'update' ? '插件更新完成' : '插件已卸载', 100)
      return catalog.plugins.filter(item => item.installed)
    } catch (error) {
      progress(name, 'error', error instanceof Error ? error.message : 'dsh-market 操作失败', null)
      throw error
    } finally { active = false }
  }

  async function checkUpdates(force = false): Promise<Record<string, DshMarketUpdateStatus>> {
    if (!force && updatesCache && Date.now() - updatesCache.at < 30 * 60_000) return updatesCache.data
    const registry = await loadRegistry()
    const settings = await options.readSettings()
    const installed = await readInstalled(settings)
    const result: Record<string, DshMarketUpdateStatus> = {}
    await Promise.all(Object.entries(installed.map).map(async ([name, spec]) => {
      const entry = registry.plugins!.find(item => findDshMarketInstalledAlias(item, { [name]: spec }) === name)
      if (!entry) return
      try {
        if (entry.npm) {
          const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(entry.npm)}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
          const latest = response.ok ? ((await response.json() as { version?: string }).version ?? null) : null
          const current = installed.records.find(item => item.name === name)?.version ?? null
          result[name] = { kind: 'npm', current, latest, updateAvailable: compareDshMarketVersions(current, latest) !== null && (compareDshMarketVersions(current, latest) ?? 0) < 0 }
        } else {
          const repo = sourceRepo(spec)
          const current = repo ? await readGitLockCommit(settings, repo) : null
          const response = repo ? await fetchImpl(`https://api.github.com/repos/${repo}/commits/HEAD`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) }) : null
          const latest = response?.ok ? ((await response.json() as { sha?: string }).sha ?? null) : null
          result[name] = { kind: 'github', current, latest, updateAvailable: current !== null && latest !== null && current !== latest }
        }
      } catch { result[name] = { kind: entry.npm ? 'npm' : 'github', current: null, latest: null, updateAvailable: false } }
    }))
    updatesCache = { at: Date.now(), data: result }
    return result
  }

  function applyUpdateStatuses(catalog: DshMarketCatalog, updates: Record<string, DshMarketUpdateStatus>): DshMarketCatalog {
    return {
      ...catalog,
      plugins: catalog.plugins.map(plugin => {
        const installed = Object.entries(updates).find(([name]) => name === plugin.name || name === plugin.npm)
        const status = installed?.[1]
        return status ? { ...plugin, updateAvailable: status.updateAvailable, updateVersion: status.latest } : plugin
      }),
    }
  }

  return {
    isBusy: () => active,
    load: async (): Promise<DshMarketCatalog> => {
      try {
        const catalog = await buildCatalog()
        // Reading the catalog must stay local and fast. Remote npm/GitHub update
        // checks are intentionally triggered only by the explicit "检查更新"
        // action, otherwise a slow registry can hold the whole Market page open.
        const result = applyUpdateStatuses(catalog, updatesCache?.data ?? {})
        progress('', 'complete', 'DSH Market 目录读取完成', 100)
        return result
      } catch (error) {
        progress('', 'error', error instanceof Error ? error.message : 'DSH Market 目录读取失败', null)
        throw error
      }
    },
    install: (name: string) => mutate(name, 'install'),
    update: (name: string) => mutate(name, 'update'),
    uninstall: (name: string) => mutate(name, 'uninstall'),
    toggle: async (name: string, enabled: boolean) => {
      const settings = await options.readSettings()
      const installed = await readInstalled(settings)
      const entry = (await loadRegistry()).plugins!.find(item => item.name === name || item.npm === name)
      if (!entry) throw new Error('插件不在 dsh-market 精选目录中。')
      const alias = findDshMarketInstalledAlias(entry, installed.map)
      if (!alias) throw new Error('插件尚未安装。')
      const profileDir = path.join(settings.dshHome, 'profiles', settings.profileName)
      const manifestPath = path.join(profileDir, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
      const next = enabled ? [...new Set([...bundles, alias])] : bundles.filter(item => item !== alias)
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
      await mkdir(profileDir, { recursive: true })
      const temporary = `${manifestPath}.dsh-market.tmp`
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      try { await rename(temporary, manifestPath) } catch { await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await unlink(temporary).catch(() => undefined) }
      return (await buildCatalog()).plugins.filter(item => item.installed)
    },
    updates: checkUpdates,
  }
}

export type DshMarketService = ReturnType<typeof createDshMarketService>
