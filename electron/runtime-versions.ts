import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { DSH_PACKAGE_NAME } from '../src/constants'
import type {
  AppSettings,
  DshVersionInfo,
  NodeVersionInfo,
  RuntimeEnvironmentState,
  RuntimeVersionCandidate,
  RuntimeOutput,
  InstallProgress,
} from '../src/types'
import {
  findInstalledDsh,
  getManagedDshStatus,
  managedDshExecutable,
  packageManagerProgress,
} from './dsh-install'
import {
  findManagedNodeRuntimes,
  findSystemNodeRuntime,
  installManagedNodeRuntime,
  normalizeNodeVersion,
  type NodeRuntime,
  type PnpmRuntime,
} from './node-runtime'
import { runCommand, type CommandResult, type OutputLevel } from './command'
import { withExecutableDirectoryOnPath } from './process'
import { compareVersions } from './dsh-update'
import {
  DSH_SUBPROCESS_LOCAL_PACKAGE,
  ensureDshScriptPolicy,
  hasDshScriptPackage,
} from './dsh-script-policy'

const DSH_REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh'
const VERSION_LIMIT_PER_CHANNEL = 12

/**
 * DSH 是一棵很大的依赖树。安装时显式固定网络行为和锁文件行为，
 * 避免某个 registry 请求无限重试，或每次启动都重新求解整棵树。
 * 脚本统一在依赖落盘后单独重建，避免第三方 postinstall 阻塞解析阶段。
 */
export function buildManagedDshInstallArgs(root: string, version: string): string[] {
  return [
    'install',
    '--prefix', root,
    '--save-exact',
    '--package-lock=true',
    '--no-audit',
    '--no-fund',
    '--progress=true',
    '--loglevel=verbose',
    '--ignore-scripts',
    '--prefer-offline',
    '--fetch-timeout=30000',
    '--fetch-retries=1',
    '--fetch-retry-factor=2',
    '--fetch-retry-mintimeout=1000',
    '--fetch-retry-maxtimeout=10000',
    `${DSH_PACKAGE_NAME}@${normalizeDshVersion(version)}`,
  ]
}

export function buildManagedDshPnpmArgs(root: string, version: string): string[] {
  return [
    'add',
    '--dir', root,
    '--save-exact',
    '--lockfile=true',
    '--ignore-scripts',
    '--reporter=append-only',
    '--fetch-timeout=30000',
    '--fetch-retries=1',
    `${DSH_PACKAGE_NAME}@${normalizeDshVersion(version)}`,
  ]
}

interface RegistryPackageManifest {
  dependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}

/** npm 返回 404 时提前终止安装，避免 pnpm 继续展开整棵依赖树后输出大量连带错误。 */
export class MissingDshDependencyError extends Error {
  constructor(
    readonly packageName: string,
    readonly version: string,
  ) {
    super(`DSH ${version} 无法安装：依赖 ${packageName} 没有发布到 npm（目标版本 ${version}）。`)
    this.name = 'MissingDshDependencyError'
  }
}

/** 从一组已获取的 manifest 中提取 DSH 核心包，并统一锁定到目标版本。 */
export function buildDshCoreOverrides(
  version: string,
  manifests: RegistryPackageManifest[],
): Record<string, string> {
  const normalized = normalizeDshVersion(version)
  const overrides: Record<string, string> = {}
  for (const manifest of manifests) {
    for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      for (const name of Object.keys(section ?? {})) {
        if (/^@deepseek-ai\/dsh(?:-|$)/i.test(name)) overrides[name] = normalized
      }
    }
  }
  return overrides
}

