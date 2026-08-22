import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ApplicationInstallRequest,
  ApplicationInstallResult,
  ApplicationLaunchMode,
  ApplicationRepositoryAnalysis,
  AppSettings,
  InstallProgress,
  InstalledApplicationAddon,
  RuntimeOutput,
} from '../src/types'
import { runCommand, type CommandOptions, type CommandResult } from './command'
import { analyzeApplicationRepository } from './application-catalog'
import type { NodeRuntime, NodeRuntimeProgress, PnpmRuntime } from './node-runtime'
import { withExecutableDirectoryOnPath } from './process'

interface ApplicationRegistryFile {
  version: 1
  addons: InstalledApplicationAddon[]
}

interface InstalledPackageManifest {
  name?: unknown
  version?: unknown
  bin?: unknown
}

export interface ApplicationLaunchSpec {
  id: string
  name: string
  mode: ApplicationLaunchMode
  executable: string
  args: string[]
  cwd: string
}

export interface ApplicationLaunchPlan {
  replacement: ApplicationLaunchSpec | null
  companions: ApplicationLaunchSpec[]
}

export interface ApplicationAddonManagerOptions {
  registryPath: string
  installRoot: string
  readSettings: () => Promise<AppSettings>
  prepareNodeRuntime: (onProgress?: (progress: NodeRuntimeProgress) => void) => Promise<NodeRuntime>
  preparePnpmRuntime: (
    nodeRuntime: NodeRuntime,
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ) => Promise<PnpmRuntime>
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  emitProgress: (progress: InstallProgress) => void
  isRuntimeRunning: () => boolean
  githubFetch?: typeof fetch
  packageStoreRoot?: string
  runCommand?: (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>
}

export interface ApplicationAddonManager {
  analyzeRepository(repository: string, defaultBranch: string): Promise<ApplicationRepositoryAnalysis>
  list(): Promise<InstalledApplicationAddon[]>
  install(request: ApplicationInstallRequest): Promise<Omit<ApplicationInstallResult, 'profile'>>
  toggle(id: string, enabled: boolean): Promise<InstalledApplicationAddon[]>
  uninstall(id: string): Promise<InstalledApplicationAddon[]>
  launchPlan(): Promise<ApplicationLaunchPlan>
  isBusy(): boolean
}

function safeAddonId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(value)
}

function packageDirectory(root: string, packageName: string): string {
  return path.join(root, 'node_modules', ...packageName.split('/'))
}

async function validatedEntryPath(packageRoot: string, relativeEntry: string): Promise<string> {
  if (!relativeEntry || path.isAbsolute(relativeEntry)) throw new Error('应用加载项没有有效的启动入口。')
  const resolved = path.resolve(packageRoot, relativeEntry)
  const normalizedRoot = `${path.resolve(packageRoot)}${path.sep}`.toLowerCase()
  if (!resolved.toLowerCase().startsWith(normalizedRoot)) throw new Error('应用加载项启动入口越过了包目录。')
  if (!existsSync(resolved)) throw new Error(`应用加载项启动入口不存在：${relativeEntry}`)
  const [realPackageRoot, realEntry] = await Promise.all([realpath(packageRoot), realpath(resolved)])
  const normalizedRealRoot = `${realPackageRoot}${path.sep}`.toLowerCase()
  if (!realEntry.toLowerCase().startsWith(normalizedRealRoot)) {
    throw new Error('应用加载项启动入口链接到了包目录外部。')
  }
  // pnpm 的顶层包目录是链接。保存真实路径可确保依赖入口的 self-check 正常执行。
  return realEntry
}

function binEntry(manifest: InstalledPackageManifest, binName: string): string | null {
  if (typeof manifest.bin === 'string') return manifest.bin
  if (!manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) return null
  const value = (manifest.bin as Record<string, unknown>)[binName]
  return typeof value === 'string' ? value : null
}

