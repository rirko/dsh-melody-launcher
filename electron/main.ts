import { app, BrowserWindow, net, safeStorage, shell } from 'electron'
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppSettings, RuntimeOutput, WindowMode } from '../src/types'
import { ACP_RUNTIME_DIRNAME, CREDENTIALS_LOCK_DIRNAME, createAiInstaller, healCredentialsLock, type AiInstaller } from './ai-install'
import { createApplicationAddonManager, type ApplicationAddonManager } from './application-addons'
import { applyWindowMode, createMainWindow, createRendererChannel } from './app-window'
import { createCatalogSyncService, type CatalogSyncService } from './catalog-sync'
import { createCopilotSessionManager, type CopilotSessionManager } from './copilot-sessions'
import { createDshMarketService, type DshMarketService } from './dsh-market'
import { runCommand } from './command'
import { readDeepSeekApiKey } from './credentials'
import { findInstalledDsh } from './dsh-install'
import { buildPluginCommandArgs, createInstaller, validateLocalPluginDirectory, type Installer } from './installer'
import { registerIpcHandlers } from './ipc'
import { createLauncherUpdater, type LauncherUpdater } from './launcher-update'
import { createGitHubAuthService, type GitHubAuthService } from './github-auth'
import {
  ensureNodeRuntime,
  ensurePnpmRuntime,
  findSystemNodeRuntime,
  resolveNodeExecutable,
  type NodeRuntime,
  type NodeRuntimeProgress,
  type PnpmRuntime,
} from './node-runtime'
import { createProxyAwareFetch } from './network'
import { createPackManager, type InstallInstaller, type PackInstallTarget, type PackManager } from './pack'
import { createPluginTrialManager, type PluginTrialManager } from './plugin-trial'
import { readPluginReceipts, recordPluginInstall } from './plugin-receipts'
import { configureProcessTracker, shutdownTrackedProcesses, withExecutableDirectoryOnPath } from './process'
import { createProcessSupervisor, type ProcessSupervisor } from './process-supervisor'
import { readProfile, reorderPlugins, togglePlugin } from './profile'
import { consolidatePluginPool, createProfileService, ensureProfileWorkspaceConfig, migrateLegacyPacks, type ProfileService } from './profile-service'
import { installPresetFromDirectory } from './preset-install'
import { installSkillFromDirectory } from './skill-install'
import { createRendererEvents } from './renderer-events'
import { createRuntimeController, type RuntimeController } from './runtime'
import { createRuntimeVersionService, type RuntimeVersionService } from './runtime-versions'
import { createSettingsStore, defaultSettings, type SettingsStore } from './settings'
import { recoverLegacyCredentials } from './dsh-credentials-compat'

/**
 * 应用入口与装配根。
 * 这里只负责「谁依赖谁」，具体行为都在各自的模块里。
 */

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let processSupervisor: ProcessSupervisor | null = null
let quitCleanupStarted = false
let allowFinalQuit = false

const getWindow = (): BrowserWindow | null => mainWindow
const events = createRendererEvents(createRendererChannel(getWindow))

interface Services {
  settings: SettingsStore
  pluginReceiptsPath: string
  runtime: RuntimeController
  installer: Installer
  pluginTrial: PluginTrialManager
  aiInstaller: AiInstaller
  copilot: CopilotSessionManager
  packManager: PackManager
  launcherUpdater: LauncherUpdater
  githubAuth: GitHubAuthService
  applicationAddons: ApplicationAddonManager
  catalogSync: CatalogSyncService
  dshMarket: DshMarketService
  runtimeVersions: RuntimeVersionService
  profiles: ProfileService
  profilePoolReady: Promise<void>
}

// app.getPath 依赖 app 就绪，因此服务在 whenReady 之后才装配。
let services: Services | null = null

