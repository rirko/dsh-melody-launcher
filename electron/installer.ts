import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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
import { dshVersionRoot, findManagedDshVersions, listAvailableDshVersions, normalizeDshVersion } from './runtime-versions'
import { checkDshUpdate } from './dsh-update'
import { resolveNodeExecutable, type NodeRuntime, type NodeRuntimeProgress, type PnpmRuntime } from './node-runtime'
import { approveAllIgnoredBuilds, denyBuildKeys } from './plugin-install'
import { analyzeMetaRepository } from './meta-repo-catalog'
import { analyzeRepository } from './plugin-catalog'
import { prepareSubdirectoryPlugin, type PluginSourceProgress } from './plugin-source'
import { readPluginReceipts, recordPluginInstall, removePluginReceipt } from './plugin-receipts'
import { readPresetReceipts, recordPresetInstall } from './preset-receipts'
import { readSkillReceipts, recordSkillInstall } from './skill-receipts'
import { isSafePackageName, isSafeProfileName, readProfile } from './profile'
import { withExecutableDirectoryOnPath } from './process'
import { analyzeSkillRepository } from './skill-catalog'
import { readInstalledSkills as readLocalSkills, toggleInstalledSkill } from './skill-format'
import { installPresetFromRepository, readInstalledPresets as readLocalPresets, toggleInstalledPreset } from './preset-install'
import { downloadReleaseAsset } from './release-download'
import { installSkillFromRepository } from './skill-install'
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
  /** 所有 GitHub HTTP 请求统一从这里注入认证。 */
  githubFetch?: typeof fetch
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
    },
    profileOverride?: string,
  ): Promise<RepositoryInstallResult>
  /** 直接安装 npm 发布的标准 Bundle；用于没有 GitHub 仓库的清单条目。 */
  installNpmPackage(
    request: { packageName: string; version?: string; repository?: string; approvedBuildKeys?: string[]; deniedBuildKeys?: string[] },
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
  /** 汇总当前 Profile 与安装凭据里已安装的仓库，用于在列表中标记「已安装」。 */
  listInstalledRepositories(): Promise<string[]>
  /** 卸载插件；显式指定 Profile 时只处理该 Profile，否则从本机所有 Profile 清理。 */
  remove(packageName: string, profileName?: string): Promise<ProfileState>
  detectDsh(): Promise<DshInstallationStatus>
  checkDshUpdate(): Promise<DshUpdateStatus>
  isBusy(): boolean
}

/** Node.js 下载进度映射到安装进度的 5% ~ 17% 区间。 */
const NODE_RUNTIME_PROGRESS_FLOOR = 5
const NODE_RUNTIME_PROGRESS_CEILING = 17
const DOWNLOAD_PROGRESS_FLOOR = 28

/** Release 插件 tgz 安装包体积上限（插件可能比 Skill 大，放宽到 256 MiB）。 */
const MAX_RELEASE_BYTES = 256 * 1024 * 1024