function validInstalledAddon(value: unknown): value is InstalledApplicationAddon {
  if (!value || typeof value !== 'object') return false
  const addon = value as Partial<InstalledApplicationAddon>
  return typeof addon.id === 'string' && safeAddonId(addon.id)
    && typeof addon.name === 'string'
    && typeof addon.repository === 'string'
    && addon.provider === 'npm'
    && typeof addon.packageName === 'string'
    && typeof addon.version === 'string'
    && typeof addon.binName === 'string'
    && typeof addon.entryPath === 'string' && path.isAbsolute(addon.entryPath)
    && typeof addon.installPath === 'string' && path.isAbsolute(addon.installPath)
    && ['runtime-replacement', 'after-runtime', 'standalone'].includes(addon.launchMode ?? '')
    && Array.isArray(addon.launchArgs) && addon.launchArgs.every(item => typeof item === 'string')
    && typeof addon.enabled === 'boolean'
    && typeof addon.verified === 'boolean'
    && Array.isArray(addon.provides) && addon.provides.every(item => typeof item === 'string')
    && typeof addon.installedAt === 'string'
    && typeof addon.updatedAt === 'string'
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rm(filePath, { force: true })
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function createApplicationAddonManager(options: ApplicationAddonManagerOptions): ApplicationAddonManager {
  const executeCommand = options.runCommand ?? runCommand
  const analysisCache = new Map<string, { expiresAt: number; analysis: ApplicationRepositoryAnalysis }>()
  let busy = false

  const readRegistry = async (): Promise<InstalledApplicationAddon[]> => {
    try {
      const raw = JSON.parse(await readFile(options.registryPath, 'utf8')) as Partial<ApplicationRegistryFile>
      if (raw.version !== 1 || !Array.isArray(raw.addons)) return []
      return raw.addons.filter(validInstalledAddon)
    } catch {
      return []
    }
  }

  const saveRegistry = async (addons: InstalledApplicationAddon[]): Promise<void> => {
    const file: ApplicationRegistryFile = { version: 1, addons }
    await atomicWrite(options.registryPath, `${JSON.stringify(file, null, 2)}\n`)
  }

  const analyzeRepository = async (
    repository: string,
    defaultBranch: string,
  ): Promise<ApplicationRepositoryAnalysis> => {
    const key = `${repository.toLowerCase()}#${defaultBranch}`
    const cached = analysisCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.analysis
    const analysis = options.githubFetch
      ? await analyzeApplicationRepository(repository, defaultBranch, options.githubFetch)
      : await analyzeApplicationRepository(repository, defaultBranch)
    analysisCache.set(key, { expiresAt: Date.now() + 5 * 60_000, analysis })
    return analysis
  }

  const prepareNode = (repository: string) => options.prepareNodeRuntime(progress => {
    options.emitProgress({
      repository,
      kind: 'application',
      phase: 'preparing',
      percent: 5 + Math.round(progress.percent * 0.08),
      message: progress.message,
      downloadedBytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes,
    })
  })

  const preparePnpm = (repository: string, nodeRuntime: NodeRuntime) => options.preparePnpmRuntime(nodeRuntime, progress => {
    options.emitProgress({
      repository,
      kind: 'application',
      phase: 'preparing',
      percent: 13 + Math.round(progress.percent * 0.07),
      message: progress.message,
      downloadedBytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes,
    })
  })

  return {
    analyzeRepository,

    list: readRegistry,

    isBusy: () => busy,

    async install(request) {
      if (busy) throw new Error('另一个应用加载项操作正在进行中。')
      if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再安装或更新应用加载项。')
      busy = true
      options.emitProgress({
        repository: request.repository,
        kind: 'application',
        phase: 'preparing',
        percent: 3,
        message: '正在验证应用加载项清单',
      })
      try {
        const analysis = await analyzeRepository(request.repository, request.defaultBranch)
        const target = analysis.targets.find(item => item.id === request.targetId)
        if (!target) throw new Error(analysis.summary || '所选应用加载项已经失效，请重新检测仓库。')
        if (!target.supported) throw new Error(`${target.name} 不支持当前操作系统。`)

        const nodeRuntime = await prepareNode(request.repository)
        const pnpmRuntime = await preparePnpm(request.repository, nodeRuntime)
        const installPath = path.join(options.installRoot, target.addonId)
        const runtimePath = path.join(installPath, 'runtime')
        await mkdir(runtimePath, { recursive: true })
        const runtimeManifest = path.join(runtimePath, 'package.json')
        if (!existsSync(runtimeManifest)) {
          await writeFile(runtimeManifest, `${JSON.stringify({ name: `dsh-addon-${target.addonId}`, private: true }, null, 2)}\n`, 'utf8')
        }

        const packageSpecifier = target.version ? `${target.packageName}@${target.version}` : target.packageName
        options.emitOutput('info', `应用加载项安装：${target.name}（${packageSpecifier}）`)
        options.emitProgress({
          repository: request.repository,
          kind: 'application',
          phase: 'downloading',
          percent: 28,
          message: `正在下载并安装 ${target.name}`,
          indeterminate: true,
        })
        const environment = withExecutableDirectoryOnPath(
          pnpmRuntime.executable,
          withExecutableDirectoryOnPath(nodeRuntime.node, {
            ...process.env,
            ...(options.packageStoreRoot ? { npm_config_store_dir: options.packageStoreRoot, NPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
            ...(options.packageStoreRoot ? { pnpm_config_store_dir: options.packageStoreRoot, PNPM_CONFIG_STORE_DIR: options.packageStoreRoot } : {}),
            FORCE_COLOR: '0',
            NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          }),
        )
        const result = await executeCommand(pnpmRuntime.executable, [
          '--dir', runtimePath,
          'add', '--save-exact', '--ignore-scripts', packageSpecifier,
        ], {
          cwd: runtimePath,
          env: environment,
          onOutput: (text, level) => options.emitOutput(level, text),
        })
        if (result.exitCode !== 0) throw new Error(`应用加载项安装失败（代码 ${result.exitCode}）。`)

        options.emitProgress({
          repository: request.repository,
          kind: 'application',
          phase: 'verifying',
          percent: 90,
          message: '正在验证应用启动入口',
        })
        const installedPackageRoot = packageDirectory(runtimePath, target.packageName)
        const manifest = JSON.parse(await readFile(path.join(installedPackageRoot, 'package.json'), 'utf8')) as InstalledPackageManifest
        if (manifest.name !== target.packageName || typeof manifest.version !== 'string') {
          throw new Error('安装完成，但 npm 包清单与应用加载项声明不一致。')
        }
        const relativeEntry = binEntry(manifest, target.binName)
        if (!relativeEntry) throw new Error(`npm 包没有声明 ${target.binName} 启动入口。`)
        const entryPath = await validatedEntryPath(installedPackageRoot, relativeEntry)

        const existing = await readRegistry()
        const previous = existing.find(item => item.id === target.addonId)
        const now = new Date().toISOString()
        const installedAddon: InstalledApplicationAddon = {
          id: target.addonId,
          name: target.name,
          description: target.description,
          repository: request.repository,
          provider: target.provider,
          packageName: target.packageName,
          version: manifest.version,
          binName: target.binName,
          entryPath,
          installPath,
          launchMode: target.launchMode,
          launchArgs: target.launchArgs,
          enabled: previous?.enabled ?? true,
          verified: target.verified,
          provides: target.provides,
          installedAt: previous?.installedAt ?? now,
          updatedAt: now,
        }
        let installedAddons = existing.filter(item => item.id !== installedAddon.id)
        if (installedAddon.enabled && installedAddon.launchMode === 'runtime-replacement') {
          installedAddons = installedAddons.map(item => item.launchMode === 'runtime-replacement'
            ? { ...item, enabled: false }
            : item)
        }
        installedAddons = [...installedAddons, installedAddon]
          .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
        await saveRegistry(installedAddons)
        options.emitProgress({
          repository: request.repository,
          kind: 'application',
          phase: 'complete',
          percent: 100,
          message: `${target.name} 已作为应用加载项安装`,
        })
        options.emitOutput('success', `${target.name} 已安装到 ${installPath}`)
        return { installedAddon, installedAddons }
      } catch (error) {
        options.emitProgress({
          repository: request.repository,
          kind: 'application',
          phase: 'error',
          percent: 0,
          message: error instanceof Error ? error.message : '应用加载项安装失败',
        })
        throw error
      } finally {
        busy = false
      }
    },

    async toggle(id, enabled) {
      if (!safeAddonId(id)) throw new Error('应用加载项标识无效。')
      if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再修改应用加载项状态。')
      const addons = await readRegistry()
      const selected = addons.find(item => item.id === id)
      if (!selected) throw new Error('没有找到该应用加载项。')
      const next = addons.map(item => {
        if (item.id === id) return { ...item, enabled }
        if (enabled && selected.launchMode === 'runtime-replacement' && item.launchMode === 'runtime-replacement') {
          return { ...item, enabled: false }
        }
        return item
      })
      await saveRegistry(next)
      return next
    },

    async uninstall(id) {
      if (!safeAddonId(id)) throw new Error('应用加载项标识无效。')
      if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再卸载应用加载项。')
      const addons = await readRegistry()
      const selected = addons.find(item => item.id === id)
      if (!selected) return addons
      const resolvedRoot = path.resolve(options.installRoot)
      const resolvedTarget = path.resolve(selected.installPath)
      if (resolvedTarget !== resolvedRoot && resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        await rm(resolvedTarget, { recursive: true, force: true })
      }
      const next = addons.filter(item => item.id !== id)
      await saveRegistry(next)
      options.emitOutput('success', `${selected.name} 已卸载。`)
      return next
    },

    async launchPlan() {
      const enabled = (await readRegistry()).filter(item => item.enabled)
      if (enabled.length === 0) return { replacement: null, companions: [] }
      const settings = await options.readSettings()
      const nodeRuntime = await options.prepareNodeRuntime()
      const makeSpec = (addon: InstalledApplicationAddon): ApplicationLaunchSpec => {
        if (!existsSync(addon.entryPath)) throw new Error(`${addon.name} 的启动入口已丢失，请更新或重新安装。`)
        return {
          id: addon.id,
          name: addon.name,
          mode: addon.launchMode,
          executable: nodeRuntime.node,
          args: [addon.entryPath, ...addon.launchArgs],
          cwd: existsSync(settings.workspace) ? settings.workspace : addon.installPath,
        }
      }
      const replacementAddon = enabled.find(item => item.launchMode === 'runtime-replacement') ?? null
      return {
        replacement: replacementAddon ? makeSpec(replacementAddon) : null,
        companions: enabled.filter(item => item.launchMode === 'after-runtime').map(makeSpec),
      }
    },
  }
}