async function readRegistryManifest(name: string, version: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<RegistryPackageManifest> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    const encodedName = encodeURIComponent(name).replace(/%2F/gi, '%2f')
    const response = await fetchImpl(`https://registry.npmjs.org/${encodedName}/${encodeURIComponent(version)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'DSH-Launcher' },
      signal: controller.signal,
    })
    if (response.status === 404) throw new MissingDshDependencyError(name, version)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as RegistryPackageManifest
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * dsh-base 和 dsh-web-app 分别覆盖 DSH 的核心运行时和 Web 端依赖。
 * 通过顶层 manifest 找到它们，而不是维护一份容易过期的包名列表。
 */
export async function resolveDshCoreOverrides(version: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Record<string, string>> {
  const rootManifest = await readRegistryManifest(DSH_PACKAGE_NAME, version, fetchImpl, signal)
  const dependencyNames = new Set<string>()
  for (const section of [rootManifest.dependencies, rootManifest.optionalDependencies, rootManifest.peerDependencies]) {
    for (const name of Object.keys(section ?? {})) {
      if (/^@deepseek-ai\/dsh(?:-|$)/i.test(name)) dependencyNames.add(name)
    }
  }
  // 先验证根 manifest 中声明的全部 DSH 核心包，而不是只验证两个 seed 包。
  // 这样类似 dsh-tasks-local 未发布的情况会在 pnpm 启动前直接给出根因。
  const seedResolved = await Promise.all([...dependencyNames].map(name => readRegistryManifest(name, version, fetchImpl, signal)))
  const transitiveNames = new Set<string>()
  for (const manifest of seedResolved) {
    for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      for (const name of Object.keys(section ?? {})) {
        if (/^@deepseek-ai\/dsh(?:-|$)/i.test(name) && !dependencyNames.has(name)) transitiveNames.add(name)
      }
    }
  }
  const transitiveResolved = await Promise.all([...transitiveNames].map(name => readRegistryManifest(name, version, fetchImpl, signal)))
  // 这些依赖已经属于目标版本的发布 manifest；无需再为每个包单独发起
  // 一次 registry 请求，避免慢网络下锁定阶段反而变成长任务。
  return buildDshCoreOverrides(version, [rootManifest, ...seedResolved, ...transitiveResolved])
}

export function normalizeDshVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

export function dshVersionRoot(runtimeRoot: string, version: string): string {
  return path.join(runtimeRoot, 'versions', normalizeDshVersion(version))
}

function validVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())
}

function candidateFromVersion(version: string, time?: string | null, distTag?: string | null): RuntimeVersionCandidate {
  const normalized = normalizeDshVersion(version)
  return {
    version: normalized,
    label: distTag ?? null,
    lts: null,
    date: time ?? null,
    prerelease: normalized.includes('-'),
  }
}

interface DshRegistryResponse {
  versions?: Record<string, unknown>
  'dist-tags'?: Record<string, unknown>
  time?: Record<string, unknown>
}

export async function listAvailableDshVersions(fetchImpl: typeof fetch = fetch): Promise<RuntimeVersionCandidate[]> {
  const response = await fetchImpl(DSH_REGISTRY_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'DSH-Launcher' },
  })
  if (!response.ok) throw new Error(`读取 DSH npm 版本列表失败（HTTP ${response.status}）。`)
  const data = await response.json() as DshRegistryResponse
  const versions = Object.keys(data.versions ?? {}).filter(validVersion)
  const tags = Object.entries(data['dist-tags'] ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && validVersion(entry[1]))
  const tagged = new Map(tags.map(([tag, version]) => [normalizeDshVersion(version), tag]))
  const candidates = versions
    .map(version => candidateFromVersion(version, typeof data.time?.[version] === 'string' ? data.time[version] as string : null, tagged.get(normalizeDshVersion(version))))
    .sort((left, right) => compareVersions(left.version, right.version))
  const stable = candidates.filter(candidate => !candidate.prerelease).slice(0, VERSION_LIMIT_PER_CHANNEL)
  const prerelease = candidates.filter(candidate => candidate.prerelease).slice(0, VERSION_LIMIT_PER_CHANNEL)
  const current = candidates.filter(candidate => ['latest', 'next', 'beta', 'rc'].includes(candidate.label ?? ''))
  const selected = new Map<string, RuntimeVersionCandidate>()
  for (const item of [...stable, ...prerelease, ...current]) selected.set(item.version, item)
  return [...selected.values()].sort((left, right) => compareVersions(left.version, right.version))
}

function versionFromDshRoot(root: string): string | null {
  const base = path.basename(root)
  return validVersion(base) ? normalizeDshVersion(base) : null
}

export async function findManagedDshVersions(runtimeRoot: string): Promise<Array<{
  version: string
  root: string
  executable: string
  source: 'launcher' | 'legacy'
}>> {
  const found: Array<{ version: string; root: string; executable: string; source: 'launcher' | 'legacy' }> = []
  const legacy = await getManagedDshStatus(runtimeRoot)
  if (legacy.installed && legacy.version && legacy.executable) {
    found.push({ version: normalizeDshVersion(legacy.version), root: runtimeRoot, executable: legacy.executable, source: 'legacy' })
  }
  const versionsRoot = path.join(runtimeRoot, 'versions')
  const entries = await readdir(versionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = path.join(versionsRoot, entry.name)
    const status = await getManagedDshStatus(root)
    if (status.installed && status.version && status.executable) {
      found.push({ version: normalizeDshVersion(status.version), root, executable: status.executable, source: 'launcher' })
    }
  }
  const unique = new Map(found.map(item => [item.version, item]))
  return [...unique.values()].sort((left, right) => compareVersions(left.version, right.version))
}

export interface RuntimeVersionServiceOptions {
  dshRoot: string
  nodeRoot: string
  readSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  prepareNodeRuntime: (onProgress?: (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) => void) => Promise<NodeRuntime>
  preparePnpmRuntime: (nodeRuntime: NodeRuntime, onProgress?: (progress: { percent: number; message: string; downloadedBytes?: number; totalBytes?: number }) => void) => Promise<PnpmRuntime>
  isRuntimeRunning: () => boolean
  emitOutput: (level: RuntimeOutput['level'], text: string) => void
  emitProgress: (progress: InstallProgress) => void
  githubFetch?: typeof fetch
  runCommand?: (executable: string, args: string[], options: Parameters<typeof runCommand>[2]) => Promise<CommandResult>
}

export interface RuntimeVersionService {
  read(refresh?: boolean): Promise<RuntimeEnvironmentState>
  installDsh(version: string): Promise<RuntimeEnvironmentState>
  selectDsh(version: string): Promise<RuntimeEnvironmentState>
  removeDsh(version: string): Promise<RuntimeEnvironmentState>
  installNode(version: string): Promise<RuntimeEnvironmentState>
  selectNode(version: string | null): Promise<RuntimeEnvironmentState>
  removeNode(version: string): Promise<RuntimeEnvironmentState>
  cancel(): Promise<void>
  isBusy(): boolean
}

function progressFor(repository: string, message: string, phase: InstallProgress['phase'], percent: number, downloadedBytes?: number, totalBytes?: number): InstallProgress {
  return { repository, kind: 'dsh', phase, percent, message, downloadedBytes, totalBytes }
}

export function createRuntimeVersionService(options: RuntimeVersionServiceOptions): RuntimeVersionService {
  const executeCommand = options.runCommand ?? runCommand
  let dshAvailable: RuntimeVersionCandidate[] = []
  let nodeAvailable: RuntimeVersionCandidate[] = []
  let availableAt = 0
  let activeOperation: string | null = null
  let activeCommand: ChildProcessWithoutNullStreams | null = null
  let cancellationRequested = false
  let activeAbortController: AbortController | null = null

  const terminateCommand = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      await new Promise<void>(resolve => {
        killer.once('error', () => resolve())
        killer.once('exit', () => resolve())
      })
      return
    }
    try { child.kill('SIGTERM') } catch { /* 已经退出 */ }
  }

const executeTrackedCommand = (
    executable: string,
    args: string[],
    commandOptions: Parameters<typeof runCommand>[2],
  ): Promise<CommandResult> => {
    let spawned: ChildProcessWithoutNullStreams | null = null
    return executeCommand(executable, args, {
      ...commandOptions,
      inactivityTimeoutMs: commandOptions.inactivityTimeoutMs ?? 5 * 60 * 1000,
      onSpawn: child => {
        spawned = child
        activeCommand = child
        commandOptions.onSpawn?.(child)
        if (cancellationRequested) void terminateCommand(child)
      },
    }).finally(() => {
      if (activeCommand === spawned) activeCommand = null
    })
  }

  async function runExclusive<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (activeOperation) throw new Error(`运行环境操作正在进行：${activeOperation}`)
    activeOperation = label
    cancellationRequested = false
    activeAbortController = new AbortController()
    try {
      return await task()
    } finally {
      activeOperation = null
      activeCommand = null
      activeAbortController = null
    }
  }

  async function readInstalled(settings: AppSettings): Promise<RuntimeEnvironmentState> {
    const dshVersions = await findManagedDshVersions(settings.dshInstallPath)
    const nodeVersions = await findManagedNodeRuntimes(options.nodeRoot)
    const systemNode = findSystemNodeRuntime()
    let systemDsh: { version: string; executable: string } | null = null
    const resolvedDshRoot = path.resolve(settings.dshInstallPath).toLowerCase()
    const configuredDshPath = path.resolve(settings.launchExecutable).toLowerCase()
    if (!configuredDshPath.startsWith(`${resolvedDshRoot}${path.sep}`)) {
      const detected = await findInstalledDsh({
        managedRoot: path.join(settings.dshInstallPath, '.runtime-probe'),
        configuredExecutable: settings.launchExecutable,
      })
      if (detected.source === 'system' && detected.version && detected.executable) {
        systemDsh = { version: normalizeDshVersion(detected.version), executable: detected.executable }
      }
    }
    const configuredSystemDsh = systemDsh
      && systemDsh.executable.toLowerCase() === settings.launchExecutable.toLowerCase()
      ? systemDsh.version
      : null
    const inferredDsh = settings.dshVersion
      ?? dshVersions.find(item => item.executable.toLowerCase() === settings.launchExecutable.toLowerCase())?.version
      ?? configuredSystemDsh
      ?? null
    const selectedNode = settings.nodeVersion ? normalizeNodeVersion(settings.nodeVersion) : null
    return {
      dshRoot: settings.dshInstallPath,
      nodeRoot: options.nodeRoot,
      dshSelectedVersion: inferredDsh,
      nodeSelectedVersion: selectedNode,
      dshInstalled: [
        ...dshVersions.map(item => ({
          version: item.version,
          root: item.root,
          executable: item.executable,
          source: item.source,
          selected: item.version === inferredDsh,
          removable: item.source === 'launcher' && item.version !== inferredDsh && !options.isRuntimeRunning(),
        })),
        ...(systemDsh ? [{
          version: systemDsh.version,
          root: path.dirname(systemDsh.executable),
          executable: systemDsh.executable,
          source: 'system' as const,
          selected: systemDsh.version === inferredDsh,
          removable: false,
        }] : []),
      ],
      nodeInstalled: [
        ...nodeVersions.map(item => ({
          version: normalizeNodeVersion(item.version),
          root: item.root,
          executable: item.runtime.node,
          source: item.source,
          selected: normalizeNodeVersion(item.version) === selectedNode,
          removable: item.source === 'launcher' && normalizeNodeVersion(item.version) !== selectedNode && !options.isRuntimeRunning(),
        })),
        ...(systemNode ? [{
          version: 'system',
          root: systemNode.root,
          executable: systemNode.node,
          source: 'system' as const,
          selected: selectedNode === null,
          removable: false,
        }] : []),
      ],
      dshAvailable,
      nodeAvailable,
    }
  }

  async function read(refresh = false): Promise<RuntimeEnvironmentState> {
    const settings = await options.readSettings()
    if (refresh || Date.now() - availableAt > 5 * 60_000 || dshAvailable.length === 0 || nodeAvailable.length === 0) {
      const [dshResult, nodeResult] = await Promise.allSettled([
        listAvailableDshVersions(options.githubFetch),
        import('./node-runtime').then(module => module.listAvailableNodeVersions()),
      ])
      if (dshResult.status === 'fulfilled') dshAvailable = dshResult.value
      if (nodeResult.status === 'fulfilled') nodeAvailable = nodeResult.value
      availableAt = Date.now()
    }
    return readInstalled(settings)
  }

  async function installDsh(version: string): Promise<RuntimeEnvironmentState> {
    const normalized = normalizeDshVersion(version)
    if (!validVersion(normalized)) throw new Error('DSH 版本格式无效。')
    return runExclusive(`安装 DSH ${normalized}`, async () => {
      if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再安装或更新本地 DSH。')
      const settings = await options.readSettings()
      const root = dshVersionRoot(settings.dshInstallPath, normalized)
      await mkdir(root, { recursive: true })
      const manifestPath = path.join(root, 'package.json')
      if (!existsSync(manifestPath)) await writeFile(manifestPath, `${JSON.stringify({ name: 'dsh-launcher-runtime', private: true }, null, 2)}\n`, 'utf8')
      await ensureDshScriptPolicy(manifestPath)
      options.emitProgress(progressFor(normalized, `正在准备 DSH ${normalized} 依赖`, 'preparing', 5))
      try {
        const currentManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
        const existingOverrides = currentManifest.overrides
        const workspacePath = path.join(root, 'pnpm-workspace.yaml')
        const workspaceConfig = existsSync(workspacePath)
          ? parseYaml(await readFile(workspacePath, 'utf8')) as Record<string, unknown> ?? {}
          : {}
        const workspaceOverrides = workspaceConfig.overrides
        const hasPinnedValues = (value: unknown) => value
          && typeof value === 'object'
          && Object.values(value as Record<string, unknown>).length > 0
          && Object.values(value as Record<string, unknown>).every(item => item === normalized)
        const alreadyPinned = hasPinnedValues(existingOverrides) && hasPinnedValues(workspaceOverrides)
        options.emitOutput('info', `[DSH ${normalized}] 正在校验核心包版本，避免 rc 版本混装。`)
        // 依赖可用性检查每次都执行；旧目录可能已经留下了不完整的 overrides，
        // 不能因为“看起来已锁定”就跳过对未发布包的拦截。
        const coreOverrides = await resolveDshCoreOverrides(normalized, fetch, activeAbortController?.signal)
        if (!alreadyPinned && Object.keys(coreOverrides).length > 0) {
            await writeFile(manifestPath, `${JSON.stringify({
              ...currentManifest,
              overrides: coreOverrides,
            }, null, 2)}\n`, 'utf8')
            await writeFile(workspacePath, stringifyYaml({ ...workspaceConfig, overrides: coreOverrides }), 'utf8')
            options.emitOutput('info', `[DSH ${normalized}] 已锁定 ${Object.keys(coreOverrides).length} 个核心包，避免 rc 版本混装。`)
        }
      } catch (error) {
        if (error instanceof MissingDshDependencyError) throw error
        if (cancellationRequested) throw error
        // registry 暂时不可用时仍允许包管理器使用本地缓存继续安装；错误会进入完整日志。
        options.emitOutput('error', `[DSH ${normalized}] 获取核心依赖版本锁定信息失败，将按原始依赖范围继续：${error instanceof Error ? error.message : String(error)}`)
      }
      if (cancellationRequested) throw new Error(`已暂停下载 DSH ${normalized}`)
      options.emitProgress(progressFor(normalized, `正在安装 DSH ${normalized}`, 'preparing', 5))
      const node = await options.prepareNodeRuntime(progress => options.emitProgress(progressFor(normalized, progress.message, 'resolving', Math.max(8, progress.percent))))
      const pnpm = await options.preparePnpmRuntime(node, progress => options.emitProgress(progressFor(normalized, progress.message, 'resolving', Math.max(8, progress.percent))))
      if (cancellationRequested) throw new Error(`已暂停下载 DSH ${normalized}`)
      let currentPercent = 25
      let npmFetchedCount = 0
      let npmPlacedCount = 0
      let lastSummaryKind = ''
      let lastSummaryCount = 0
      let lastOutputAt = Date.now()
      let lastProgressMessage = `正在下载 DSH ${normalized}`
      const handlePackageOutput = (text: string, level: OutputLevel) => {
        lastOutputAt = Date.now()
        options.emitOutput(level, text)
        const fetches = (text.match(/npm\s+(?:http\s+(?:fetch\s+GET|cache)|silly\s+fetch\s+manifest)\b/gi) ?? []).length
        const placements = (text.match(/npm\s+silly\s+placeDep\b/gi) ?? []).length
        npmFetchedCount += fetches
        npmPlacedCount += placements
        const packageName = text.match(/npm\s+silly\s+(?:fetch\s+manifest|placeDep\s+[^\s]+)\s+([^\s]+)/i)?.[1]
        const registryUrl = text.match(/npm\s+http\s+(?:fetch\s+GET\s+\d+|cache)\s+(https?:\/\/registry\.npmjs\.org\/[^\s]+)/i)?.[1]
        const placementStage = /npm\s+silly\s+placeDep\b/i.test(text)
        const stage = placementStage
          ? `正在整理 npm 依赖：${packageName ?? '依赖树节点'}`
          : packageName
            ? `正在解析 npm 依赖：${packageName}`
          : registryUrl
            ? `正在获取 npm 包信息：${decodeURIComponent(new URL(registryUrl).pathname.slice(1)).split('/-/')[0]}`
            : /npm\s+timing\s+idealTree/i.test(text)
              ? '正在完成 npm 依赖树解析'
              : /npm\s+timing\s+reify/i.test(text)
                ? '正在写入 npm node_modules'
                : /npm\s+info\s+run\b/i.test(text)
                  ? '正在执行 npm 安装脚本'
                  : ''
        const stageKind = stage.split('：')[0] ?? stage
        const stageCount = placementStage ? npmPlacedCount : npmFetchedCount
        if (stage && (stageKind !== lastSummaryKind || stageCount - lastSummaryCount >= 25)) {
          lastSummaryKind = stageKind
          lastSummaryCount = stageCount
          lastProgressMessage = stage
          options.emitOutput('info', `[DSH ${normalized}] ${stage}${stageCount > 0 ? `（已处理 ${stageCount} 项）` : ''}`)
        }
        const parsed = packageManagerProgress(text, currentPercent, npmFetchedCount - fetches, npmPlacedCount - placements)
        if (parsed) {
          currentPercent = Math.max(currentPercent, parsed.percent)
          lastProgressMessage = parsed.message
          options.emitProgress(progressFor(normalized, parsed.message, 'downloading', currentPercent))
        }
      }
      const runPackageManagerCommand = (args: string[]) => {
        const heartbeat = setInterval(() => {
          const elapsedSeconds = Math.floor((Date.now() - lastOutputAt) / 1000)
          if (elapsedSeconds < 5) return
          const message = `${lastProgressMessage} · 已等待 ${elapsedSeconds} 秒`
          options.emitProgress(progressFor(normalized, message, 'downloading', currentPercent))
          options.emitOutput('info', `[DSH ${normalized}] ${message}`)
        }, 5_000)
        heartbeat.unref()
        return executeTrackedCommand(pnpm.executable, args, {
          cwd: root,
          env: withExecutableDirectoryOnPath(node.node, {
            ...process.env,
            FORCE_COLOR: '0',
            NPM_CONFIG_UPDATE_NOTIFIER: 'false',
            CI: 'true',
            npm_config_yes: 'true',
            NPM_CONFIG_YES: 'true',
            PNPM_CONFIG_YES: 'true',
            COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
          }),
          onOutput: handlePackageOutput,
        }).finally(() => clearInterval(heartbeat))
      }
      options.emitProgress(progressFor(normalized, lastProgressMessage, 'downloading', currentPercent))
      const result = await runPackageManagerCommand(buildManagedDshPnpmArgs(root, normalized))
      if (result.exitCode !== 0) throw new Error(`DSH ${normalized} 安装失败（代码 ${result.exitCode}）。`)
      if (hasDshScriptPackage(root)) {
        options.emitProgress(progressFor(normalized, `正在执行 ${DSH_SUBPROCESS_LOCAL_PACKAGE} 安装脚本`, 'configuring', 90))
        options.emitOutput('info', `正在执行 ${DSH_SUBPROCESS_LOCAL_PACKAGE} 的安装脚本。`)
        const rebuild = await runPackageManagerCommand([
          'rebuild', '--dir', root, '--reporter=append-only', DSH_SUBPROCESS_LOCAL_PACKAGE,
        ])
        if (rebuild.exitCode !== 0) throw new Error(`DSH ${normalized} 核心依赖安装脚本失败（代码 ${rebuild.exitCode}）。`)
      }
      const executable = managedDshExecutable(root)
      const status = await getManagedDshStatus(root)
      if (!status.installed || !status.executable) throw new Error(`DSH ${normalized} 安装完成但未找到启动入口。`)
      await options.saveSettings({ ...settings, dshVersion: normalized, launchExecutable: executable, launchArgs: ['web'] })
      options.emitProgress(progressFor(normalized, `DSH ${normalized} 已安装`, 'complete', 100))
      return read(true)
    }).catch(error => {
      options.emitProgress(progressFor(normalized, cancellationRequested
        ? `已暂停下载 DSH ${normalized}`
        : `DSH ${normalized} 安装失败：${error instanceof Error ? error.message : String(error)}`, 'error', 0))
      throw error
    })
  }

  async function selectDsh(version: string): Promise<RuntimeEnvironmentState> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再切换版本。')
    const normalized = normalizeDshVersion(version)
    const settings = await options.readSettings()
    const item = (await findManagedDshVersions(settings.dshInstallPath)).find(entry => entry.version === normalized)
    if (!item) throw new Error(`DSH ${normalized} 尚未安装。`)
    await options.saveSettings({ ...settings, dshVersion: normalized, launchExecutable: item.executable, launchArgs: ['web'] })
    return read()
  }

  async function removeDsh(version: string): Promise<RuntimeEnvironmentState> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再删除版本。')
    const normalized = normalizeDshVersion(version)
    const settings = await options.readSettings()
    const item = (await findManagedDshVersions(settings.dshInstallPath)).find(entry => entry.version === normalized)
    if (!item || item.source !== 'launcher') throw new Error('只能删除启动器托管的 DSH 版本。')
    const launchMatches = item.executable.toLowerCase() === settings.launchExecutable.toLowerCase()
    if (settings.dshVersion === normalized || launchMatches) throw new Error('当前 DSH 版本不能删除，请先切换到其他版本。')
    await rm(item.root, { recursive: true, force: true })
    return read()
  }

  async function installNode(version: string): Promise<RuntimeEnvironmentState> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再安装 Node.js 版本。')
    const normalized = normalizeNodeVersion(version)
    if (!validVersion(normalized)) throw new Error('Node.js 版本格式无效。')
    return runExclusive(`安装 Node.js ${normalized}`, async () => {
      options.emitProgress(progressFor(normalized, `正在安装 Node.js ${normalized}`, 'preparing', 5))
      await installManagedNodeRuntime(options.nodeRoot, normalized, progress => options.emitProgress(progressFor(normalized, progress.message, 'downloading', Math.max(8, progress.percent), progress.downloadedBytes, progress.totalBytes)))
      const settings = await options.readSettings()
      await options.saveSettings({ ...settings, nodeVersion: normalized })
      options.emitProgress(progressFor(normalized, `Node.js ${normalized} 已安装`, 'complete', 100))
      return read(true)
    }).catch(error => {
      options.emitProgress(progressFor(normalized, cancellationRequested
        ? `已暂停下载 Node.js ${normalized}`
        : `Node.js ${normalized} 安装失败：${error instanceof Error ? error.message : String(error)}`, 'error', 0))
      throw error
    })
  }

  async function selectNode(version: string | null): Promise<RuntimeEnvironmentState> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再切换 Node.js 版本。')
    const settings = await options.readSettings()
    if (version === null || version === 'system') {
      await options.saveSettings({ ...settings, nodeVersion: null })
      return read()
    }
    const normalized = normalizeNodeVersion(version)
    const item = (await findManagedNodeRuntimes(options.nodeRoot)).find(entry => normalizeNodeVersion(entry.version) === normalized)
    if (!item) throw new Error(`Node.js ${normalized} 尚未安装。`)
    await options.saveSettings({ ...settings, nodeVersion: normalized })
    return read()
  }

  async function removeNode(version: string): Promise<RuntimeEnvironmentState> {
    if (options.isRuntimeRunning()) throw new Error('请先停止 DSH，再删除版本。')
    const normalized = normalizeNodeVersion(version)
    const settings = await options.readSettings()
    if (settings.nodeVersion && normalizeNodeVersion(settings.nodeVersion) === normalized) throw new Error('当前 Node.js 版本不能删除，请先切换到系统或其他版本。')
    const item = (await findManagedNodeRuntimes(options.nodeRoot)).find(entry => normalizeNodeVersion(entry.version) === normalized)
    if (!item || item.source !== 'launcher') throw new Error('只能删除启动器托管的 Node.js 版本。')
    await rm(item.root, { recursive: true, force: true })
    return read()
  }

  return {
    read,
    installDsh,
    selectDsh: version => runExclusive(`切换 DSH ${version}`, () => selectDsh(version)),
    removeDsh: version => runExclusive(`删除 DSH ${version}`, () => removeDsh(version)),
    // installNode 内部已经持有运行环境锁；这里不能再次套 runExclusive，
    // 否则每次 Node.js 安装都会把自己判定为“已有操作进行中”。
    installNode,
    selectNode: version => runExclusive(`切换 Node.js ${version ?? 'system'}`, () => selectNode(version)),
    removeNode: version => runExclusive(`删除 Node.js ${version}`, () => removeNode(version)),
    cancel: async () => {
      if (!activeOperation) return
      cancellationRequested = true
      activeAbortController?.abort()
      const processToStop = activeCommand
      if (processToStop) await terminateCommand(processToStop)
    },
    isBusy: () => activeOperation !== null,
  }
}
