import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PROFILE_NAME, DSH_PACKAGE_NAME } from '../src/constants'
import type {
  ApplicationRepositoryAnalysis,
  AppSettings,
  CatalogAnalysisProgress,
  CatalogComponentKind,
  CatalogRepositoryAnalysis,
  DshInstallationStatus,
  DshUpdateStatus,
  InstallProgress,
  InstalledPreset,
  InstalledSkill,
  PluginInstallTarget,
  PresetInstallRequest,
  PresetInstallResult,
  PresetInstallTarget,
  ProfileState,
  RepositoryAnalysis,
  RepositoryInstallResult,
  RuntimeOutput,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInstallTarget,
  SkillRepositoryAnalysis,
} from '../src/types'
import { analyzeApplicationRepository } from './application-catalog'
import { runCommand, type CommandOptions, type CommandResult, type OutputLevel } from './command'
import { analyzeCatalogWithProgress, mergeMetaRepositoryAnalysis } from './catalog-analysis'
import {
  findInstalledDsh,
  getManagedDshStatus,
  installWaitingMessage,
  isDshRepository,
  packageManagerProgress,
} from './dsh-install'
import { dshRegistryCandidates, dshVersionRoot, findManagedDshVersions, listAvailableDshVersions, normalizeDshVersion } from './runtime-versions'
import { checkDshUpdate } from './dsh-update'
import { resolveNodeExecutable, type NodeRuntime, type NodeRuntimeProgress, type PnpmRuntime } from './node-runtime'
import { approveAllIgnoredBuilds, denyBuildKeys } from './plugin-install'
import { analyzeMetaRepository } from './meta-repo-catalog'
import { analyzeRepository } from './plugin-catalog'
import { prepareSubdirectoryPlugin, type PluginSourceProgress } from './plugin-source'
import { purgeUnusedPluginSources } from './plugin-source-cleanup'
import { readPluginReceipts, recordPluginInstall, removePluginReceipt } from './plugin-receipts'
import { readPresetReceipts, recordPresetInstall } from './preset-receipts'
import { readSkillReceipts, recordSkillInstall } from './skill-receipts'
import { isSafePackageName, isSafeProfileName, readProfile, removePluginFromProfile, removeUnusedSharedPluginBodies } from './profile'
import { gitUnavailableMessage, isGitHostedSpecifier, isGitUnavailableOutput, findGitExecutable, withExecutableDirectoryOnPath, withGitOnPath } from './process'
import { isNpmVersionUnavailableError } from './npm-install'
import { buildNetworkEnvironment } from './proxy'
import { analyzeSkillRepository } from './skill-catalog'
import { readInstalledSkills as readLocalSkills, toggleInstalledSkill } from './skill-format'
import { installPresetFromRepository, readInstalledPresets as readLocalPresets, toggleInstalledPreset, uninstallInstalledPreset } from './preset-install'
import { downloadReleaseAsset } from './release-download'
import { installSkillFromRepository, skillInstallLimits } from './skill-install'
import {
  DSH_SUBPROCESS_LOCAL_PACKAGE,
  ensureDshScriptPolicy,
  hasDshScriptPackage,
} from './dsh-script-policy'

/**
 * 安装编排：插件与 DSH 本体的安装、卸载，以及安装进度的推送。
 * 同一时刻只允许一个安装任务。
 */

/**
 * 拼出调用官方 DSH CLI 的完整参数。
 * 启动配置可能是 `npx --yes @deepseek-ai/dsh web`，也可能已经绑定到本地 dsh 可执行文件，
 * 两种情况下 `plugin` 子命令的前缀不同。
 */
export function buildPluginCommandArgs(
  settings: AppSettings,
  executable: string,
  args: string[],
  profileName?: string,
): string[] {
  const packageIndex = settings.launchArgs.indexOf(DSH_PACKAGE_NAME)
  const prefix = packageIndex >= 0
    ? settings.launchArgs.slice(0, packageIndex + 1)
    : path.basename(executable).toLowerCase().startsWith('dsh')
      ? []
      : ['--yes', DSH_PACKAGE_NAME]
  return [...prefix, 'plugin', '--profile', profileName ?? settings.profileName, ...args]
}

/**
 * 解析插件最终装入的 Profile：调用方显式覆盖优先，其次取组件自身的建议，
 * 都没有时回落到默认 Profile。
 */
export function resolveInstallProfile(target: PluginInstallTarget, override?: string): string {
  return override ?? target.profileName ?? DEFAULT_PROFILE_NAME
}

/** 校验 `local-directory` 源的本地插件本体目录，返回可用于 pnpm `file:` 源的路径。 */
export function validateLocalPluginDirectory(localDirectory?: string): string {
  if (!localDirectory || !path.isAbsolute(localDirectory)) {
    throw new Error('本地插件目录无效，必须是绝对路径。')
  }
  if (!existsSync(localDirectory)) {
    throw new Error(`本地插件目录不存在：${localDirectory}`)
  }
  if (!existsSync(path.join(localDirectory, 'package.json'))) {
    throw new Error(`本地插件目录中没有找到 package.json：${localDirectory}`)
  }
  return localDirectory
}

/** Resolve a Profile `file:` dependency before uninstall removes its manifest entry. */
function resolveFileDependency(manifestPath: string, specifier: unknown): string | null {
  if (typeof specifier !== 'string' || !specifier.startsWith('file:')) return null
  let raw = specifier.slice('file:'.length).trim()
  if (!raw) return null
  try { raw = decodeURIComponent(raw) } catch { /* keep legacy raw path */ }
  if (raw.startsWith('//')) {
    try {
      const parsed = new URL(`file:${raw}`)
      if (parsed.host && parsed.host !== 'localhost') return null
      raw = decodeURIComponent(parsed.pathname)
      if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1)
    } catch { return null }
  }
  return path.resolve(path.dirname(manifestPath), raw)
}

function validateNpmVersion(version?: string): string | undefined {
  if (version === undefined) return undefined
  const normalized = version.trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(normalized)) throw new Error('npm 插件版本格式无效。')
  return normalized
}

export interface InstallerOptions {
  readSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  /** 确保 Node.js 可用；onProgress 用于把下载进度并入安装进度。 */
  prepareNodeRuntime: (onProgress?: (progress: NodeRuntimeProgress) => void) => Promise<NodeRuntime>
  /** 确保 pnpm 可用；DSH 的 plugin 子命令会从 PATH 调用它。 */
  preparePnpmRuntime: (
    nodeRuntime: NodeRuntime,
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ) => Promise<PnpmRuntime>
  /** 插件子目录安装的缓存根目录。 */
  pluginSourceRoot: string
  /** 插件安装凭据文件的路径。 */
  pluginReceiptsPath: string
  /** 所有 Profile 共用的受控 pnpm store；Profile 自己仍保留独立链接层。 */
  packageStoreRoot?: string
  /** 安装成功后同步共享插件池；同步失败只记录日志，不影响安装结果。 */
  syncProfilePool?: (dshHome: string) => Promise<void>
  /**
   * 清理受控 pnpm store 中已经不再被任何 Profile 引用的缓存。
   * 该回调由主进程注入，必须使用启动器自带的 pnpm，并以 offline 模式执行。
   */
  purgePnpmStore?: (storeRoot: string) => Promise<void>
  /** Agent 预设安装凭据文件的路径。 */
  presetReceiptsPath: string
  /** Skill 安装凭据文件的路径。 */
  skillReceiptsPath: string
  /** Skill 仓库缓存根目录。 */
  skillSourceRoot: string
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  emitProgress: (progress: InstallProgress) => void
  isRuntimeRunning: () => boolean
  /** 测试注入用的命令执行器替身；缺省用真实 runCommand。 */
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>
  /** Git 解析器，测试可模拟未安装 Git 的系统。 */
  resolveGitExecutable?: (environment: NodeJS.ProcessEnv) => string | null
  /** 所有 GitHub HTTP 请求统一从这里注入认证。 */
  githubFetch?: typeof fetch
  /** 技能市场磁盘缓存路径（userData/skill-market-cache.json）；缺省只保留内存缓存。 */
  skillMarketCachePath?: string
}

