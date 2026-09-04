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
import { approveAllIgnoredBuilds, approveBuildKeys, gitPrepareBuildKeys } from './plugin-install'
import {
  buildNetworkEnvironment,
  NPM_OFFICIAL_REGISTRY,
} from './proxy'
import { readProfile } from './profile'
import { resolveNodeExecutable, ensureNodeRuntime, ensurePnpmRuntime, type NodeRuntime, type PnpmRuntime } from './node-runtime'
import { findGitExecutable, gitUnavailableMessage, isGitHostedSpecifier, isGitUnavailableOutput, withExecutableDirectoryOnPath, withGitOnPath } from './process'
import { isNpmVersionUnavailableError } from './npm-install'

const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const CORE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'])
const MARKET_COMMAND_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** 单次 dsh-market 插件操作的整体上限：防止 GitHub 卡死时无限占用 Profile 锁、界面永远转圈。 */
const DSH_MARKET_COMMAND_TIMEOUT_MS = 30 * 60_000

export interface DshMarketOptions {
  readSettings: () => Promise<AppSettings>
  prepareNodeRuntime: () => Promise<NodeRuntime>
  preparePnpmRuntime: (node: NodeRuntime) => Promise<PnpmRuntime>
  fetchImpl?: typeof fetch
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>
  emitProgress: (progress: DshMarketProgress) => void
  emitOutput: (level: OutputLevel, text: string) => void
  packageStoreRoot?: string
  /** 安装成功后同步所有 Profile 的共享插件依赖声明。 */
  syncProfilePool?: (dshHome: string) => Promise<void>
  /** Local Profile/shared-pool uninstall path; avoids pnpm/network resolution. */
  removePluginLocally?: (packageName: string, profileName?: string, options?: { purgeStore?: boolean }) => Promise<unknown>
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

export function parseDshMarketSourceUrl(url: string): { repo: string; subpath: string | null; branch: string | null } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/([^/]+)\/(.+?))?\/?$/.exec(url)
  if (!match || !GITHUB_REPO.test(match[1])) return null
  const branch = match[2] ?? null
  const subpath = match[3] ?? null
  if (subpath !== null && (!/^[A-Za-z0-9_./-]+$/.test(subpath) || subpath.split('/').some(part => part === '' || part === '.' || part === '..'))) return null
  return { repo: match[1], subpath, branch }
}

export function dshMarketInstallTarget(entry: { url: string; npm?: string | null }, exactVersion?: string | null): string | null {
  const source = parseDshMarketSourceUrl(entry.url)
  if (!source) return null
  if (typeof entry.npm === 'string' && NPM_NAME.test(entry.npm)) {
    if (exactVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(exactVersion)) throw new Error('dsh-market 精确版本格式无效。')
    return exactVersion ? `${entry.npm}@${exactVersion}` : entry.npm
  }
  return source.subpath === null ? `github:${source.repo}` : `github:${source.repo}#path:/${source.subpath}`
}