function createServices(): Services {
  const userData = app.getPath('userData')
  const managedDshRoot = path.join(userData, 'dsh-runtime')
  const managedNodeRoot = path.join(userData, 'node-runtime')
  const managedPnpmRoot = path.join(userData, 'pnpm-runtime')
  const pluginSourceRoot = path.join(userData, 'plugin-sources')
  const pluginReceiptsPath = path.join(userData, 'plugin-installs.json')
  const presetReceiptsPath = path.join(userData, 'preset-installs.json')
  const skillReceiptsPath = path.join(userData, 'skill-installs.json')
  const skillSourceRoot = path.join(userData, 'skill-sources')
  const applicationRoot = path.join(userData, 'application-addons')
  const proxyAwareFetch = createProxyAwareFetch((input, init) => net.fetch(input, init))
  const githubAuth = createGitHubAuthService({
    filePath: path.join(userData, 'github-auth.bin'),
    clientId: process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID,
    fetchImpl: proxyAwareFetch,
    cipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    },
  })
  const catalogSync = createCatalogSyncService({
    fetchImpl: githubAuth.fetch,
    getAuthStatus: () => githubAuth.getStatus(),
    pendingDir: path.join(userData, 'catalog', 'pending'),
    onFlush: result => events.output('plugin', result.submitted > 0 ? 'success' : 'error', result.message),
  })

  let settings: SettingsStore

  /**
   * 准备 Node.js 运行环境，并把下载进度写进日志。
   * 进度每跨越 10% 记一条，避免刷屏。
   */
  const prepareNodeRuntime = (
    source: RuntimeOutput['channel'],
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<NodeRuntime> => {
    let lastBucket = -1
    return settings.read().then(currentSettings => ensureNodeRuntime(managedNodeRoot, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, currentSettings.nodeVersion, (level, text) => events.output(source, level, text)))
  }

  const preparePnpmRuntime = (
    source: RuntimeOutput['channel'],
    nodeRuntime: NodeRuntime,
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<PnpmRuntime> => {
    let lastBucket = -1
    return ensurePnpmRuntime(managedPnpmRoot, nodeRuntime, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, (level, text) => events.output(source, level, text))
  }

  settings = createSettingsStore({
    filePath: path.join(userData, 'settings.json'),
    createDefaults: () => defaultSettings({
      dshHomeFromEnvironment: process.env.DSH_HOME,
      homeDirectory: os.homedir(),
      documentsDirectory: app.getPath('documents'),
      systemNpx: findSystemNodeRuntime()?.npx,
      dshInstallPath: managedDshRoot,
    }),
    detectInstalledDsh: (settings: AppSettings) => findInstalledDsh({
      managedRoot: settings.dshInstallPath,
      configuredExecutable: settings.launchExecutable,
    }),
  })

  let applicationAddons: ApplicationAddonManager
  let installer: Installer
  const runtime = createRuntimeController({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('runtime'),
    fallbackWorkspace: () => app.getPath('documents'),
    emitOutput: (level, text) => events.output('runtime', level, text),
    emitState: state => events.runtimeState(state),
    openExternal: url => void shell.openExternal(url),
    resolveApplicationLaunchPlan: () => applicationAddons.launchPlan(),
    legacyCredentialsBackupRoot: path.join(userData, 'dsh-credentials-compat'),
  })
  const profileService = createProfileService({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    packBodiesRoot: () => settings.read().then(value => path.join(value.dshHome, '.dsh-launcher-pack-bodies')),
    isRuntimeRunning: () => runtime.isRunning(),
    fillMissingDependencies: async (profileName, missing) => {
      const current = await settings.read()
      const receipts = await readPluginReceipts(pluginReceiptsPath)
      const pluginStoreRoot = path.join(userData, 'plugin-store')
      const profileRoot = path.join(current.dshHome, 'profiles')
      const targetProfileDir = path.join(profileRoot, profileName)
      // A link-only repair must never auto-install DSH peer packages from npm.
      // Normalize legacy/imported Profiles before invoking pnpm so unpublished
      // preview peers remain supplied by the selected DSH runtime.
      await ensureProfileWorkspaceConfig(targetProfileDir)

      // Legacy/imported Profiles can contain only `*` dependency ranges even
      // though another Profile already has the exact local source. Reuse that
      // source before asking pnpm for offline registry metadata; this preserves
      // one physical plugin body while keeping each Profile's link layer and
      // activation order independent.
      const sourceSpecs = new Map<string, string>()
      const siblingEntries = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
      for (const sibling of siblingEntries) {
        if (!sibling.isDirectory() || sibling.name === profileName) continue
        const siblingManifestPath = path.join(profileRoot, sibling.name, 'package.json')
        let siblingManifest: { dependencies?: Record<string, unknown> } | null = null
        try {
          siblingManifest = JSON.parse(await readFile(siblingManifestPath, 'utf8')) as { dependencies?: Record<string, unknown> }
        } catch {
          continue
        }
        for (const packageName of missing) {
          if (sourceSpecs.has(packageName)) continue
          const candidate = siblingManifest.dependencies?.[packageName]
          if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.trim() === '*') continue
          if (candidate.startsWith('file:')) {
            const rawPath = candidate.slice('file:'.length)
            const sourcePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(siblingManifestPath), rawPath)
            try {
              const sourceManifest = JSON.parse(await readFile(path.join(sourcePath, 'package.json'), 'utf8')) as { version?: unknown }
              const version = typeof sourceManifest.version === 'string' && sourceManifest.version.trim()
                ? sourceManifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
                : 'local'
              const sharedSource = path.join(current.dshHome, '.dsh-launcher-plugin-bodies', ...packageName.split('/'), version)
              if (path.resolve(sourcePath) !== path.resolve(sharedSource)) {
                await mkdir(path.dirname(sharedSource), { recursive: true })
                try {
                  await readFile(path.join(sharedSource, 'package.json'), 'utf8')
                } catch {
                  await cp(sourcePath, sharedSource, { recursive: true })
                }
              }
              sourceSpecs.set(packageName, `file:${sharedSource}`)
            } catch {
              // Stale file references are not reusable sources.
            }
          } else if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.trim())) {
            sourceSpecs.set(packageName, candidate.trim())
          }
        }
      }

      if (sourceSpecs.size > 0) {
        const targetManifestPath = path.join(targetProfileDir, 'package.json')
        try {
          const targetManifest = JSON.parse(await readFile(targetManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
          const dependencies = { ...(targetManifest.dependencies ?? {}) }
          const repaired: string[] = []
          for (const packageName of missing) {
            const currentSpec = dependencies[packageName]
            const sourceSpec = sourceSpecs.get(packageName)
            if (!sourceSpec || (currentSpec && currentSpec !== '*' && !/[<>=*^~]/.test(currentSpec))) continue
            dependencies[packageName] = sourceSpec
            repaired.push(`${packageName} → ${sourceSpec}`)
          }
          if (repaired.length > 0) {
            await writeFile(targetManifestPath, `${JSON.stringify({ ...targetManifest, dependencies }, null, 2)}\n`, 'utf8')
            events.output('plugin', 'info', `已从其他 Profile 复用 ${repaired.length} 个插件来源：${repaired.join('、')}`)
          }
        } catch {
          // The subsequent pnpm command reports a precise manifest error.
        }
      }

      let offlineNode: NodeRuntime | null = null
      let offlinePnpm: PnpmRuntime | null = null
      let offlineInstallAttempted = false
      for (const packageName of missing) {
        const receipt = receipts.find(item => item.profileName === profileName && item.packageName === packageName)
        if (!receipt) {
          // A cloned/imported Profile may have no launcher receipt while its
          // exact package is already present in the shared pnpm store. Try an
          // offline link-only install before asking the user to source it.
          if (!offlineInstallAttempted) {
            offlineInstallAttempted = true
            offlineNode ??= await prepareNodeRuntime('plugin')
            offlinePnpm ??= await preparePnpmRuntime('plugin', offlineNode)
            const result = await runCommand(offlinePnpm.executable, ['install', '--dir', targetProfileDir, '--offline', '--no-frozen-lockfile', '--config.auto-install-peers=false', '--store-dir', pluginStoreRoot], {
              cwd: targetProfileDir,
              env: withExecutableDirectoryOnPath(offlinePnpm.executable, withExecutableDirectoryOnPath(offlineNode.node, {
                ...process.env,
                DSH_HOME: current.dshHome,
                npm_config_store_dir: pluginStoreRoot,
                NPM_CONFIG_STORE_DIR: pluginStoreRoot,
                pnpm_config_store_dir: pluginStoreRoot,
                PNPM_CONFIG_STORE_DIR: pluginStoreRoot,
                CI: 'true',
              })),
              onOutput: (text, level) => events.output('plugin', level, text),
            })
            if (result.exitCode !== 0) throw new Error(`插件「${packageName}」无法从共享插件池补齐，请检查来源记录。`)
          }
          continue
        }
        const repository = receipt.repository.match(/^(?:https?:\/\/github\.com\/|github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1]
        if (receipt.source === 'npm') {
          await installer.installNpmPackage({ packageName, version: receipt.version ?? undefined }, profileName)
        } else if (repository) {
          await installer.installPluginTarget({
            repository,
            defaultBranch: receipt.defaultBranch ?? 'main',
            targetId: receipt.targetId ?? `${packageName}:.`,
            ...(receipt.commit ? { commit: receipt.commit } : {}),
          }, profileName)
        } else {
          throw new Error(`插件「${packageName}」的来源记录无效，无法自动补齐。`)
        }
      }
      // Keep the selected DSH home/profile invariant explicit for future
      // installers that consult settings while repairing links.
      if (current.dshHome !== (await settings.read()).dshHome) throw new Error('DSH_HOME 在补齐依赖期间发生变化。')
    },
  })

  const runtimeVersions = createRuntimeVersionService({
    dshRoot: managedDshRoot,
    nodeRoot: managedNodeRoot,
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    isRuntimeRunning: () => runtime.isRunning(),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    githubFetch: githubAuth.fetch,
  })

  applicationAddons = createApplicationAddonManager({
    registryPath: path.join(userData, 'application-addons.json'),
    installRoot: applicationRoot,
    readSettings: () => settings.read(),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning(),
    githubFetch: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
  })

  installer = createInstaller({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    pluginSourceRoot,
    pluginReceiptsPath,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    presetReceiptsPath,
    skillReceiptsPath,
    skillSourceRoot,
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning(),
    githubFetch: githubAuth.fetch,
  })

  // This service deliberately does not use the unified resource-market
  // analyzers or installers. It mirrors dsh-market's curated registry and
  // package command rules behind a separate API surface.
  const dshMarket = createDshMarketService({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: node => preparePnpmRuntime('plugin', node),
    fetchImpl: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    emitProgress: progress => events.dshMarketProgress(progress),
    emitOutput: (level, text) => events.output('plugin', level, text),
  })

  const pluginTrial = createPluginTrialManager({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('plugin', nodeRuntime),
    trialRoot: path.join(userData, 'plugin-trials'),
    resultsPath: path.join(userData, 'plugin-trial-results.json'),
    emitOutput: (level, text) => events.output('test', level, text),
    emitResult: result => events.pluginTrial(result),
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
  })

  let packManager: PackManager | null = null
  const copilot = createCopilotSessionManager({
    filePath: path.join(userData, 'copilot-sessions.json'),
    runtimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    readSettings: () => settings.read(),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    emitEvent: event => events.aiSessionEvent(event),
    emitOutput: (level, text) => events.output('ai', level, text),
    mutationBlockReason: () => {
      if (runtime.isRunning()) return '请先停止 DSH 运行时'
      if (installer.isBusy()) return '资源安装正在进行'
      if (pluginTrial.isBusy()) return '插件试运行正在进行'
      if (applicationAddons.isBusy()) return '应用加载项操作正在进行'
      if (dshMarket.isBusy()) return 'DSH Market 操作正在进行'
      if (packManager?.isBusy()) return '整合包操作正在进行'
      return null
    },
  })

  const aiInstaller = createAiInstaller({
    readSettings: () => settings.read(),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    acpRuntimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    emitOutput: (level, text) => events.output('ai', level, text),
    emitEvent: event => {
      events.aiInstallEvent(event)
      void copilot.updateLegacy(event)
    },
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    analyzePlugin: (repository, defaultBranch) => installer.analyzePlugin(repository, defaultBranch),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    githubFetch: githubAuth.fetch,
  })

  /**
   * 整合包离线导入（zip 内的 plugin-bodies）用 `file:` specifier 安装。
   * 真实 installer 的 installPluginTarget 只接受 GitHub 仓库分析，无法直接
   * 安装本地目录，因此这里在组装层用 DSH CLI 插件命令补上最小通路。
   */
  async function installPackLocalDirectory(target: PackInstallTarget): Promise<void> {
    const localDirectory = validateLocalPluginDirectory(target.localDirectory)
    const current = await settings.read()
    const nodeRuntime = await prepareNodeRuntime('plugin')
    const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
    const executable = resolveNodeExecutable(current.launchExecutable, nodeRuntime)
    const commandArgs = buildPluginCommandArgs(current, executable, ['add', `file:${localDirectory}`], target.profileName)
    const result = await runCommand(executable, commandArgs, {
      cwd: current.workspace,
        env: withExecutableDirectoryOnPath(
          pnpmRuntime.executable,
          withExecutableDirectoryOnPath(nodeRuntime.node, {
            ...process.env,
            DSH_HOME: current.dshHome,
            npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
            NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
            pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
            PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
            FORCE_COLOR: '0',
          }),
      ),
      onOutput: (text, level) => events.output('plugin', level, text),
    })
    if (result.exitCode !== 0) throw new Error(`插件安装失败（代码 ${result.exitCode}），请查看运行日志。`)
    let version: string | null = null
    try {
      const packageManifest = JSON.parse(await readFile(path.join(localDirectory, 'package.json'), 'utf8')) as { version?: unknown }
      version = typeof packageManifest.version === 'string' ? packageManifest.version : null
    } catch {
      // 版本读取失败可忽略，receipt 的 version 允许为 null。
    }
    await recordPluginInstall(pluginReceiptsPath, {
      repository: `file:${localDirectory}`,
      packageName: target.packageName,
      profileName: target.profileName,
      source: 'local-directory',
      subdirectory: null,
      version,
      commit: '',
      installedAt: new Date().toISOString(),
    })
  }

  const packInstaller: InstallInstaller = {
    async installPluginTarget(target) {
      if (target.source === 'local-directory') {
        await installPackLocalDirectory(target)
        return
      }
      if (!target.repository) throw new Error('缺少来源仓库，无法安装。')
      // 真实 installer 按 analysis.targets 的 id 定位，id 形如 `<packageName>:<subdir|.>`。
      const targetId = target.subdirectory ? `${target.packageName}:${target.subdirectory}` : `${target.packageName}:.`
      const request: {
        repository: string
        defaultBranch: string
        targetId: string
        commit?: string
        version?: string
      } = { repository: target.repository, defaultBranch: 'main', targetId }
      // 转发整合包声明的 pin：github 用固定 commit，npm 用固定 version（0.0.0 是占位符，不转发）。
      if (target.source === 'github' && target.commit) request.commit = target.commit
      if (target.source === 'npm' && target.version && target.version !== '0.0.0') request.version = target.version
      await installer.installPluginTarget(request, target.profileName)
    },
    installNpmPackage: (request, profileOverride) => installer.installNpmPackage(request, profileOverride),
    remove: (packageName, profileName) => installer.remove(packageName, profileName),
    readProfile: (dshHome, profileName) => readProfile(dshHome, profileName, pluginReceiptsPath),
    togglePlugin: (dshHome, profileName, packageName, enabled) => togglePlugin(dshHome, profileName, packageName, enabled, pluginReceiptsPath),
    reorderPlugins: (dshHome, profileName, packageNames) => reorderPlugins(dshHome, profileName, packageNames, pluginReceiptsPath),
    // raw 整合包导入的技能：从本地 staging 目录全局安装（bundle 目录或 flat 单文件）。
    installSkillLocal: (dshHome, skill) => installSkillFromDirectory(dshHome, skill.name, skill.format, skill.sourceDir),
    installSkill: request => installer.installSkill(request),
    installSkillPinned: request => installer.installSkillPinned(request),
    toggleSkill: (name, enabled) => installer.toggleSkill(name, enabled),
    installPreset: request => installer.installPreset(request),
    installPresetLocal: (dshHome, preset) => installPresetFromDirectory(dshHome, preset.name, preset.sourceDir),
    togglePreset: (name, enabled) => installer.togglePreset(name, enabled),
  }

  packManager = createPackManager({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    snapshotRoot: path.join(userData, 'pack-snapshots'),
    pluginReceiptsPath,
    presetReceiptsPath,
    skillReceiptsPath,
    installer: packInstaller,
    applicationAddons,
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitEvent: event => events.packProgress(event),
    isRuntimeRunning: () => runtime.isRunning(),
    isInstallerBusy: () => installer.isBusy(),
    unifiedProfiles: true,
  })

  const launcherUpdater = createLauncherUpdater({
    getVersion: () => app.getVersion(),
    userDataPath: userData,
    githubFetch: githubAuth.fetch,
    emitProgress: progress => events.launcherUpdateProgress(progress),
  })

  // 启动自愈：上次 AI 会话若在凭据锁期间崩溃（进程被杀、finally 未跑），
  // .credentials.yaml 会滞留在锁目录，这里把它还原回 dshHome。
  void settings
    .read()
    .then(current => healCredentialsLock(current.dshHome, path.join(userData, CREDENTIALS_LOCK_DIRNAME)))
    .catch(() => { /* 设置未就绪可忽略，锁会在下次 AI 会话前置处理 */ })

  const profilePoolReady = migrateLegacyPacks({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    isRuntimeRunning: () => runtime.isRunning(),
  }).then(async () => {
    const current = await settings.read()
    const result = await consolidatePluginPool(current.dshHome)
    if (result.dependencies > 0) events.output('plugin', 'info', `已将 ${result.dependencies} 个 Profile 插件依赖归并到共享插件池。`)
  }).catch(error => events.output('plugin', 'error', `旧整合包/插件池迁移失败：${error instanceof Error ? error.message : String(error)}`))

  return { settings, pluginReceiptsPath, runtime, installer, launcherUpdater, pluginTrial, aiInstaller, copilot, packManager: packManager!, githubAuth, applicationAddons, catalogSync, dshMarket, runtimeVersions, profiles: profileService, profilePoolReady }
}