export interface Installer {
  /** 安装一个 GitHub 仓库；识别为 DSH 本体时走本体安装流程。 */
  install(fullName: string): Promise<RepositoryInstallResult>
  /** 安装一个已选定的插件组件；调用前需先 analyze。profileOverride 用于把插件装进指定 Profile。 */
  installPluginTarget(
    request: {
      repository: string
      defaultBranch: string
      targetId: string
      /** 整合包声明的固定 commit（github 源），覆盖重新分析得到的 HEAD commit。 */
      commit?: string
      /** 整合包声明的固定版本（npm 源），覆盖重新分析得到的版本。 */
      version?: string
      /** release 源插件的 tgz 直链（meta-repo 分析时解析），覆盖重分析得到的 github 源。 */
      tarballUrl?: string
      /** 整合包清单声明的来源，优先于重新分析得到的 npm/GitHub 候选。 */
      source?: 'npm' | 'github'
    },
    profileOverride?: string,
  ): Promise<RepositoryInstallResult>
  /** 直接安装 npm 发布的标准 Bundle；用于没有 GitHub 仓库的清单条目。 */
  installNpmPackage(
    request: { packageName: string; version?: string; repository?: string; approvedBuildKeys?: string[]; deniedBuildKeys?: string[] },
    profileOverride?: string,
  ): Promise<RepositoryInstallResult>
  /** Install a validated package directory into a target Profile. */
  installLocalPlugin(
    request: { packageName: string; directory: string; repository?: string; commit?: string; version?: string },
    profileOverride?: string,
  ): Promise<RepositoryInstallResult>
  /** 检测一个插件仓库，返回可安装组件清单（带 5 分钟缓存）。 */
  analyzePlugin(fullName: string, defaultBranch: string): Promise<RepositoryAnalysis>
  /** 检测一个 Skill 仓库，返回可安装组件清单（带 5 分钟缓存）。 */
  analyzeSkill(fullName: string, defaultBranch: string): Promise<SkillRepositoryAnalysis>
  /** 检测一个独立应用仓库，返回可安装应用加载项。 */
  analyzeApplication(fullName: string, defaultBranch: string): Promise<ApplicationRepositoryAnalysis>
  /** 同时检测 Plugin、Skill 与应用加载项，返回统一资源市场分类。 */
  analyzeCatalogRepository(
    fullName: string,
    defaultBranch: string,
    onProgress?: (progress: CatalogAnalysisProgress) => void,
    options?: { bypassCache?: boolean; componentKinds?: CatalogComponentKind[] },
  ): Promise<CatalogRepositoryAnalysis>
  /** 安装一个 Skill。 */
  installSkill(request: SkillInstallRequest): Promise<SkillInstallResult>
  /** C 端技能市场：归档式检测（绕开 api.github.com 限流）与免重析安装。 */
  analyzeSkillArchive(fullName: string, defaultBranch: string): Promise<SkillRepositoryAnalysis>
  installSkillFromMarket(request: { repository: string; target: SkillInstallTarget }): Promise<SkillInstallResult>
  /** 按固定 pin 安装一个 Skill（整合包清单导入用，不重新分析 HEAD）。 */
  installSkillPinned(request: { repository: string; target: SkillInstallTarget }): Promise<InstalledSkill>
  /** 读取已安装的 Skill 列表。 */
  readInstalledSkills(): Promise<InstalledSkill[]>
  /** 启用或停用一个本地 Skill。 */
  toggleSkill(name: string, enabled: boolean): Promise<InstalledSkill[]>
  /** 安装一个 agent-preset（meta-repo 子模块里的预设目录）。 */
  installPreset(request: PresetInstallRequest): Promise<PresetInstallResult>
  /** 读取已安装的 agent-preset 列表。 */
  readInstalledPresets(): Promise<InstalledPreset[]>
  /** 启用或停用一个本地 agent-preset。 */
  togglePreset(name: string, enabled: boolean): Promise<InstalledPreset[]>
  /** 删除一个本地 agent-preset（目录与安装凭据）。 */
  uninstallPreset(name: string): Promise<InstalledPreset[]>
  /** 汇总当前 Profile 与安装凭据里已安装的仓库，用于在列表中标记「已安装」。 */
  listInstalledRepositories(): Promise<string[]>
  /** 卸载插件；purgeStore 会忽略显式 Profile 并从本机所有 Profile 彻底清除。 */
  remove(packageName: string, profileName?: string, options?: { purgeStore?: boolean }): Promise<ProfileState>
  detectDsh(): Promise<DshInstallationStatus>
  checkDshUpdate(): Promise<DshUpdateStatus>
  isBusy(): boolean
}

/** Node.js 下载进度映射到安装进度的 5% ~ 17% 区间。 */
const NODE_RUNTIME_PROGRESS_FLOOR = 5
const NODE_RUNTIME_PROGRESS_CEILING = 17
const DOWNLOAD_PROGRESS_FLOOR = 28
/**
 * pnpm/npm 的依赖解析可能数分钟没有新的一行输出，因此这里只限制“无输出”
 * 而不是整次安装时长。超时后会终止 DSH、cmd 和 pnpm 的整棵进程树。
 */
const INSTALL_COMMAND_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Release 插件 tgz 安装包体积上限（插件可能比 Skill 大，放宽到 256 MiB）。 */
const MAX_RELEASE_BYTES = 256 * 1024 * 1024

/**
 * 让 Profile 目录里的 pnpm 与启动器保持一致：Web 端内置更新器用系统 pnpm
 * 直接操作 Profile（不经过启动器进程），若它的 store/registry 与启动器不同，
 * pnpm 会以 ERR_PNPM_UNEXPECTED_STORE 拒绝工作，或绕开镜像源直连 npmjs。
 * 这里把项目级 .npmrc 的 store-dir 固定到启动器插件仓库、registry 同步为
 * 网络设置的镜像，其余用户已写的配置原样保留。
 */