function entryIdentities(entry: { name: string; url: string; npm?: string | null }, npmAlias?: string | null): Set<string> {
  const ids = new Set([entry.name.toLowerCase()])
  const alias = npmAlias ?? entry.npm
  if (alias) ids.add(alias.toLowerCase())
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

export function findDshMarketInstalledAlias(entry: { name: string; url: string; npm?: string | null }, installed: Record<string, string>, npmAlias?: string | null): string | null {
  const entryIds = entryIdentities(entry, npmAlias)
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

/** 从 pnpm 的 `Progress:` 行解析百分比（CI 模式实际输出，`downloaded of Y` 风格不常见）。 */
function pnpmProgressPercent(text: string): number | null {
  const line = /Progress:\s*(.+)/i.exec(text)?.[1]
  if (!line) return null
  const read = (key: string): number => {
    const match = new RegExp(`\\b${key}\\s+(\\d+)`, 'i').exec(line)
    return match ? Number(match[1]) : 0
  }
  const resolved = read('resolved')
  if (resolved <= 0) return null
  const done = read('downloaded') + read('reused') + read('added')
  return Math.min(82, 20 + Math.round(done / resolved * 62))
}

function describeMarketFailure(entry: RegistryPlugin, exitCode: number, output: string): string {
  if (/workspace\s*[::*]|\bworkspace:\*\b|WORKSPACE_PKG_NOT_FOUND/i.test(output)) {
    return `安装「${entry.name}」失败：该插件是 monorepo 的 workspace 内部包，无法作为独立 git 依赖安装，自动改用 npm 源也失败。请确认该插件已发布到 npm 后重试。`
  }
  if (/ERR_PNPM_FETCH_5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|getaddrinfo|socket hang up|GIT_DEP_PREPARE_NOT_ALLOWED/i.test(output)) {
    return `安装「${entry.name}」失败（代码 ${exitCode}）：直连 GitHub/npm 受限或构建被拒。请在设置页「网络」中配置代理或 GitHub 镜像后重试。\n${output.slice(-500)}`
  }
  return `dsh-market 插件操作失败（代码 ${exitCode}）：${output.slice(-800)}`
}

export function createDshMarketService(options: DshMarketOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const execute = options.runCommand ?? runCommand
  let catalogCache: Registry | null = null
  let catalogValidator: string | null = null
  let registryLoading: Promise<Registry> | null = null
  let updatesCache: { at: number; data: Record<string, DshMarketUpdateStatus> } | null = null
  let active = false
  /** 「注册表条目名 → 实际 npm 包名」映射：git workspace 聚合包回退安装后登记，
      让目录/身份匹配（已安装、启停等）都能认识这条 npm 来源。 */
  const npmAliasByName = new Map<string, string>()

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

  async function buildCatalog(profileNameOverride?: string): Promise<DshMarketCatalog> {
    progress('', 'loading', '正在读取 dsh-market 精选目录')
    const registry = await loadRegistry()
    const loadedSettings = await options.readSettings()
    const settings = profileNameOverride ? { ...loadedSettings, profileName: profileNameOverride } : loadedSettings
    const installed = await readInstalled(settings)
    const plugins: DshMarketPlugin[] = registry.plugins!.map(entry => {
      const npm = npmAliasByName.get(entry.name) ?? entry.npm ?? null
      const alias = findDshMarketInstalledAlias(entry, installed.map, npm)
      const record = alias ? installed.records.find(item => item.name === alias) : undefined
      return {
        name: entry.name,
        owner: entry.owner,
        url: entry.url,
        category: entry.category,
        description: entry.description ?? {},
        npm,
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

  async function runPlugin(
    name: string,
    args: string[],
    repository: string,
    profileOverride?: string,
    registryOverride?: string,
  ): Promise<CommandResult> {
    const settings = await options.readSettings()
    const targetProfile = profileOverride ?? settings.profileName
    const node = await options.prepareNodeRuntime()
    const pnpm = await options.preparePnpmRuntime(node)
    const executable = resolveNodeExecutable(settings.launchExecutable, node)
    const packageIndex = settings.launchArgs.indexOf(DSH_PACKAGE_NAME)
    const prefix = packageIndex >= 0
      ? settings.launchArgs.slice(0, packageIndex + 1)
      : path.basename(executable).toLowerCase().startsWith('dsh') ? [] : ['--yes', DSH_PACKAGE_NAME]
    const commandArgs = [...prefix, 'plugin', '--profile', targetProfile, ...args]
    // git 源插件（github:/git+ 或带 #path:）的仓库在 github/codeload，换 npm 注册表解决不了，
    // 网络失败时直接失败走 npm 回退，避免白等一次。
    const isGitTarget = args.some(argument => /^(github:|git\+)/i.test(argument) || argument.includes('#path:'))
    const commandEnv = {
      ...process.env,
      DSH_HOME: settings.dshHome,
      FORCE_COLOR: '0',
      CI: 'true',
      npm_config_yes: 'true',
      NPM_CONFIG_YES: 'true',
      PNPM_CONFIG_YES: 'true',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      ...(options.packageStoreRoot ? {
        npm_config_store_dir: options.packageStoreRoot,
        NPM_CONFIG_STORE_DIR: options.packageStoreRoot,
        pnpm_config_store_dir: options.packageStoreRoot,
        PNPM_CONFIG_STORE_DIR: options.packageStoreRoot,
      } : {}),
    }
    const dshEnv = withGitOnPath(withExecutableDirectoryOnPath(pnpm.executable, withExecutableDirectoryOnPath(node.node, commandEnv)))
    if (args.some(isGitHostedSpecifier) && !findGitExecutable(dshEnv)) {
      const message = gitUnavailableMessage()
      options.emitOutput('error', message)
      throw new Error(message)
    }
    // 镜像优先：默认 npmmirror（或用户网络设置），网络失败时切官方源重试一次；
    // 同时注入探测到的系统代理，让 github/codeload 与 npm 的请求都能走梯子。
    const network = buildNetworkEnvironment(settings)
    const handleOutput = (text: string, level: OutputLevel) => {
      options.emitOutput(level, text)
      const pair = /downloaded\s+(\d+)\s+of\s+(\d+)/i.exec(text)
      const pnpmPercent = pnpmProgressPercent(text)
      if (pair) {
        progress(name, 'downloading', `正在下载插件及依赖（${pair[1]} / ${pair[2]} 个包）`, Math.min(82, 20 + Math.round(Number(pair[1]) / Number(pair[2]) * 60)))
      } else if (pnpmPercent !== null) {
        progress(name, 'downloading', '正在下载插件及依赖', pnpmPercent)
      } else if (/build|prepare|prepack/i.test(text)) {
        progress(name, 'building', '正在执行插件构建步骤', 84)
      }
      // 其余输出不刷新进度：保留当前数值，避免已解析的真实百分比被 null 覆盖。
    }
    let useOfficialRegistry = false
    const runDshPlugin = (): Promise<CommandResult> => {
      const registry = registryOverride ?? (useOfficialRegistry ? NPM_OFFICIAL_REGISTRY : network.npmRegistry)
      return execute(executable, commandArgs, {
        cwd: settings.workspace,
        env: {
          ...dshEnv,
          ...network.proxy,
          npm_config_registry: registry,
          NPM_CONFIG_REGISTRY: registry,
        },
        inactivityTimeoutMs: MARKET_COMMAND_IDLE_TIMEOUT_MS,
        onOutput: handleOutput,
        timeoutMs: DSH_MARKET_COMMAND_TIMEOUT_MS,
      })
    }
    options.emitOutput('info', `dsh-market 插件操作：${args.join(' ')}`)
    progress(name, 'resolving', '正在解析精选插件来源', 12)
    let result = await runDshPlugin()
    // Existing Profiles may still have node_modules linked to the system pnpm
    // store. Move the links to the launcher's shared store before retrying the
    // DSH command; otherwise pnpm refuses to touch the Profile at all.
    if (result.exitCode !== 0 && /ERR_PNPM_UNEXPECTED_STORE/i.test(result.output)) {
      const profilePath = path.join(settings.dshHome, 'profiles', targetProfile)
      options.emitOutput('info', '检测到 Profile 使用旧 pnpm store，正在迁移依赖后自动重试。')
      progress(name, 'resolving', '正在迁移 Profile 依赖到启动器插件池', 78)
      const migrate = await execute(pnpm.executable, ['install'], {
        cwd: profilePath,
        env: dshEnv,
        inactivityTimeoutMs: MARKET_COMMAND_IDLE_TIMEOUT_MS,
        onOutput: (text, level) => options.emitOutput(level, text),
        timeoutMs: DSH_MARKET_COMMAND_TIMEOUT_MS,
      })
      if (migrate.exitCode !== 0) {
        throw new Error(`插件依赖迁移失败（代码 ${migrate.exitCode}）：${migrate.output.slice(-800)}`)
      }
      progress(name, 'resolving', 'Profile 依赖已迁移，正在重试插件操作', 80)
      result = await runDshPlugin()
    }
    // Keep dsh-market's recovery behavior: an ignored build approval, a git
    // host build approval, or a transient network failure gets exactly one
    // automatic retry each.
    if (result.exitCode !== 0 && /ERR_PNPM_IGNORED_BUILDS/i.test(result.output)) {
      const approved = await approveAllIgnoredBuilds(path.join(settings.dshHome, 'profiles', targetProfile, 'pnpm-workspace.yaml'), result.output)
      if (approved.length > 0) {
        progress(name, 'building', `已允许 ${approved.length} 个构建脚本，正在重试`, 86)
        result = await runDshPlugin()
      }
    } else if (result.exitCode !== 0 && /GIT_DEP_PREPARE_NOT_ALLOWED|git-hosted package.*build scripts|needs to execute build scripts/i.test(result.output)) {
      // pnpm 11 对 git 托管且带 prepare/prepack 脚本的包做硬校验，必须先把包加入
      // pnpm-workspace.yaml 的 allowBuilds 才能继续。
      const keys = gitPrepareBuildKeys(result.output)
      if (keys.length > 0) {
        const approved = await approveBuildKeys(path.join(settings.dshHome, 'profiles', targetProfile, 'pnpm-workspace.yaml'), keys)
        if (approved.length > 0) {
          options.emitOutput('info', `dsh-market 已允许 git 插件构建脚本：${approved.join(', ')}`)
          progress(name, 'building', `已允许 ${approved.length} 个 git 插件构建脚本，正在重试`, 86)
          result = await runDshPlugin()
        }
      }
    } else if (result.exitCode !== 0 && !isGitTarget && /ERR_PNPM_FETCH_5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|getaddrinfo|socket hang up/i.test(result.output)) {
      progress(name, 'resolving', '网络临时失败，切换 npm 源后自动重试一次', 18)
      if (!useOfficialRegistry) {
        useOfficialRegistry = true
        result = await runDshPlugin()
      }
    }
    return result
  }

  /**
   * git 源为 monorepo workspace 子包（或其 GitHub 直连失败）时的 npm 回退：
   * 尽量从仓库/镜像获取实际的 npm 包名，改用 npm 源安装（默认走 npmmirror）。
   * 成功返回 true 并登记别名 + 激活到 bundles。
   */
  async function fallbackToNpmPackage(
    entry: RegistryPlugin,
    source: { repo: string; subpath: string | null; branch: string | null },
    profileOverride?: string,
  ): Promise<boolean> {
    if (source.subpath === null) return false
    const viaRaw = await fetchSubpackageManifest(source.repo, source.branch, source.subpath)
    let packageName = viaRaw?.name ?? null
    let version = viaRaw?.version ?? null
    if (!packageName) {
      // GitHub/raw 不可达（大陆直连）时改用 npm 镜像搜索子包目录名。
      const folder = source.subpath.split('/').at(-1)
      packageName = folder ? await findNpmPackageByFolderName(folder) : null
      if (!packageName) return false
    }
    const spec = version ? `${packageName}@${version}` : packageName
    options.emitOutput('info', `dsh-market：${entry.name} 无法按 git 子包安装，改用 npm 源安装（${spec}）。`)
    progress(entry.name, 'resolving', `改用 npm 源安装（${packageName}）`, 22)
    // 跳过 postinstall：回退安装的目标是"下载并启用"，原生包（cloudflared/ssh2 等）
    // 的 postinstall 常去 GitHub 拉二进制，大陆直连会被拖死。
    const retry = await runPlugin(entry.name, ['add', spec, '--ignore-scripts'], entry.url, profileOverride)
    if (retry.exitCode !== 0) {
      options.emitOutput('error', `dsh-market：npm 回退安装失败（代码 ${retry.exitCode}）：${retry.output.slice(-600)}`)
      return false
    }
    npmAliasByName.set(entry.name, packageName)
    await ensureProfileBundleEnabled(packageName, profileOverride)
    return true
  }

  /** 读取仓库子包的 package.json，得到 npm 包名与版本；GitHub 不可达时返回 null。 */
  async function fetchSubpackageManifest(repo: string, branch: string | null, subpath: string): Promise<{ name: string | null; version: string | null } | null> {
    try {
      const manifestUrl = `https://raw.githubusercontent.com/${repo}/${branch ?? 'HEAD'}/${subpath}/package.json`
      const response = await fetchImpl(manifestUrl, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-melody-launcher/dsh-market' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return null
      const manifest = await response.json() as { name?: unknown; version?: unknown }
      return {
        name: typeof manifest?.name === 'string' && manifest.name.trim() !== '' ? manifest.name.trim() : null,
        version: typeof manifest?.version === 'string' && manifest.version.trim() !== '' ? manifest.version.trim() : null,
      }
    } catch { return null }
  }

  /** 通过 npm 镜像搜索接口按子包目录名找包（国内可达，GitHub 不通时兜底）。 */
  async function findNpmPackageByFolderName(folder: string): Promise<string | null> {
    try {
      const settings = await options.readSettings()
      const registry = buildNetworkEnvironment(settings).npmRegistry.replace(/\/+$/, '')
      const url = `${registry}/-/v1/search?text=${encodeURIComponent(folder)}&size=20`
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return null
      const body = await response.json() as { objects?: Array<{ package?: { name?: string } }> }
      const target = folder.toLowerCase()
      const match = body.objects
        ?.map(item => item.package?.name)
        .find(name => typeof name === 'string' && name.split('/').at(-1)?.toLowerCase() === target)
      return match ?? null
    } catch { return null }
  }

  /** 把已安装且声明 dsh.bundle 的包加入 dsh.profile.bundles（等价 dsh CLI 的 reconcile，保证插件真正启用）。 */
  async function ensureProfileBundleEnabled(packageName: string, profileOverride?: string): Promise<void> {
    try {
      const loadedSettings = await options.readSettings()
      const settings = profileOverride ? { ...loadedSettings, profileName: profileOverride } : loadedSettings
      const profileDir = path.join(settings.dshHome, 'profiles', settings.profileName)
      const manifestPath = path.join(profileDir, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      if (typeof manifest.dependencies?.[packageName] !== 'string') return
      try {
        const installed = JSON.parse(await readFile(path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8')) as { dsh?: { bundle?: unknown } }
        if (installed?.dsh?.bundle === undefined) return
      } catch { return }
      const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]
      if (bundles.includes(packageName)) return
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, packageName] } }
      const temporary = `${manifestPath}.dsh-market.tmp`
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      try { await rename(temporary, manifestPath) } catch {
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        await unlink(temporary).catch(() => undefined)
      }
    } catch { /* profile 写入失败不阻断安装 */ }
  }

  async function mutate(name: string, action: 'install' | 'update' | 'uninstall', profileOverride?: string, exactVersion?: string | null): Promise<DshMarketInstalledPlugin[]> {
    if (active) throw new Error('dsh-market 正在执行另一个插件操作，请等待完成。')
    active = true
    try {
      // Uninstall is deliberately local. Do not even load the remote market
      // registry: resolving a display name is not worth making removal online.
      if (action === 'uninstall' && options.removePluginLocally) {
        await options.removePluginLocally(name, profileOverride, { purgeStore: true })
        updatesCache = null
        progress(name, 'complete', '插件已从 Profile 和共享插件池卸载', 100)
        return []
      }
      const registry = await loadRegistry()
      const entry = registry.plugins!.find(item => item.name === name || item.npm === name)
      if (!entry) throw new Error('插件不在 dsh-market 精选目录中。')
      let target = dshMarketInstallTarget(entry, action === 'install' ? exactVersion : null)
      if (!target) throw new Error('dsh-market 不支持此插件的来源地址。')
      const settings = await options.readSettings()
      const targetSettings = profileOverride ? { ...settings, profileName: profileOverride } : settings
      const before = await readInstalled(targetSettings)
      const npmAlias = npmAliasByName.get(entry.name) ?? entry.npm
      const alias = findDshMarketInstalledAlias(entry, before.map, npmAlias)
      if (action === 'install' && alias) throw new Error(`插件已安装（${alias}）。`)
      if (action === 'update' && !alias) throw new Error('插件尚未安装，不能更新。')
      if (action === 'install' && alias === null) {
        const names = [npmAlias ?? '', entry.name].filter((value): value is string => typeof value === 'string' && value !== '')
        const collision = names.find(value => before.map[value] !== undefined)
        if (collision !== undefined) throw new Error(`同名冲突：Profile 已安装「${collision}」，请先卸载后再从 dsh-market 安装。`)
      }
      progress(name, action === 'uninstall' ? 'resolving' : 'checking', action === 'uninstall' ? '正在准备卸载' : '正在核对 dsh-market 来源', 8)
      let usedLatest = false
      let result = await runPlugin(name, action === 'uninstall' ? ['remove', alias ?? name] : ['add', target], entry.url, profileOverride)
      if (
        action === 'install'
        && exactVersion
        && entry.npm
        && result.exitCode !== 0
        && isNpmVersionUnavailableError(new Error(result.output), entry.npm, exactVersion)
      ) {
        usedLatest = true
        options.emitOutput('info', `npm 未找到 ${entry.npm}@${exactVersion}，正在尝试安装 latest。`)
        progress(name, 'resolving', `版本 ${exactVersion} 不存在，正在尝试 npm latest`, 12)
        target = dshMarketInstallTarget(entry)
        if (!target) throw new Error('dsh-market 不支持此插件的来源地址。')
        result = await runPlugin(name, ['add', target], entry.url, profileOverride)
      }
      if (result.exitCode !== 0 && isGitUnavailableOutput(result.output)) {
        const message = gitUnavailableMessage()
        options.emitOutput('error', message)
        throw new Error(message)
      }
      let installedViaFallback = false
      if (result.exitCode !== 0) {
        const source = parseDshMarketSourceUrl(entry.url)
        installedViaFallback = action === 'install' && source !== null
          ? await fallbackToNpmPackage(entry, source, profileOverride)
          : false
        if (!installedViaFallback) throw new Error(describeMarketFailure(entry, result.exitCode, result.output))
      }
      const after = await readInstalled(targetSettings)
      if (action !== 'uninstall') {
        const installedName = findDshMarketInstalledAlias(entry, after.map, npmAliasByName.get(entry.name))
        if (!installedName) throw new Error('pnpm 已完成，但 dsh-market 未检测到安装结果。')
        const installedRecord = after.records.find(item => item.name === installedName)
        if (exactVersion && !usedLatest && installedRecord?.version !== exactVersion) throw new Error(`插件版本校验失败：要求 ${exactVersion}，实际 ${installedRecord?.version ?? '未知'}。`)
        if (usedLatest && !installedRecord?.version) throw new Error('npm latest 安装完成，但无法读取实际安装版本。')
        if (usedLatest) options.emitOutput('info', `已回退到 npm latest，实际安装版本：${installedRecord?.version ?? '未知'}`)
        const profile = await readProfile(targetSettings.dshHome, targetSettings.profileName)
        const component = profile.plugins.find(item => item.packageName === installedName)
        if (!component || !component.compatible) throw new Error('插件已下载，但没有检测到可加载的 DSH Bundle。')
        // dsh CLI 的 reconcile 不一定每次都会把 bundle 加进层列表，这里兜底激活。
        await ensureProfileBundleEnabled(installedName, profileOverride)
        if (options.syncProfilePool) {
          try {
            await options.syncProfilePool(targetSettings.dshHome)
          } catch (error) {
            options.emitOutput('error', `共享插件池同步失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      updatesCache = null
      progress(name, 'verifying', '正在刷新 dsh-market 安装状态', 94)
      const catalog = await buildCatalog(profileOverride)
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
      const entry = registry.plugins!.find(item => findDshMarketInstalledAlias(item, { [name]: spec }, npmAliasByName.get(item.name)) === name)
      if (!entry) return
      const npmName = npmAliasByName.get(entry.name) ?? entry.npm
      try {
        if (npmName) {
          const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(npmName)}/latest`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
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
      } catch { result[name] = { kind: npmName ? 'npm' : 'github', current: null, latest: null, updateAvailable: false } }
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
    install: (name: string, profileName?: string, exactVersion?: string | null) => mutate(name, 'install', profileName, exactVersion),
    update: (name: string, profileName?: string) => mutate(name, 'update', profileName),
    uninstall: (name: string, profileName?: string) => mutate(name, 'uninstall', profileName),
    toggle: async (name: string, enabled: boolean) => {
      const settings = await options.readSettings()
      const installed = await readInstalled(settings)
      const entry = (await loadRegistry()).plugins!.find(item => item.name === name || item.npm === name)
      if (!entry) throw new Error('插件不在 dsh-market 精选目录中。')
      const alias = findDshMarketInstalledAlias(entry, installed.map, npmAliasByName.get(entry.name))
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