export function createInstaller(options: InstallerOptions): Installer {
  let active: InstallProgress | null = null
  const executeCommand = options.runCommand ?? runCommand

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
    return options.githubFetch
      ? checkDshUpdate(installation, options.githubFetch)
      : checkDshUpdate(installation)
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
    const nodeRuntime = await prepareNode(installingRepository)
    const pnpmRuntime = await preparePnpm(nodeRuntime, installingRepository)
    const executable = resolveNodeExecutable(settings.launchExecutable, nodeRuntime)
    const commandArgs = buildPluginCommandArgs(settings, executable, args, targetProfile)
    const workspacePath = path.join(settings.dshHome, 'profiles', targetProfile, 'pnpm-workspace.yaml')
    if (deniedRegistryBuildKeys.length > 0) await mkdir(path.dirname(workspacePath), { recursive: true })
    if (deniedRegistryBuildKeys.length > 0) await denyBuildKeys(workspacePath, deniedRegistryBuildKeys)

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
        env: withExecutableDirectoryOnPath(
          pnpmRuntime.executable,
          withExecutableDirectoryOnPath(nodeRuntime.node, {
            ...process.env,
            DSH_HOME: settings.dshHome,
            ...(options.packageStoreRoot ? { npm_config_store_dir: options.packageStoreRoot, NPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
            ...(options.packageStoreRoot ? { pnpm_config_store_dir: options.packageStoreRoot, PNPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
            FORCE_COLOR: '0',
          }),
        ),
        onOutput: (text, level: OutputLevel) => {
          options.emitOutput(level, text)
          tracker?.handleOutput(text)
        },
      })
    } finally {
      tracker?.stop()
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
        env: withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          CI: 'true',
          DSH_HOME: settings.dshHome,
          ...(options.packageStoreRoot ? { npm_config_store_dir: options.packageStoreRoot, NPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
          ...(options.packageStoreRoot ? { pnpm_config_store_dir: options.packageStoreRoot, PNPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
          FORCE_COLOR: '0',
        }),
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

  /** 把 DSH 本体装进启动器自己的运行目录，并把启动命令切过去。 */
  async function installManagedDsh(repository: string): Promise<RepositoryInstallResult> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再安装或更新本地 DSH。')

    const settings = await options.readSettings()
    let selectedVersion: string | null = null
    try {
      const available = await listAvailableDshVersions(options.githubFetch)
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
        env: withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          FORCE_COLOR: '0',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        }),
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
          env: withExecutableDirectoryOnPath(nodeRuntime.node, {
            ...process.env,
            FORCE_COLOR: '0',
            NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          }),
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
      env: withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        DSH_HOME: settings.dshHome,
        FORCE_COLOR: '0',
      }),
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

    async remove(packageName: string, profileName?: string): Promise<ProfileState> {
      const settings = await options.readSettings()
      const currentProfile = settings.profileName
      const receipts = await readPluginReceipts(options.pluginReceiptsPath).catch(() => [])
      const receiptProfiles = receipts
        .filter(receipt => receipt.packageName === packageName && isSafeProfileName(receipt.profileName))
        .map(receipt => receipt.profileName)

      // 传入 profileName 的调用用于整合包/内部流程，只操作指定 Profile；
      // UI 的普通卸载不传该参数，因此会覆盖本机所有已登记的 Profile。
      const targetProfiles = new Set<string>(profileName ? [profileName] : [currentProfile, ...receiptProfiles])
      if (!profileName) {
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
      for (const targetProfile of targetProfiles) {
        let profile: ProfileState | null = null
        try {
          profile = await readProfile(settings.dshHome, targetProfile, options.pluginReceiptsPath)
        } catch {
          // 清理安装回执仍可继续；损坏的 Profile 不应阻塞其他 Profile 的卸载。
        }
        const installed = profile?.plugins.some(item => item.packageName === packageName && !item.builtin) ?? false
        const hasReceipt = receiptProfiles.includes(targetProfile)

        if (profileName || installed) {
          try {
            await runPluginCommand(['remove', packageName], undefined, true, targetProfile)
          } catch (error) {
            failures.push(`${targetProfile}: ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
        } else if (!hasReceipt) {
          continue
        }
        await removePluginReceipt(options.pluginReceiptsPath, targetProfile, packageName)
      }

      if (failures.length > 0) {
        throw new Error(`插件未能从所有本机 Profile 完全卸载：${failures.join('；')}`)
      }
      return readProfile(settings.dshHome, profileName ?? currentProfile, options.pluginReceiptsPath)
    },

    analyzePlugin,

    analyzeSkill,

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
        if (target.source === 'npm') {
          specifier = target.version ? `${target.packageName}@${target.version}` : target.packageName
        } else if (target.source === 'github') {
          specifier = `github:${fullName}#${target.commit}`
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
          specifier = `file:${validateLocalPluginDirectory(target.localDirectory)}`
        } else {
          const onProgress = (progress: PluginSourceProgress) =>
            emit({ repository: fullName, kind: 'plugin', phase: 'downloading', ...progress })
          const packageDirectory = options.githubFetch
            ? await prepareSubdirectoryPlugin(options.pluginSourceRoot, fullName, target, onProgress, options.githubFetch)
            : await prepareSubdirectoryPlugin(options.pluginSourceRoot, fullName, target, onProgress)
          specifier = `file:${packageDirectory}`
        }

        await runPluginCommand(['add', specifier], fullName, true, profileName)
        emit({ repository: fullName, kind: 'plugin', phase: 'configuring', percent: 88, message: '正在核对插件加载顺序' })
        const settings = await options.readSettings()
        const installedProfile = await readProfile(settings.dshHome, profileName, options.pluginReceiptsPath)
        const installedPlugin = installedProfile.plugins.find(plugin => plugin.packageName === target.packageName)
        if (!installedPlugin?.enabled || !installedPlugin.compatible) {
          throw new Error('包已下载，但 DSH 没有把它识别为有效 Bundle。请检查插件清单和补丁文件。')
        }
        emit({ repository: fullName, kind: 'plugin', phase: 'verifying', percent: 94, message: '正在验证插件组合配置' })
        await verifyProfileComposition(profileName, fullName)
        await recordPluginInstall(options.pluginReceiptsPath, {
          repository: fullName,
          packageName: target.packageName,
          profileName,
          source: target.source,
          subdirectory: target.subdirectory,
          version: target.version,
          commit: target.commit,
          defaultBranch: request.defaultBranch,
          targetId: request.targetId,
          installedAt: new Date().toISOString(),
        })
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
        const specifier = version ? `${request.packageName}@${version}` : request.packageName
        await runPluginCommand(
          ['add', specifier],
          repository,
          true,
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
        await verifyProfileComposition(profileName, repository)
        await recordPluginInstall(options.pluginReceiptsPath, {
          repository,
          packageName: request.packageName,
          profileName,
          source: 'npm',
          subdirectory: null,
          version: version ?? installedPlugin.version ?? null,
          commit: '',
          targetId: request.packageName,
          installedAt: new Date().toISOString(),
        })
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

    async installSkill(request: SkillInstallRequest): Promise<SkillInstallResult> {
      if (active) throw new Error(`正在安装 ${active.repository}，请等待当前任务完成。`)
      emit({ repository: request.repository, kind: 'skill', phase: 'preparing', percent: 5, message: '正在确认 Skill 格式' })
      try {
        const analysis = await analyzeSkill(request.repository, request.defaultBranch)
        const target = analysis.targets.find(item => item.id === request.targetId)
        if (!target) throw new Error(analysis.summary || '所选 Skill 已失效，请重新检测仓库。')
        const settings = await options.readSettings()
        const onProgress = (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) =>
          emit({ repository: request.repository, kind: 'skill', phase: 'downloading', ...progress })
        const installedSkill = options.githubFetch
          ? await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, request.repository, target, onProgress, options.githubFetch)
          : await installSkillFromRepository(options.skillSourceRoot, settings.dshHome, request.repository, target, onProgress)
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

    async installSkillPinned({ repository, target }): Promise<InstalledSkill> {
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
  }
}