export async function syncProfilePnpmConfig(
  profileDir: string,
  registry: string,
  storeRoot?: string,
): Promise<void> {
  if (!storeRoot) return
  const managed = new Set(['store-dir', 'registry'])
  const npmrcPath = path.join(profileDir, '.npmrc')
  const existing = await readFile(npmrcPath, 'utf8').catch(() => '')
  const kept: string[] = []
  for (const line of existing.split(/\r?\n/)) {
    const key = /^[ \t]*([^=#][^=]*?)[ \t]*=/.exec(line)?.[1]?.trim().toLowerCase()
    if (line.trim() === '' || line.trim().startsWith('#') || key === undefined || !managed.has(key)) kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  kept.push(`store-dir=${storeRoot.replace(/\\/g, '/')}`)
  kept.push(`registry=${registry}`)
  const content = `${kept.join('\n')}\n`
  const temporary = `${npmrcPath}.dsh-launcher.tmp`
  await mkdir(profileDir, { recursive: true })
  await writeFile(temporary, content, 'utf8')
  try {
    await rename(temporary, npmrcPath)
  } catch {
    await writeFile(npmrcPath, content, 'utf8')
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export function createInstaller(options: InstallerOptions): Installer {
  let active: InstallProgress | null = null
  const executeCommand = options.runCommand ?? runCommand
  const resolveGit = options.resolveGitExecutable ?? findGitExecutable

  /** Keep a successful install successful even if another Profile cannot be synchronized. */
  const syncInstalledPluginPool = async (dshHome: string): Promise<void> => {
    if (!options.syncProfilePool) return
    try {
      await options.syncProfilePool(dshHome)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      options.emitOutput('error', `共享插件池同步失败：${detail}`)
    }
  }

  const emit = (progress: InstallProgress) => {
    active = progress
    options.emitProgress(progress)
  }

  const currentPercent = (fallback: number) => active?.percent ?? fallback

  const detectDsh = async (): Promise<DshInstallationStatus> => {
    const settings = await options.readSettings()
    if (settings.dshVersion) {
      const selected = await getManagedDshStatus(dshVersionRoot(settings.dshInstallPath, settings.dshVersion))
      if (selected.installed) return selected
    }
    const managedVersions = await findManagedDshVersions(settings.dshInstallPath)
    const configured = managedVersions.find(item => item.executable.toLowerCase() === settings.launchExecutable.toLowerCase())
    if (configured) return { installed: true, version: configured.version, executable: configured.executable, source: 'launcher' }
    return findInstalledDsh({
      managedRoot: settings.dshInstallPath,
      configuredExecutable: settings.launchExecutable,
    })
  }

  const checkForDshUpdate = async () => {
    const installation = await detectDsh()
    const settings = await options.readSettings()
    const network = buildNetworkEnvironment(settings)
    const fetchImpl = options.githubFetch ?? fetch
    // 版本真值在 npm registry：镜像优先，官方源兜底，GitHub 只作最后回退。
    return checkDshUpdate(installation, fetchImpl, [network.npmRegistry, NPM_OFFICIAL_REGISTRY])
  }

  /** 仓库结构检测结果缓存 5 分钟，避免同一仓库反复触发 GitHub 请求。 */
  const repositoryAnalysisCache = new Map<string, { expiresAt: number; analysis: RepositoryAnalysis }>()
  const skillAnalysisCache = new Map<string, { expiresAt: number; analysis: SkillRepositoryAnalysis }>()
  const applicationAnalysisCache = new Map<string, { expiresAt: number; analysis: ApplicationRepositoryAnalysis }>()

  const analyzePlugin = async (fullName: string, defaultBranch: string, bypassCache = false): Promise<RepositoryAnalysis> => {
    const settings = await options.readSettings()
    const cacheKey = `${fullName.toLowerCase()}#${defaultBranch}#${settings.profileName}`
    const cached = repositoryAnalysisCache.get(cacheKey)
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.analysis
    const analysis = options.githubFetch
      ? await analyzeRepository(fullName, defaultBranch, settings.profileName, options.githubFetch)
      : await analyzeRepository(fullName, defaultBranch, settings.profileName)
    repositoryAnalysisCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, analysis })
    return analysis
  }

  const analyzeSkill = async (fullName: string, defaultBranch: string, bypassCache = false): Promise<SkillRepositoryAnalysis> => {
    const cacheKey = `${fullName.toLowerCase()}#${defaultBranch}`
    const cached = skillAnalysisCache.get(cacheKey)
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.analysis
    const analysis = options.githubFetch
      ? await analyzeSkillRepository(fullName, defaultBranch, options.githubFetch)
      : await analyzeSkillRepository(fullName, defaultBranch)
    skillAnalysisCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, analysis })
    return analysis
  }

  /** C 端技能市场专用：codeload 归档 + 本地扫描，内存 5 分钟 + 磁盘 24 小时（过期先回旧、后台刷新）。 */
  const skillMarketCache = options.skillMarketCachePath ? createSkillMarketCacheStore(options.skillMarketCachePath) : null
  const archiveAnalysisFromTargets = (repository: string, defaultBranch: string, targets: SkillRepositoryAnalysis['targets']): SkillRepositoryAnalysis => ({
    repository,
    defaultBranch,
    installability: targets.length === 1 ? 'ready' : targets.length > 1 ? 'choice' : 'invalid',
    summary: '',
    targets,
  })
  const analyzeSkillArchive = async (fullName: string, defaultBranch: string, bypassCache = false): Promise<SkillRepositoryAnalysis> => {
    const cacheKey = `${fullName.toLowerCase()}#${defaultBranch}`
    const cached = skillAnalysisCache.get(cacheKey)
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.analysis

    const fetchAnalysis = async (): Promise<SkillRepositoryAnalysis> => {
      const settings = await options.readSettings()
      const analysis = await analyzeSkillRepositoryFromArchive(fullName, defaultBranch, {
        fetchImpl: options.githubFetch,
        mirror: settings.network?.githubMirror,
      })
      skillAnalysisCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, analysis })
      await skillMarketCache?.write({ repository: fullName, branch: defaultBranch, fetchedAt: Date.now(), targets: analysis.targets }).catch(() => undefined)
      return analysis
    }

    if (!bypassCache && skillMarketCache) {
      try {
        const disk = lookupSkillMarketCache(await skillMarketCache.read(), fullName, defaultBranch)
        if (disk.state === 'fresh') {
          const analysis = archiveAnalysisFromTargets(fullName, defaultBranch, disk.entry.targets)
          skillAnalysisCache.set(cacheKey, { expiresAt: disk.entry.fetchedAt + SKILL_MARKET_CACHE_TTL_MS, analysis })
          return analysis
        }
        if (disk.state === 'stale') {
          // 过期条目先原样返回保证秒开，同时后台刷新写回两级缓存。
          void fetchAnalysis().catch(() => undefined)
          return archiveAnalysisFromTargets(fullName, defaultBranch, disk.entry.targets)
        }
      } catch {
        // 磁盘缓存损坏时直接走网络重建。
      }
    }
    return fetchAnalysis()
  }

  const analyzeApplication = async (
    fullName: string,
    defaultBranch: string,
    bypassCache = false,
  ): Promise<ApplicationRepositoryAnalysis> => {
    const cacheKey = `${fullName.toLowerCase()}#${defaultBranch}`
    const cached = applicationAnalysisCache.get(cacheKey)
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.analysis
    const analysis = options.githubFetch
      ? await analyzeApplicationRepository(fullName, defaultBranch, options.githubFetch)
      : await analyzeApplicationRepository(fullName, defaultBranch)
    applicationAnalysisCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, analysis })
    return analysis
  }

  const analyzeCatalogRepository = async (
    fullName: string,
    defaultBranch: string,
    onProgress?: (progress: CatalogAnalysisProgress) => void,
    analyzeOptions: { bypassCache?: boolean; componentKinds?: CatalogComponentKind[] } = {},
  ): Promise<CatalogRepositoryAnalysis> => {
    const bypassCache = analyzeOptions.bypassCache === true
    const selected = analyzeOptions.componentKinds ? new Set(analyzeOptions.componentKinds) : null
    // Preset 存在于 meta-repo 子模块中，识别它需要 Plugin/Skill 两条轻量结构路径。
    const checkPlugin = !selected || selected.has('plugin') || selected.has('preset')
    const checkSkill = !selected || selected.has('skill') || selected.has('preset')
    const checkApplication = !selected || selected.has('application')
    const skippedPlugin = (): RepositoryAnalysis => ({
      repository: fullName,
      defaultBranch,
      installability: 'invalid',
      summary: '共享标签未要求检查 Plugin。',
      targets: [],
    })
    const skippedSkill = (): SkillRepositoryAnalysis => ({
      repository: fullName,
      defaultBranch,
      installability: 'invalid',
      summary: '共享标签未要求检查 Skill。',
      targets: [],
    })
    const skippedApplication = (): ApplicationRepositoryAnalysis => ({
      repository: fullName,
      defaultBranch,
      installability: 'invalid',
      summary: '共享标签未要求检查 Runtime。',
      targets: [],
    })
    const analysis = await analyzeCatalogWithProgress(
      fullName,
      defaultBranch,
      {
        plugin: () => checkPlugin ? analyzePlugin(fullName, defaultBranch, bypassCache) : Promise.resolve(skippedPlugin()),
        skill: () => checkSkill ? analyzeSkill(fullName, defaultBranch, bypassCache) : Promise.resolve(skippedSkill()),
        application: () => checkApplication ? analyzeApplication(fullName, defaultBranch, bypassCache) : Promise.resolve(skippedApplication()),
      },
      onProgress,
    )

    // 聚合仓库（meta-repo）：plugin 分析判为 application 通常意味着仓库根目录只有
    // git submodule。确定性展开子模块（不调大模型）；展开无果才回落常规分类。
    if (analysis.pluginAnalysis?.installability === 'application') {
      const metaAnalysis = options.githubFetch
        ? await analyzeMetaRepository(
            fullName,
            defaultBranch,
            (repository, branch) => checkPlugin ? analyzePlugin(repository, branch, bypassCache) : Promise.resolve(skippedPlugin()),
            (repository, branch) => checkSkill ? analyzeSkill(repository, branch, bypassCache) : Promise.resolve(skippedSkill()),
            options.githubFetch,
          )
        : await analyzeMetaRepository(
            fullName,
            defaultBranch,
            (repository, branch) => checkPlugin ? analyzePlugin(repository, branch, bypassCache) : Promise.resolve(skippedPlugin()),
            (repository, branch) => checkSkill ? analyzeSkill(repository, branch, bypassCache) : Promise.resolve(skippedSkill()),
          )
      if (metaAnalysis) return mergeMetaRepositoryAnalysis(analysis, metaAnalysis)
    }

    return analysis
  }

  /** 准备 Node.js，同时把下载进度折算进当前安装任务的进度条。 */
  const prepareNode = (repository?: string) => options.prepareNodeRuntime(progress => {
    if (!repository || !active) return
    emit({
      repository,
      kind: active.kind,
      phase: 'preparing',
      percent: Math.min(
        NODE_RUNTIME_PROGRESS_CEILING,
        NODE_RUNTIME_PROGRESS_FLOOR + Math.round(progress.percent * 0.12),
      ),
      message: progress.message,
      downloadedBytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes,
    })
  })

  const preparePnpm = (nodeRuntime: NodeRuntime, repository?: string) => options.preparePnpmRuntime(nodeRuntime, progress => {
    if (!repository || !active) return
    emit({
      repository,
      kind: active.kind,
      phase: 'preparing',
      percent: Math.min(
        NODE_RUNTIME_PROGRESS_CEILING,
        NODE_RUNTIME_PROGRESS_FLOOR + Math.round(progress.percent * 0.12),
      ),
      message: progress.message,
      downloadedBytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes,
    })
  })

  /**
   * 包管理器的输出格式各异，能解析出百分比就用真实进度，
   * 解析不出来就用「已等待 N 秒」的心跳，避免进度条长时间凝固。
   */
  const trackPackageProgress = (repository: string, kind: InstallProgress['kind'], message: string) => {
    const startedAt = Date.now()
    let measured = false
    let npmFetchedCount = 0
    let npmPlacedCount = 0
    let lastNpmSummaryCount = 0
    let lastNpmSummaryKind = ''

    const emitWaiting = () => {
      if (measured) return
      emit({
        repository,
        kind,
        phase: 'downloading',
        percent: Math.max(DOWNLOAD_PROGRESS_FLOOR, currentPercent(DOWNLOAD_PROGRESS_FLOOR)),
        message: installWaitingMessage(message, Date.now() - startedAt),
        indeterminate: true,
      })
    }

    emitWaiting()
    const heartbeat = setInterval(emitWaiting, 5_000)
    heartbeat.unref()

    return {
      handleOutput: (text: string) => {
        const npmFetches = (text.match(/npm\s+(?:http\s+(?:fetch\s+GET|cache)|silly\s+fetch\s+manifest)\b/gi) ?? []).length
        const npmPlacements = (text.match(/npm\s+silly\s+placeDep\b/gi) ?? []).length
        npmFetchedCount += npmFetches
        npmPlacedCount += npmPlacements
        const manifest = text.match(/npm\s+silly\s+fetch\s+manifest\s+([^\s]+)/i)?.[1]
        const placement = text.match(/npm\s+silly\s+placeDep\s+[^\s]+\s+([^\s]+)\s+OK/i)?.[1]
        const registryUrl = text.match(/npm\s+http\s+(?:fetch\s+GET\s+\d+|cache)\s+(https?:\/\/registry\.npmjs\.org\/[^\s]+)/i)?.[1]
        let registryPackage = ''
        if (registryUrl) {
          try {
            const registryPath = decodeURIComponent(new URL(registryUrl).pathname.slice(1))
            registryPackage = registryPath.split('/-/')[0] ?? registryPath
          } catch {
            registryPackage = registryUrl
          }
        }
        const stage = manifest
          ? `正在解析 npm 依赖：${manifest}`
          : placement
            ? `正在整理 npm 依赖：${placement}`
            : registryPackage
              ? `正在获取 npm 包信息：${registryPackage}`
            : /npm\s+timing\s+idealTree/i.test(text)
              ? '正在构建 npm 依赖树'
              : /npm\s+timing\s+reify/i.test(text)
                ? '正在写入 npm node_modules'
              : /npm\s+info\s+run\b/i.test(text)
                  ? '正在执行 npm 安装脚本'
                  : ''
        // 原始 npm 输出已经完整转发；摘要每 25 个请求或阶段变化时写一条，
        // 让长时间的依赖解析既能定位当前包，也不会淹没其他日志来源。
        const stageKind = stage.split('：')[0] ?? stage
        const stageCount = manifest || registryPackage
          ? npmFetchedCount
          : placement
            ? npmPlacedCount
            : npmFetchedCount + npmPlacedCount
        if (stage && (stageKind !== lastNpmSummaryKind || stageCount - lastNpmSummaryCount >= 25)) {
          lastNpmSummaryKind = stageKind
          lastNpmSummaryCount = stageCount
          options.emitOutput('info', `[${repository}] ${stage}${stageCount > 0 ? `（已处理 ${stageCount} 项）` : ''}`)
        }
        const parsed = packageManagerProgress(
          text,
          currentPercent(DOWNLOAD_PROGRESS_FLOOR),
          npmFetchedCount - npmFetches,
          npmPlacedCount - npmPlacements,
        )
        if (!parsed || (parsed.indeterminate && measured)) return
        if (!parsed.indeterminate) measured = true
        emit({ repository, kind, phase: 'downloading', ...parsed })
      },
      stop: () => clearInterval(heartbeat),
    }
  }

  /** 调用官方 DSH CLI 的 plugin 子命令。profileName 用于把插件装进指定 Profile。 */
  async function runPluginCommand(
    args: string[],
    installingRepository?: string,
    allowBuildRetry = true,
    profileName?: string,
    approvedRegistryBuildKeys: string[] = [],
    deniedRegistryBuildKeys: string[] = [],
  ): Promise<void> {
    const settings = await options.readSettings()
    const targetProfile = profileName ?? settings.profileName
    const network = buildNetworkEnvironment(settings)
    const nodeRuntime = await prepareNode(installingRepository)
    const pnpmRuntime = await preparePnpm(nodeRuntime, installingRepository)
    const executable = resolveNodeExecutable(settings.launchExecutable, nodeRuntime)
    const commandArgs = buildPluginCommandArgs(settings, executable, args, targetProfile)
    const workspacePath = path.join(settings.dshHome, 'profiles', targetProfile, 'pnpm-workspace.yaml')
    if (deniedRegistryBuildKeys.length > 0) await mkdir(path.dirname(workspacePath), { recursive: true })
    if (deniedRegistryBuildKeys.length > 0) await denyBuildKeys(workspacePath, deniedRegistryBuildKeys)
    await syncProfilePnpmConfig(path.join(settings.dshHome, 'profiles', targetProfile), network.npmRegistry, options.packageStoreRoot)

    const commandEnvironment = withGitOnPath(withExecutableDirectoryOnPath(
      pnpmRuntime.executable,
      withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        ...network.proxy,
        npm_config_registry: network.npmRegistry,
        NPM_CONFIG_REGISTRY: network.npmRegistry,
        DSH_HOME: settings.dshHome,
        // DSH 内部会同步调用 pnpm。明确告诉 npm/pnpm 当前没有 TTY，
        // 避免 allow-builds、清理确认或下载提示把安装挂在 stdin 上。
        CI: 'true',
        npm_config_yes: 'true',
        NPM_CONFIG_YES: 'true',
        PNPM_CONFIG_YES: 'true',
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        ...(options.packageStoreRoot ? { npm_config_store_dir: options.packageStoreRoot, NPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
        ...(options.packageStoreRoot ? { pnpm_config_store_dir: options.packageStoreRoot, PNPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
        FORCE_COLOR: '0',
      }),
    ))

    // A GitHub dependency makes pnpm invoke Git before it can emit useful
    // package progress. Fail immediately with an actionable message instead
    // of waiting through pnpm's network retries and then showing its generic
    // allow-builds hint.
    if (args.some(isGitHostedSpecifier) && !resolveGit(commandEnvironment)) {
      const message = gitUnavailableMessage()
      options.emitOutput('error', message)
      throw new Error(message)
    }

    options.emitOutput('info', `插件操作：${args.join(' ')}`)
    if (installingRepository) {
      emit({ repository: installingRepository, kind: 'plugin', phase: 'resolving', percent: 18, message: '正在解析插件仓库' })
    }

    const tracker = installingRepository
      ? trackPackageProgress(installingRepository, 'plugin', '正在下载并安装插件')
      : null

    let result
    try {
      result = await executeCommand(executable, commandArgs, {
        cwd: settings.workspace,
        env: commandEnvironment,
        inactivityTimeoutMs: INSTALL_COMMAND_IDLE_TIMEOUT_MS,
        onOutput: (text, level: OutputLevel) => {
          options.emitOutput(level, text)
          tracker?.handleOutput(text)
        },
      })
    } finally {
      tracker?.stop()
    }

    if (result.exitCode !== 0 && isGitUnavailableOutput(result.output)) {
      const message = gitUnavailableMessage()
      options.emitOutput('error', message)
      throw new Error(message)
    }

    // pnpm 升级后，旧 Profile 的 node_modules 可能还链着旧版 store（ERR_PNPM_UNEXPECTED_STORE）。
    // 按 pnpm 的提示在 Profile 里跑一次 `pnpm install` 迁移到当前 store，然后重试一次。
    if (result.exitCode !== 0 && installingRepository && allowBuildRetry && result.output.includes('ERR_PNPM_UNEXPECTED_STORE')) {
      const profilePath = path.join(settings.dshHome, 'profiles', targetProfile)
      options.emitOutput('info', '检测到 pnpm store 版本升级，正在迁移 Profile 依赖后自动重试。')
      emit({
        repository: installingRepository,
        kind: 'plugin',
        phase: 'configuring',
        percent: Math.max(78, currentPercent(78)),
        message: '正在迁移插件依赖（pnpm store 升级）',
      })
      const migrate = await executeCommand(pnpmRuntime.executable, ['install'], {
        cwd: profilePath,
        env: withGitOnPath(withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          ...network.proxy,
          npm_config_registry: network.npmRegistry,
          NPM_CONFIG_REGISTRY: network.npmRegistry,
          CI: 'true',
          npm_config_yes: 'true',
          NPM_CONFIG_YES: 'true',
          PNPM_CONFIG_YES: 'true',
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
          DSH_HOME: settings.dshHome,
          ...(options.packageStoreRoot ? { npm_config_store_dir: options.packageStoreRoot, NPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
          ...(options.packageStoreRoot ? { pnpm_config_store_dir: options.packageStoreRoot, PNPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
          FORCE_COLOR: '0',
        })),
        inactivityTimeoutMs: INSTALL_COMMAND_IDLE_TIMEOUT_MS,
        onOutput: (text, level: OutputLevel) => options.emitOutput(level, text),
      })
      if (migrate.exitCode === 0) {
        options.emitOutput('info', 'Profile 依赖已迁移到当前 pnpm store，正在重试安装。')
        return runPluginCommand(args, installingRepository, false, profileName, approvedRegistryBuildKeys, deniedRegistryBuildKeys)
      }
      throw new Error(`插件依赖迁移失败（代码 ${migrate.exitCode}），请查看运行日志。`)
    }

    // pnpm 默认拒绝执行依赖里的构建脚本。这里等价于 `pnpm approve-builds`，
    // 批准 pnpm 报告的全部被忽略构建脚本后自动重试一次。
    if (result.exitCode !== 0 && installingRepository && allowBuildRetry && result.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
      const workspacePath = path.join(settings.dshHome, 'profiles', targetProfile, 'pnpm-workspace.yaml')
      const approved = await approveAllIgnoredBuilds(workspacePath, result.output)
      if (approved.length > 0) {
        options.emitOutput('info', `已允许 ${approved.length} 个被忽略的构建脚本，正在自动重试。`)
        emit({
          repository: installingRepository,
          kind: 'plugin',
          phase: 'configuring',
          percent: Math.max(82, currentPercent(82)),
          message: '已确认构建权限，正在重新安装',
        })
        return runPluginCommand(args, installingRepository, false, profileName, approvedRegistryBuildKeys, deniedRegistryBuildKeys)
      }
    }

    if (result.exitCode !== 0) {
      const diagnostics = result.output.slice(-4_000).trim()
      throw new Error(`插件操作失败（代码 ${result.exitCode}）。${diagnostics ? `\n${diagnostics}` : ' 请查看运行日志。'}`)
    }
    options.emitOutput('success', '插件操作完成。')
  }

  /**
   * Local and vendored plugin sources are installed through a `file:` specifier.
   * pnpm does not run an arbitrary `build` script for those sources, so a source
   * package that declares a generated Bundle patch can otherwise be linked into
   * the Profile without its `dist` output. Build it before creating the specifier.
   */
  const ensureLocalPluginBuild = async (directory: string, repository: string, packageName: string): Promise<void> => {
    const manifestPath = path.join(directory, 'package.json')
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    } catch (error) {
      throw new Error(`无法读取本地插件 ${packageName} 的 package.json：${error instanceof Error ? error.message : String(error)}`)
    }

    const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh as Record<string, unknown> : null
    const bundle = dsh?.bundle && typeof dsh.bundle === 'object' ? dsh.bundle as Record<string, unknown> : null
    const patch = typeof bundle?.patch === 'string' ? bundle.patch.trim() : ''
    if (!patch) return

    const resolvedDirectory = path.resolve(directory)
    const patchPath = path.resolve(directory, patch)
    if (patchPath !== resolvedDirectory && !patchPath.startsWith(`${resolvedDirectory}${path.sep}`)) {
      throw new Error(`插件 ${packageName} 的 Bundle 补丁路径超出了源码目录。`)
    }
    if (existsSync(patchPath)) return

    const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts as Record<string, unknown> : null
    const buildScript = typeof scripts?.build === 'string' ? scripts.build.trim() : ''
    if (!buildScript) {
      throw new Error(`插件 ${packageName} 声明了 ${patch}，但构建产物不存在，且没有 build 脚本。`)
    }

    const settings = await options.readSettings()
    const nodeRuntime = await prepareNode(repository)
    const pnpmRuntime = await preparePnpm(nodeRuntime, repository)
    const environment = withExecutableDirectoryOnPath(pnpmRuntime.executable, withExecutableDirectoryOnPath(nodeRuntime.node, {
      ...process.env,
      DSH_HOME: settings.dshHome,
      CI: 'true',
      npm_config_yes: 'true',
      NPM_CONFIG_YES: 'true',
      PNPM_CONFIG_YES: 'true',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      ...(options.packageStoreRoot ? { npm_config_store_dir: options.packageStoreRoot, NPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
      ...(options.packageStoreRoot ? { pnpm_config_store_dir: options.packageStoreRoot, PNPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
      FORCE_COLOR: '0',
    }))
    const tracker = trackPackageProgress(repository, 'plugin', `正在准备 ${packageName} 构建环境`)
    try {
      options.emitOutput('info', `[${repository}] ${packageName} 的构建产物 ${patch} 不存在，准备执行 build。`)
      emit({ repository, kind: 'plugin', phase: 'configuring', percent: Math.max(32, currentPercent(32)), message: `正在准备 ${packageName} 构建环境` })

      // A GitHub/archive source normally has no node_modules. Install the
      // source workspace dependencies before running its build script. Keep
      // the install non-interactive and use the launcher's shared store.
      if (!existsSync(path.join(directory, 'node_modules'))) {
        const dependencyInstall = await executeCommand(pnpmRuntime.executable, [
          'install',
          '--dir', directory,
          '--no-frozen-lockfile',
          '--config.auto-install-peers=false',
          ...(options.packageStoreRoot ? ['--store-dir', options.packageStoreRoot] : []),
        ], {
          cwd: directory,
          env: environment,
          inactivityTimeoutMs: INSTALL_COMMAND_IDLE_TIMEOUT_MS,
          onOutput: (text, level: OutputLevel) => {
            options.emitOutput(level, text)
            tracker.handleOutput(text)
          },
        })
        if (dependencyInstall.exitCode !== 0) {
          throw new Error(`插件 ${packageName} 构建依赖安装失败（代码 ${dependencyInstall.exitCode}），请查看运行日志。`)
        }
      }

      emit({ repository, kind: 'plugin', phase: 'configuring', percent: Math.max(58, currentPercent(58)), message: `正在构建 ${packageName}` })
      const build = await executeCommand(pnpmRuntime.executable, ['run', 'build'], {
        cwd: directory,
        env: environment,
        inactivityTimeoutMs: INSTALL_COMMAND_IDLE_TIMEOUT_MS,
        onOutput: (text, level: OutputLevel) => {
          options.emitOutput(level, text)
          tracker.handleOutput(text)
        },
      })
      if (build.exitCode !== 0) {
        throw new Error(`插件 ${packageName} 构建失败（代码 ${build.exitCode}），请查看运行日志。`)
      }
    } finally {
      tracker.stop()
    }

    if (!existsSync(patchPath)) {
      throw new Error(`插件 ${packageName} 构建完成，但仍未生成 ${patch}。`)
    }
    options.emitOutput('success', `[${repository}] ${packageName} 构建完成，已生成 ${patch}。`)
  }

  /** npm 精确版本失效时只对该包回退到 registry 的 latest。 */
  async function runNpmPluginCommand(
    packageName: string,
    version: string | null | undefined,
    repository: string,
    profileName: string,
    approvedBuildKeys: string[] = [],
    deniedBuildKeys: string[] = [],
  ): Promise<boolean> {
    const exactSpecifier = version ? `${packageName}@${version}` : packageName
    try {
      await runPluginCommand(['add', exactSpecifier], repository, true, profileName, approvedBuildKeys, deniedBuildKeys)
      return false
    } catch (error) {
      if (!version || !isNpmVersionUnavailableError(error, packageName, version)) throw error
      options.emitOutput('info', `npm 未找到 ${packageName}@${version}，正在尝试安装 latest。`)
      emit({
        repository,
        kind: 'plugin',
        phase: 'resolving',
        percent: Math.max(12, currentPercent(12)),
        message: `版本 ${version} 不存在，正在尝试 npm latest`,
      })
      await runPluginCommand(['add', packageName], repository, true, profileName, approvedBuildKeys, deniedBuildKeys)
      return true
    }
  }

  /** 把 DSH 本体装进启动器自己的运行目录，并把启动命令切过去。 */
  async function installManagedDsh(repository: string): Promise<RepositoryInstallResult> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再安装或更新本地 DSH。')

    const settings = await options.readSettings()
    let selectedVersion: string | null = null
    try {
      const available = await listAvailableDshVersions(options.githubFetch, dshRegistryCandidates(buildNetworkEnvironment(settings).npmRegistry))
      selectedVersion = selectedVersion
        ?? available.find(candidate => candidate.label === 'latest')?.version
        ?? available.find(candidate => !candidate.prerelease)?.version
        ?? available[0]?.version
        ?? (settings.dshVersion ? normalizeDshVersion(settings.dshVersion) : null)
    } catch (error) {
      // 首次部署不能因版本索引暂时不可用而阻塞；没有精确选择时回落到旧单目录和 npm latest。
      selectedVersion = settings.dshVersion ? normalizeDshVersion(settings.dshVersion) : null
      options.emitOutput('info', `读取 DSH 版本列表失败，回落到 npm latest：${error instanceof Error ? error.message : String(error)}`)
    }
    const runtimeRoot = selectedVersion ? dshVersionRoot(settings.dshInstallPath, selectedVersion) : settings.dshInstallPath
    // 选中的发布版本与已安装版本一致时直接认定已是最新，而不是对现有目录重跑一次安装。
    // 已装目录可能由 pnpm 管理（node_modules 走 junction 链接），npm 重装同一布局会
    // 在依赖树解析阶段崩溃（@npmcli/arborist Link.matches：Cannot read properties of null）。
    if (selectedVersion) {
      const existing = await getManagedDshStatus(runtimeRoot)
      if (existing.installed && existing.version && normalizeDshVersion(existing.version) === normalizeDshVersion(selectedVersion)) {
        options.emitOutput('info', `本地 DSH ${existing.version} 已是最新发布版本，无需重新安装。`)
        const profile = await readProfile(settings.dshHome, settings.profileName, options.pluginReceiptsPath)
        emit({ repository, kind: 'dsh', phase: 'complete', percent: 100, message: `DSH ${existing.version} 已是最新版本` })
        return { kind: 'dsh', profile, settings, dshInstallation: existing }
      }
    }
    await mkdir(runtimeRoot, { recursive: true })
    const manifestPath = path.join(runtimeRoot, 'package.json')
    if (!existsSync(manifestPath)) {
      await writeFile(manifestPath, `${JSON.stringify({ name: 'dsh-launcher-runtime', private: true }, null, 2)}\n`, 'utf8')
    }
    await ensureDshScriptPolicy(manifestPath)

    const nodeRuntime = await prepareNode(repository)
    emit({ repository, kind: 'dsh', phase: 'resolving', percent: 18, message: '正在解析 DSH 安装包' })

    const tracker = trackPackageProgress(repository, 'dsh', '正在下载并安装 DSH')
    let result
    try {
      result = await executeCommand(nodeRuntime.npm, [
        'install',
        '--prefix', runtimeRoot,
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--progress=true',
        // 启动器没有交互式 TTY；显式打开 verbose/foreground 输出，
        // 让运行日志保留 npm 的 registry 请求、依赖解析和安装脚本原文。
        '--loglevel=verbose',
        '--foreground-scripts',
        selectedVersion ? `${DSH_PACKAGE_NAME}@${selectedVersion}` : `${DSH_PACKAGE_NAME}@latest`,
      ], {
        cwd: runtimeRoot,
        env: withGitOnPath(withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          FORCE_COLOR: '0',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          CI: 'true',
          npm_config_yes: 'true',
          NPM_CONFIG_YES: 'true',
          COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        })),
        inactivityTimeoutMs: INSTALL_COMMAND_IDLE_TIMEOUT_MS,
        onOutput: (text, level: OutputLevel) => {
          options.emitOutput(level, text)
          tracker.handleOutput(text)
        },
      })
      if (result.exitCode === 0 && hasDshScriptPackage(runtimeRoot)) {
        emit({ repository, kind: 'dsh', phase: 'configuring', percent: 90, message: '正在执行 DSH 核心依赖安装脚本' })
        options.emitOutput('info', `正在执行 ${DSH_SUBPROCESS_LOCAL_PACKAGE} 的安装脚本。`)
        const rebuild = await executeCommand(nodeRuntime.npm, [
          'rebuild',
          '--prefix', runtimeRoot,
          '--foreground-scripts',
          '--loglevel=verbose',
          DSH_SUBPROCESS_LOCAL_PACKAGE,
        ], {
          cwd: runtimeRoot,
          env: withGitOnPath(withExecutableDirectoryOnPath(nodeRuntime.node, {
            ...process.env,
            FORCE_COLOR: '0',
            NPM_CONFIG_UPDATE_NOTIFIER: 'false',
            CI: 'true',
            npm_config_yes: 'true',
            NPM_CONFIG_YES: 'true',
            COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
          })),
          inactivityTimeoutMs: INSTALL_COMMAND_IDLE_TIMEOUT_MS,
          onOutput: (text, level: OutputLevel) => {
            options.emitOutput(level, text)
            tracker.handleOutput(text)
          },
        })
        if (rebuild.exitCode !== 0) {
          throw new Error(`DSH 核心依赖安装脚本失败（代码 ${rebuild.exitCode}），请查看运行日志。`)
        }
      }
    } finally {
      tracker.stop()
    }
    if (result.exitCode !== 0) throw new Error(`本地 DSH 安装失败（代码 ${result.exitCode}），请查看运行日志。`)

    emit({ repository, kind: 'dsh', phase: 'configuring', percent: 90, message: '正在切换本地启动命令' })
    const dshInstallation = await getManagedDshStatus(runtimeRoot)
    if (!dshInstallation.installed || !dshInstallation.executable) {
      throw new Error('安装完成，但没有找到本地 DSH 可执行文件。')
    }

    const saved = await options.saveSettings({
      ...settings,
      dshVersion: dshInstallation.version ? normalizeDshVersion(dshInstallation.version) : selectedVersion,
      launchExecutable: dshInstallation.executable,
      launchArgs: ['web'],
    })
    const profile = await readProfile(saved.dshHome, saved.profileName, options.pluginReceiptsPath)
    emit({
      repository,
      kind: 'dsh',
      phase: 'complete',
      percent: 100,
      message: `DSH ${dshInstallation.version ?? ''} 已安装`,
    })
    return { kind: 'dsh', profile, settings: saved, dshInstallation }
  }

  /** 安装完成后用 --dump-config 验证插件组合可被 DSH 正常解析。 */
  const verifyProfileComposition = async (profileName: string, repository: string): Promise<void> => {
    const settings = await options.readSettings()
    const nodeRuntime = await options.prepareNodeRuntime()
    const executable = resolveNodeExecutable(settings.launchExecutable, nodeRuntime)
    const packageIndex = settings.launchArgs.indexOf(DSH_PACKAGE_NAME)
    const prefix = packageIndex >= 0
      ? settings.launchArgs.slice(0, packageIndex + 1)
      : path.basename(executable).toLowerCase().startsWith('dsh')
        ? []
        : ['--yes', DSH_PACKAGE_NAME]
    const result = await executeCommand(executable, [...prefix, '--profile', profileName, '--dump-config'], {
      cwd: settings.workspace,
      env: withGitOnPath(withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        DSH_HOME: settings.dshHome,
        FORCE_COLOR: '0',
      })),
      onOutput: (text, level: OutputLevel) => options.emitOutput(level, text),
    })
    if (result.exitCode !== 0) {
      const diagnostics = result.output.slice(-8_000).trim()
      throw new Error(`插件已安装，但组合验证失败。${diagnostics ? `\n${diagnostics}` : ''}`)
    }
  }

  return {
    isBusy: () => active !== null,

    detectDsh,
    checkDshUpdate: checkForDshUpdate,

    async install(fullName: string): Promise<RepositoryInstallResult> {
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      const kind = isDshRepository(fullName) ? 'dsh' : 'plugin'
      emit({
        repository: fullName,
        kind,
        phase: 'preparing',
        percent: 5,
        message: kind === 'dsh' ? '正在准备本地 DSH' : '正在准备安装插件',
      })
      try {
        if (kind === 'dsh') return await installManagedDsh(fullName)

        await runPluginCommand(['add', `github:${fullName}`], fullName)
        emit({ repository: fullName, kind, phase: 'configuring', percent: 90, message: '正在更新插件配置' })
        const settings = await options.readSettings()
        await syncInstalledPluginPool(settings.dshHome)
        const profile = await readProfile(settings.dshHome, settings.profileName, options.pluginReceiptsPath)
        const dshInstallation = await detectDsh()
        emit({ repository: fullName, kind, phase: 'complete', percent: 100, message: '插件安装完成' })
        return { kind, profile, settings, dshInstallation }
      } catch (error) {
        emit({
          repository: fullName,
          kind,
          phase: 'error',
          percent: currentPercent(0),
          message: error instanceof Error ? error.message : '安装失败',
        })
        throw error
      } finally {
        active = null
      }
    },

    async remove(packageName: string, profileName?: string, removeOptions?: { purgeStore?: boolean }): Promise<ProfileState> {
      if (active) throw new Error(`正在执行 ${active.repository}，请等待当前任务完成。`)
      const settings = await options.readSettings()
      if (removeOptions?.purgeStore && (!options.packageStoreRoot || !options.purgePnpmStore)) {
        throw new Error('当前安装器未配置可用的受控 pnpm store，无法执行彻底清除。')
      }
      const currentProfile = settings.profileName
      const receipts = await readPluginReceipts(options.pluginReceiptsPath).catch(() => [])
      const receiptProfiles = receipts
        .filter(receipt => receipt.packageName === packageName && isSafeProfileName(receipt.profileName))
        .map(receipt => receipt.profileName)

      // `purgeStore` 是“彻底清除”语义：无论请求来自哪个 Profile，
      // 都必须先解除所有 Profile 的依赖和激活引用，再回收共享本体/缓存。
      // 未开启 purgeStore 的内部调用仍保留单 Profile 语义。
      const purgeAllProfiles = removeOptions?.purgeStore === true
      const targetProfiles = new Set<string>(
        purgeAllProfiles || !profileName
          ? [currentProfile, ...(profileName && isSafeProfileName(profileName) ? [profileName] : []), ...receiptProfiles]
          : [profileName],
      )
      if (purgeAllProfiles || !profileName) {
        try {
          const entries = await readdir(path.join(settings.dshHome, 'profiles'), { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory() && isSafeProfileName(entry.name)) targetProfiles.add(entry.name)
          }
        } catch {
          // profiles 目录尚未创建时仍保留当前 Profile 作为唯一候选。
        }
      }

      const failures: string[] = []
      // Keep the source references before removing receipts. They are needed
      // to safely delete GitHub snapshots/release archives only after every
      // Profile link and receipt for this package has been handled.
      const removedReceipts = receipts.filter(receipt => (
        receipt.packageName === packageName && targetProfiles.has(receipt.profileName)
      ))
      const removedFileReferences: string[] = []
      try {
        // Uninstall is a local manifest operation. Calling DSH/pnpm here would
        // re-resolve every remaining dependency and can unexpectedly contact
        // npm/GitHub, so each Profile is edited directly instead.
        for (const targetProfile of targetProfiles) {
          let profile: ProfileState | null = null
          try {
            profile = await readProfile(settings.dshHome, targetProfile, options.pluginReceiptsPath)
          } catch {
            // 清理安装回执仍可继续；损坏的 Profile 不应阻塞其他 Profile 的卸载。
          }
          const installed = profile?.plugins.some(item => item.packageName === packageName && !item.builtin) ?? false
          const hasReceipt = receiptProfiles.includes(targetProfile)
          const directPackagePath = path.join(
            settings.dshHome,
            'profiles',
            targetProfile,
            'node_modules',
            ...packageName.split('/'),
          )
          const linked = existsSync(directPackagePath)
          let declared = false
          try {
            const manifestPath = path.join(settings.dshHome, 'profiles', targetProfile, 'package.json')
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
              dependencies?: Record<string, unknown>
              devDependencies?: Record<string, unknown>
              optionalDependencies?: Record<string, unknown>
              peerDependencies?: Record<string, unknown>
              dsh?: { profile?: { bundles?: unknown } }
            }
            declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(field => {
              const dependencies = manifest[field as keyof typeof manifest]
              return dependencies && typeof dependencies === 'object'
                && Object.prototype.hasOwnProperty.call(dependencies, packageName)
            }) || (Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(packageName))
          } catch (error) {
            // A missing manifest means an uninitialized Profile. A malformed
            // or unreadable one cannot be proven free of this package, so a
            // global purge must not reclaim shared bodies/caches underneath it.
            if (purgeAllProfiles && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
              failures.push(`${targetProfile}: 无法读取 Profile 配置：${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            // A malformed Profile is still handled when it has a receipt; the
            // direct manifest check below prevents healthy-but-unlinked
            // Profiles from being skipped.
          }

          // A purge scans every Profile, but only profiles that actually
          // reference the package need to be edited. An explicit non-purge
          // request still targets its named Profile even when its manifest is
          // stale, so removePluginFromProfile can perform the final check.
          if ((purgeAllProfiles || !profileName) && !installed && !declared && !hasReceipt && !linked) continue

          // Legacy local installs may not record their concrete source path in
          // the receipt. Capture the target's `file:` dependency now; after a
          // successful uninstall it becomes an eligible launcher cache.
          try {
            const manifestPath = path.join(settings.dshHome, 'profiles', targetProfile, 'package.json')
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
            for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
              const dependencies = manifest[field]
              if (!dependencies || typeof dependencies !== 'object') continue
              const reference = resolveFileDependency(manifestPath, (dependencies as Record<string, unknown>)[packageName])
              if (reference) removedFileReferences.push(reference)
            }
          } catch {
            // removePluginFromProfile below reports any manifest failure.
          }

          let removed = false
          try {
            removed = await removePluginFromProfile(settings.dshHome, targetProfile, packageName)
          } catch (error) {
            failures.push(`${targetProfile}: ${error instanceof Error ? error.message : String(error)}`)
            continue
          }

          // A complete purge must never proceed to shared-store cleanup while
          // a Profile that was known to reference the package remains intact.
          // Treat an unexpected no-op as a per-Profile failure instead of
          // silently deleting its receipt and claiming global removal.
          if (purgeAllProfiles && (installed || declared || linked) && !removed) {
            failures.push(`${targetProfile}: 未能解除对 ${packageName} 的引用`)
            continue
          }

          if (removed) options.emitOutput('success', `[${targetProfile}] ${packageName} 已从本地 Profile 清理。`)
          await removePluginReceipt(options.pluginReceiptsPath, targetProfile, packageName)
        }

        if (failures.length === 0) {
          const removedBody = await removeUnusedSharedPluginBodies(settings.dshHome, packageName)
          if (removedBody) options.emitOutput('success', `${packageName} 已从共享插件本体池删除。`)
          else options.emitOutput('info', `${packageName} 的共享本体仍被其他 Profile 引用，已保留。`)

          // pnpm 的 store 是内容寻址缓存，不能按目录名直接删除。只有用户
          // 明确选择“彻底卸载”时才运行离线 prune，让 pnpm 根据所有 Profile
          // 的引用关系回收目标插件及其不再使用的传递依赖。
          if (removeOptions?.purgeStore && options.packageStoreRoot && options.purgePnpmStore) {
            try {
              const remainingReceipts = await readPluginReceipts(options.pluginReceiptsPath).catch(() => [])
              const removedSources = await purgeUnusedPluginSources({
                sourceRoot: options.pluginSourceRoot,
                removedReceipts,
                remainingReceipts,
                removedFileReferences,
                profileRoot: path.join(settings.dshHome, 'profiles'),
              })
              if (removedSources.length > 0) {
                options.emitOutput('success', `已清理 ${removedSources.length} 个插件源码缓存。`)
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              options.emitOutput('error', `插件源码缓存清理失败：${detail}`)
              throw new Error(`插件已从 Profile 卸载，但源码缓存清理失败：${detail}`)
            }
            options.emitOutput('info', '正在离线清理未被 Profile 引用的 pnpm 缓存…')
            try {
              await options.purgePnpmStore(options.packageStoreRoot)
              options.emitOutput('success', `${packageName} 的未引用 pnpm 缓存已清理。`)
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              options.emitOutput('error', `pnpm 缓存清理失败：${detail}`)
              throw new Error(`插件已从 Profile 卸载，但 pnpm 缓存清理失败：${detail}`)
            }
          }
        }

        if (failures.length > 0) {
          throw new Error(`插件未能从所有本机 Profile 完全卸载：${failures.join('；')}`)
        }
        return readProfile(settings.dshHome, profileName ?? currentProfile, options.pluginReceiptsPath)
      } finally {
        active = null
      }
    },

    analyzePlugin,

    analyzeSkill,

    analyzeSkillArchive,

    analyzeApplication,

    analyzeCatalogRepository,

    async readInstalledSkills(): Promise<InstalledSkill[]> {
      const settings = await options.readSettings()
      const [skills, receipts] = await Promise.all([
        readLocalSkills(settings.dshHome),
        readSkillReceipts(options.skillReceiptsPath),
      ])
      return skills.map(skill => {
        const receipt = receipts.find(item => item.name === skill.name)
        return receipt
          ? { ...skill, repository: receipt.repository, sourcePath: receipt.sourcePath, revision: receipt.revision }
          : skill
      })
    },

    async toggleSkill(name: string, enabled: boolean): Promise<InstalledSkill[]> {
      const settings = await options.readSettings()
      return toggleInstalledSkill(settings.dshHome, name, Boolean(enabled))
    },

    async listInstalledRepositories(): Promise<string[]> {
      const settings = await options.readSettings()
      const profile = await readProfile(settings.dshHome, settings.profileName, options.pluginReceiptsPath)
      const receipts = await readPluginReceipts(options.pluginReceiptsPath)
      const repositories = new Set<string>()
      for (const plugin of profile.plugins) {
        if (plugin.repositoryFullName) repositories.add(plugin.repositoryFullName)
      }
      for (const receipt of receipts) repositories.add(receipt.repository)
      return [...repositories]
    },

    async installPluginTarget(
      request: {
        repository: string
        defaultBranch: string
        targetId: string
        /** 整合包声明的固定 commit（github 源），覆盖重新分析得到的 HEAD commit。 */
        commit?: string
        /** 整合包声明的固定版本（npm 源），覆盖重新分析得到的版本。 */
        version?: string
        /** release 源插件：meta-repo 分析得到的 tgz 直链，覆盖重分析得到的 github 源。 */
        tarballUrl?: string
        /** 清单声明的来源，优先于重新分析得到的候选来源。 */
        source?: 'npm' | 'github'
      },
      profileOverride?: string,
    ): Promise<RepositoryInstallResult> {
      const fullName = request.repository
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository: fullName, kind: 'plugin', phase: 'preparing', percent: 5, message: '正在检查插件结构' })
      const temporaryArtifacts: string[] = []
      try {
        const analysis = await analyzePlugin(fullName, request.defaultBranch)
        const found = analysis.targets.find(item => item.id === request.targetId)
        if (!found) throw new Error(analysis.summary || '所选插件组件已经失效，请重新检测仓库。')
        const target = { ...found }
        // A distribution manifest is authoritative about whether a component
        // is npm- or GitHub-backed. A repository may publish a same-named npm
        // package, but that must not silently replace a pinned Git source.
        if (request.source === 'github') target.source = 'github'
        if (request.source === 'npm') target.source = 'npm'
        // 尊重整合包声明的 pin：仓库已前进时仍按导出时的 commit / version 安装。
        if (request.commit && target.source === 'github') target.commit = request.commit
        if (request.version && target.source === 'npm') target.version = request.version
        // release 源插件：meta-repo 分析已解析出官方 tgz，覆盖重分析得到的 github 源。
        if (request.tarballUrl && target.source === 'github') {
          target.source = 'release'
          target.tarballUrl = request.tarballUrl
        }
        const profileName = resolveInstallProfile(target, profileOverride)

        let specifier: string
        // pnpm's Git fetcher requires a system Git executable. When the
        // launcher is running on a machine without Git, use the immutable
        // GitHub archive for the already-pinned commit instead. This keeps the
        // install deterministic and still runs the same local Bundle build and
        // validation steps.
        let installedSource = target.source
        let installedActualSource: 'market' | 'npm' | 'github' | 'local' | undefined = target.source === 'github' ? 'github' : undefined
        // Keep the archive fallback in one place. Besides machines where Git
        // is absent from PATH, this is also used when a stale/broken Git path
        // was detected as present but pnpm later reports that it cannot start
        // Git. The archive is pinned to the same commit, so the install stays
        // deterministic and does not silently move to the branch head.
        const prepareGithubArchive = async (): Promise<string> => {
          if (!options.githubFetch) throw new Error(gitUnavailableMessage())
          const onProgress = (progress: PluginSourceProgress) =>
            emit({ repository: fullName, kind: 'plugin', phase: 'downloading', ...progress })
          const packageDirectory = await prepareSubdirectoryPlugin(
            options.pluginSourceRoot,
            fullName,
            target,
            onProgress,
            options.githubFetch,
          )
          await ensureLocalPluginBuild(packageDirectory, fullName, target.packageName)
          installedSource = 'archive-subdirectory'
          installedActualSource = 'github'
          options.emitOutput('info', `[${fullName}] Git 不可用，已改用固定 commit 的 GitHub 压缩包安装。`)
          return `file:${packageDirectory}`
        }
        if (target.source === 'npm') {
          specifier = target.version ? `${target.packageName}@${target.version}` : target.packageName
        } else if (target.source === 'github') {
          const gitAvailable = Boolean(resolveGit(process.env))
          if (!gitAvailable && options.githubFetch) {
            specifier = await prepareGithubArchive()
          } else {
            specifier = `github:${fullName}#${target.commit}`
          }
        } else if (target.source === 'release') {
          // 源码 pin 不一定带构建产物，Release tgz 是官方安装包：下载后 `dsh plugin add file:<tgz>`。
          // tgz 会作为 file: 依赖写入 Profile package.json，必须放在持久目录且不能删除，
          // 否则后续 pnpm 操作会因找不到临时文件而失败（ENOENT）。
          if (!target.tarballUrl) throw new Error('Release 插件缺少下载地址。')
          const safePackageName = target.packageName.replace(/[^a-z0-9._-]+/gi, '-')
          const tgzName = `${safePackageName}-${target.version ?? target.commit}.tgz`
          const tgzPath = path.join(options.pluginSourceRoot, tgzName)
          await mkdir(options.pluginSourceRoot, { recursive: true })
          emit({ repository: fullName, kind: 'plugin', phase: 'downloading', percent: 30, message: '正在下载 Release 安装包' })
          const asset = options.githubFetch
            ? await downloadReleaseAsset(target.tarballUrl, MAX_RELEASE_BYTES, undefined, options.githubFetch)
            : await downloadReleaseAsset(target.tarballUrl, MAX_RELEASE_BYTES)
          await writeFile(tgzPath, asset)
          specifier = `file:${tgzPath}`
        } else if (target.source === 'local-directory') {
          const packageDirectory = validateLocalPluginDirectory(target.localDirectory)
          await ensureLocalPluginBuild(packageDirectory, fullName, target.packageName)
          specifier = `file:${packageDirectory}`
        } else {
          const onProgress = (progress: PluginSourceProgress) =>
            emit({ repository: fullName, kind: 'plugin', phase: 'downloading', ...progress })
          const packageDirectory = options.githubFetch
            ? await prepareSubdirectoryPlugin(options.pluginSourceRoot, fullName, target, onProgress, options.githubFetch)
            : await prepareSubdirectoryPlugin(options.pluginSourceRoot, fullName, target, onProgress)
          await ensureLocalPluginBuild(packageDirectory, fullName, target.packageName)
          specifier = `file:${packageDirectory}`
        }

        let usedLatest = false
        if (target.source === 'npm') {
          usedLatest = await runNpmPluginCommand(target.packageName, target.version, fullName, profileName)
        } else {
          try {
            await runPluginCommand(['add', specifier], fullName, true, profileName)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            const gitUnavailable = detail.includes('未找到 Git') || isGitUnavailableOutput(detail)
            if (target.source !== 'github' || !specifier.startsWith('github:') || !gitUnavailable || !options.githubFetch) throw error
            // A Git executable can disappear between detection and pnpm's
            // fetch (or be a stale path). Retry once through the immutable
            // archive instead of leaving a half-written Git dependency behind.
            specifier = await prepareGithubArchive()
            await runPluginCommand(['add', specifier], fullName, true, profileName)
          }
        }
        emit({ repository: fullName, kind: 'plugin', phase: 'configuring', percent: 88, message: '正在核对插件加载顺序' })
        const settings = await options.readSettings()
        const installedProfile = await readProfile(settings.dshHome, profileName, options.pluginReceiptsPath)
        const installedPlugin = installedProfile.plugins.find(plugin => plugin.packageName === target.packageName)
        if (!installedPlugin?.enabled || !installedPlugin.compatible) {
          throw new Error('包已下载，但 DSH 没有把它识别为有效 Bundle。请检查插件清单和补丁文件。')
        }
        if (usedLatest) options.emitOutput('success', `已回退到 npm latest，实际安装版本：${installedPlugin.version ?? '未知'}`)
        emit({ repository: fullName, kind: 'plugin', phase: 'verifying', percent: 94, message: '正在验证插件组合配置' })
        await verifyProfileComposition(profileName, fullName)
        await recordPluginInstall(options.pluginReceiptsPath, {
          repository: fullName,
          packageName: target.packageName,
          profileName,
           source: installedSource,
          subdirectory: target.subdirectory,
          version: usedLatest ? installedPlugin.version ?? null : target.version,
           commit: target.commit,
          defaultBranch: request.defaultBranch,
           targetId: request.targetId,
           installedAt: new Date().toISOString(),
           ...(installedActualSource ? { actualSource: installedActualSource } : {}),
         })
        await syncInstalledPluginPool(settings.dshHome)
        // The receipt is the authoritative source for local `file:` and archive-subdirectory
        // installs. Re-read after recording it so the returned Profile immediately exposes
        // the GitHub repository to the renderer.
        const profile = profileName === settings.profileName
          ? await readProfile(settings.dshHome, profileName, options.pluginReceiptsPath)
          : await readProfile(settings.dshHome, settings.profileName, options.pluginReceiptsPath)
        const dshInstallation = await detectDsh()
        emit({ repository: fullName, kind: 'plugin', phase: 'complete', percent: 100, message: `插件已安装到 ${profileName} Profile` })
        return {
          kind: 'plugin',
          profile,
          settings,
          dshInstallation,
          installedProfileName: profileName,
          packageName: target.packageName,
        }
      } catch (error) {
        emit({
          repository: fullName,
          kind: 'plugin',
          phase: 'error',
          percent: currentPercent(0),
          message: error instanceof Error ? error.message : '安装失败',
        })
        throw error
      } finally {
        for (const file of temporaryArtifacts) await rm(file, { force: true }).catch(() => undefined)
        active = null
      }
    },

    async installNpmPackage(request, profileOverride) {
      if (!isSafePackageName(request.packageName)) throw new Error('npm 插件包名无效。')
      const version = validateNpmVersion(request.version)
      const profileName = profileOverride ?? (await options.readSettings()).profileName
      const repository = request.repository ?? `npm:${request.packageName}`
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository, kind: 'plugin', phase: 'preparing', percent: 5, message: '正在准备 npm 插件' })
      try {
        const usedLatest = await runNpmPluginCommand(
          request.packageName,
          version,
          repository,
          profileName,
          request.approvedBuildKeys ?? [],
          request.deniedBuildKeys ?? [],
        )
        emit({ repository, kind: 'plugin', phase: 'configuring', percent: 88, message: '正在核对插件加载顺序' })
        const settings = await options.readSettings()
        const installedProfile = await readProfile(settings.dshHome, profileName, options.pluginReceiptsPath)
        const installedPlugin = installedProfile.plugins.find(plugin => plugin.packageName === request.packageName)
        if (!installedPlugin?.enabled || !installedPlugin.compatible) {
          throw new Error('包已下载，但 DSH 没有把它识别为有效 Bundle。请检查插件清单和补丁文件。')
        }
        if (usedLatest) options.emitOutput('success', `已回退到 npm latest，实际安装版本：${installedPlugin.version ?? '未知'}`)
        await verifyProfileComposition(profileName, repository)
        await recordPluginInstall(options.pluginReceiptsPath, {
          repository,
          packageName: request.packageName,
          profileName,
          source: 'npm',
          subdirectory: null,
          version: usedLatest ? installedPlugin.version ?? null : version ?? installedPlugin.version ?? null,
          commit: '',
          targetId: request.packageName,
          installedAt: new Date().toISOString(),
        })
        await syncInstalledPluginPool(settings.dshHome)
        const profile = profileName === settings.profileName
          ? await readProfile(settings.dshHome, profileName, options.pluginReceiptsPath)
          : await readProfile(settings.dshHome, settings.profileName, options.pluginReceiptsPath)
        const dshInstallation = await detectDsh()
        emit({ repository, kind: 'plugin', phase: 'complete', percent: 100, message: `插件已安装到 ${profileName} Profile` })
        return { kind: 'plugin', profile, settings, dshInstallation, installedProfileName: profileName, packageName: request.packageName }
      } catch (error) {
        emit({ repository, kind: 'plugin', phase: 'error', percent: currentPercent(0), message: error instanceof Error ? error.message : '安装失败' })
        throw error
      } finally {
        active = null
      }
    },

    async installLocalPlugin(request, profileOverride) {
      if (!isSafePackageName(request.packageName)) throw new Error('本地插件包名无效。')
      const directory = validateLocalPluginDirectory(request.directory)
      const settings = await options.readSettings()
      const profileName = profileOverride ?? settings.profileName
      const repository = request.repository ?? `file:${directory}`
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository, kind: 'plugin', phase: 'preparing', percent: 5, message: '正在准备整合包本地插件' })
      try {
        await ensureLocalPluginBuild(directory, repository, request.packageName)
        await runPluginCommand(['add', `file:${directory}`], repository, true, profileName)
        const installedProfile = await readProfile(settings.dshHome, profileName, options.pluginReceiptsPath)
        const installedPlugin = installedProfile.plugins.find(plugin => plugin.packageName === request.packageName)
        if (!installedPlugin?.compatible) throw new Error('本地插件没有检测到有效 DSH Bundle。')
        await verifyProfileComposition(profileName, repository)
        await recordPluginInstall(options.pluginReceiptsPath, {
          repository,
          packageName: request.packageName,
          profileName,
          source: 'local-directory',
          subdirectory: null,
          version: request.version ?? installedPlugin.version ?? null,
          commit: request.commit ?? '',
          targetId: request.packageName,
          installedAt: new Date().toISOString(),
          actualSource: 'local',
        })
        await syncInstalledPluginPool(settings.dshHome)
        const currentProfile = profileName === settings.profileName
          ? installedProfile
          : await readProfile(settings.dshHome, settings.profileName, options.pluginReceiptsPath)
        emit({ repository, kind: 'plugin', phase: 'complete', percent: 100, message: `本地插件已安装到 ${profileName} Profile` })
        return { kind: 'plugin', profile: currentProfile, settings, dshInstallation: await detectDsh(), installedProfileName: profileName, packageName: request.packageName }
      } catch (error) {
        emit({ repository, kind: 'plugin', phase: 'error', percent: currentPercent(0), message: error instanceof Error ? error.message : '本地插件安装失败' })
        throw error
      } finally { active = null }
    },

    async installSkill(request: SkillInstallRequest): Promise<SkillInstallResult> {
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository: request.repository, kind: 'skill', phase: 'preparing', percent: 5, message: '正在确认 Skill 格式' })
      try {
        const analysis = await analyzeSkill(request.repository, request.defaultBranch)
        const target = analysis.targets.find(item => item.id === request.targetId)
        if (!target) throw new Error(analysis.summary || '所选 Skill 已失效，请重新检测仓库。')
        const settings = await options.readSettings()
        const limits = skillInstallLimits(settings.skillMaxArchiveMb)
        const onProgress = (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) =>
          emit({ repository: request.repository, kind: 'skill', phase: 'downloading', ...progress })
        const installedSkill = options.githubFetch
          ? await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, request.repository, target, onProgress, options.githubFetch, limits)
          : await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, request.repository, target, onProgress, undefined, limits)
        await recordSkillInstall(options.skillReceiptsPath, {
          name: target.name,
          format: target.format,
          repository: request.repository,
          sourcePath: target.sourcePath,
          revision: target.revision,
          installedAt: new Date().toISOString(),
        })
        const installedSkills = await readLocalSkills(settings.dshHome)
        const verified = installedSkills.find(skill => skill.name === target.name)
        if (!verified) throw new Error('文件已写入，但 DSH 没有把它识别为有效 Skill。')
        emit({ repository: request.repository, kind: 'skill', phase: 'complete', percent: 100, message: `${target.name} 已安装` })
        return { installedSkill, installedSkills }
      } catch (error) {
        emit({
          repository: request.repository,
          kind: 'skill',
          phase: 'error',
          percent: currentPercent(0),
          message: error instanceof Error ? error.message : 'Skill 安装失败',
        })
        throw error
      } finally {
        active = null
      }
    },

    /** C 端技能市场安装：直接吃市场分析出的 target，不再走 API 重析（无令牌时 API 会 403）。 */
    async installSkillFromMarket({ repository, target }: { repository: string; target: SkillInstallTarget }): Promise<SkillInstallResult> {
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository, kind: 'skill', phase: 'preparing', percent: 5, message: '正在确认 Skill 格式' })
      try {
        const settings = await options.readSettings()
        const onProgress = (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) =>
          emit({ repository, kind: 'skill', phase: 'downloading', ...progress })
        const installedSkill = options.githubFetch
          ? await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, repository, target, onProgress, options.githubFetch)
          : await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, repository, target, onProgress)
        await recordSkillInstall(options.skillReceiptsPath, {
          name: target.name,
          format: target.format,
          repository,
          sourcePath: target.sourcePath,
          revision: target.revision,
          installedAt: new Date().toISOString(),
        })
        const installedSkills = await readLocalSkills(settings.dshHome)
        const verified = installedSkills.find(skill => skill.name === target.name)
        if (!verified) throw new Error('文件已写入，但 DSH 没有把它识别为有效 Skill。')
        emit({ repository, kind: 'skill', phase: 'complete', percent: 100, message: `${target.name} 已安装` })
        return { installedSkill, installedSkills }
      } catch (error) {
        emit({
          repository,
          kind: 'skill',
          phase: 'error',
          percent: currentPercent(0),
          message: error instanceof Error ? error.message : 'Skill 安装失败',
        })
        throw error
      } finally {
        active = null
      }
    },

    async installSkillPinned({ repository, target }): Promise<InstalledSkill> {
      const settings = await options.readSettings()
      const limits = skillInstallLimits(settings.skillMaxArchiveMb)
      const onProgress = (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) =>
        emit({ repository, kind: 'skill', phase: 'downloading', ...progress })
      const installedSkill = options.githubFetch
        ? await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, repository, target, onProgress, options.githubFetch, limits)
        : await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, repository, target, onProgress, undefined, limits)
      await recordSkillInstall(options.skillReceiptsPath, {
        name: target.name,
        format: target.format,
        repository,
        sourcePath: target.sourcePath,
        revision: target.revision,
        installedAt: new Date().toISOString(),
      })
      return installedSkill
    },

    async installPreset(request: PresetInstallRequest): Promise<PresetInstallResult> {
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository: request.repository, kind: 'preset', phase: 'preparing', percent: 5, message: '正在确认 Agent 预设目录' })
      try {
        // 预设来自 meta-repo 子模块，revision 已钉死为 pin commit（内容不可变），
        // 不需要像插件/Skill 那样重分析 HEAD；下载后仍校验 preset.yml 与名称一致。
        const target: PresetInstallTarget = {
          id: request.targetId,
          name: request.name,
          description: '',
          sourceRepository: request.repository,
          revision: request.revision,
          sourcePath: request.sourcePath,
        }
        const settings = await options.readSettings()
        const onProgress = (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) =>
          emit({ repository: request.repository, kind: 'preset', phase: 'downloading', ...progress })
        const installedPreset = options.githubFetch
          ? await installPresetFromRepository(options.skillSourceRoot, settings.dshHome, request.repository, target, onProgress, options.githubFetch)
          : await installPresetFromRepository(options.skillSourceRoot, settings.dshHome, request.repository, target, onProgress)
        await recordPresetInstall(options.presetReceiptsPath, {
          name: target.name,
          repository: request.repository,
          sourcePath: request.sourcePath,
          revision: request.revision,
          installedAt: new Date().toISOString(),
        })
        const installedPresets = await readLocalPresets(settings.dshHome)
        emit({ repository: request.repository, kind: 'preset', phase: 'complete', percent: 100, message: `${target.name} 已安装` })
        return { installedPreset, installedPresets }
      } catch (error) {
        emit({
          repository: request.repository,
          kind: 'preset',
          phase: 'error',
          percent: currentPercent(0),
          message: error instanceof Error ? error.message : 'Agent 预设安装失败',
        })
        throw error
      } finally {
        active = null
      }
    },

    async readInstalledPresets(): Promise<InstalledPreset[]> {
      const settings = await options.readSettings()
      const [presets, receipts] = await Promise.all([
        readLocalPresets(settings.dshHome),
        readPresetReceipts(options.presetReceiptsPath),
      ])
      return presets.map(preset => {
        const receipt = receipts.find(item => item.name === preset.name)
        return receipt
          ? { ...preset, repository: receipt.repository, sourcePath: receipt.sourcePath, revision: receipt.revision }
          : preset
      })
    },

    async togglePreset(name: string, enabled: boolean): Promise<InstalledPreset[]> {
      const settings = await options.readSettings()
      return toggleInstalledPreset(settings.dshHome, name, Boolean(enabled))
    },

    async uninstallPreset(name: string): Promise<InstalledPreset[]> {
      const settings = await options.readSettings()
      return uninstallInstalledPreset(settings.dshHome, name, options.presetReceiptsPath)
    },
  }
}