function openMainWindow(): void {
  mainWindow = createMainWindow({
    preloadPath: path.join(moduleDirectory, 'preload.mjs'),
    iconPath: path.join(moduleDirectory, app.isPackaged ? '../dist/launcher-icon.png' : '../public/launcher-icon.png'),
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    indexPath: path.join(moduleDirectory, '../dist/index.html'),
    onClosed: () => { mainWindow = null },
  })
}

app.whenReady().then(async () => {
  await recoverLegacyCredentials(path.join(app.getPath('userData'), 'dsh-credentials-compat')).catch(error => {
    console.error('[credentials] 旧版 DSH 凭据恢复失败。', error)
  })
  try {
    processSupervisor = await createProcessSupervisor({
      root: path.join(app.getPath('userData'), 'process-supervisor'),
      onError: message => console.error(`[process-supervisor] ${message}`),
    })
    configureProcessTracker(processSupervisor)
  } catch (error) {
    console.error('[process-supervisor] 启动失败，退出时只能执行普通清理。', error)
  }
  services = createServices()
  registerIpcHandlers({
    ...services,
    getWindow,
    setWindowMode: (mode: WindowMode) => applyWindowMode(mainWindow, mode),
  })
  await services.profilePoolReady
  openMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function waitForIdle(check: () => boolean): Promise<void> {
  if (!check()) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!check()) {
        clearInterval(timer)
        resolve()
      }
    }, 100)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function shutdownLauncherProcesses(): Promise<void> {
  const current = services
  // 先让监督器对仍在运行的根进程做快照；若 DSH 派生了脱离父进程树的服务，
  // 必须在正常停止根进程前收集它们，否则关闭后无法再定位微信机器人 PID。
  const supervisorShutdown = processSupervisor?.shutdown().catch(error => {
    console.error('[process-supervisor] 清理子进程失败。', error)
  }) ?? Promise.resolve()
  const gracefulTasks: Promise<unknown>[] = []
  if (current?.runtime.isRunning()) gracefulTasks.push(current.runtime.stop())
  if (current?.pluginTrial.isBusy()) gracefulTasks.push(current.pluginTrial.cancel())
  if (current?.aiInstaller.isBusy()) gracefulTasks.push(current.aiInstaller.cancel())
  if (current?.copilot.isBusy()) gracefulTasks.push(current.copilot.shutdown())
  if (current?.packManager.isBusy()) gracefulTasks.push(waitForIdle(() => current.packManager.isBusy()))
  if (current?.installer.isBusy()) gracefulTasks.push(waitForIdle(() => current.installer.isBusy()))
  if (current?.applicationAddons.isBusy()) gracefulTasks.push(waitForIdle(() => current.applicationAddons.isBusy()))

  const graceful = Promise.allSettled(gracefulTasks)
  await Promise.race([Promise.all([graceful, supervisorShutdown]), delay(2_000)])
  await supervisorShutdown
  // 监督器处理完整树后，主进程再用本地句柄兜底，覆盖通信丢失或快速关闭。
  await shutdownTrackedProcesses().catch(error => {
    console.error('[process-tracker] 清理子进程失败。', error)
  })
  configureProcessTracker(null)
  await Promise.race([graceful, delay(800)])

  if (current) {
    try {
      const settings = await current.settings.read()
      await healCredentialsLock(
        settings.dshHome,
        path.join(app.getPath('userData'), CREDENTIALS_LOCK_DIRNAME),
      )
    } catch (error) {
      console.error('[shutdown] AI 凭据文件还原失败。', error)
    }
  }
}

// 无论是正常关闭还是安装过程中退出，所有由启动器登记的进程树都必须一起结束。
app.on('before-quit', event => {
  if (allowFinalQuit) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  void shutdownLauncherProcesses().finally(() => {
    allowFinalQuit = true
    app.quit()
  })
})
