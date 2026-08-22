import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import path from 'node:path'
import { DSH_PACKAGE_NAME } from '../src/constants'
import type { AppSettings, PluginTrialResult } from '../src/types'
import { resolveNodeExecutable, type NodeRuntime, type PnpmRuntime } from './node-runtime'
import { findAvailableWebPort } from './runtime'
import { formatCommandLine, spawnCommand, withExecutableDirectoryOnPath } from './process'

const TRIAL_PROFILE_NAME = 'trial'
const TRIAL_TIMEOUT_MS = 45_000
const TRIAL_STABILITY_MS = 10_000
const TRIAL_OUTPUT_LIMIT = 48_000
const CORE_BUNDLES = ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base'] as const

interface ProfileManifest {
  dependencies?: Record<string, string>
}

interface TrialStoreFile {
  version: 2
  results: PluginTrialResult[]
}

export interface PluginTrialManagerOptions {
  readSettings: () => Promise<AppSettings>
  prepareNodeRuntime: () => Promise<NodeRuntime>
  preparePnpmRuntime: (nodeRuntime: NodeRuntime) => Promise<PnpmRuntime>
  trialRoot: string
  resultsPath: string
  emitOutput: (level: 'info' | 'error' | 'success', text: string) => void
  emitResult: (result: PluginTrialResult) => void
  isRuntimeRunning: () => boolean
  isInstallerBusy: () => boolean
  timeoutMs?: number
  /** 测试注入：真实环境缺省使用统一的 spawnCommand。 */
  spawnProcess?: typeof spawnCommand
  observeProcess?: typeof observeTrialProcess
  findPort?: typeof findAvailableWebPort
  killProcess?: typeof killProcessTree
}

export interface PluginTrialManager {
  trial(packageName: string, profileName?: string): Promise<PluginTrialResult>
  list(): Promise<PluginTrialResult[]>
  latestFailure(packageName: string, profileName?: string): Promise<PluginTrialResult>
  isBusy(): boolean
  cancel(): Promise<void>
}

export function pluginTrialKey(profileName: string, packageName: string): string {
  return `${profileName}\u0000${packageName}`
}

export function buildTrialManifest(packageName: string, specifier: string): object {
  return {
    name: 'dsh-plugin-trial',
    private: true,
    dsh: { profile: { bundles: [...CORE_BUNDLES, packageName] } },
    dependencies: { [packageName]: specifier },
  }
}

export function buildTrialLaunch(
  settings: AppSettings,
  nodeRuntime: NodeRuntime,
  profileName: string,
  port: number,
): { executable: string; args: string[] } {
  let executable = resolveNodeExecutable(settings.launchExecutable, nodeRuntime)
  const executableName = path.basename(executable).toLowerCase()
  if (executableName === 'dsh' || executableName === 'dsh.cmd') {
    return { executable, args: ['--profile', profileName, '--port', String(port)] }
  }

  const packageIndex = settings.launchArgs.indexOf(DSH_PACKAGE_NAME)
  if (packageIndex >= 0 && /^(?:npx|npx\.cmd)$/i.test(executableName)) {
    return {
      executable,
      args: [...settings.launchArgs.slice(0, packageIndex + 1), '--profile', profileName, '--port', String(port)],
    }
  }

  executable = nodeRuntime.npx
  return {
    executable,
    args: ['--yes', DSH_PACKAGE_NAME, '--profile', profileName, '--port', String(port)],
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  try {
    await rename(temporary, filePath)
  } catch {
    await writeFile(filePath, content, 'utf8')
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (ready: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ready)
    }
    socket.setTimeout(350)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    await new Promise<void>(resolve => {
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
    return
  }
  child.kill('SIGTERM')
}

interface ProcessOutcome {
  passed: boolean
  message: string
  output: string
  url: string | null
}

function observeTrialProcess(
  child: ChildProcessWithoutNullStreams,
  port: number,
  timeoutMs: number,
  onOutput: (text: string, level: 'info' | 'error') => void,
): Promise<ProcessOutcome> {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    let checking = false
    let portReadyAt: number | null = null
    const append = (level: 'info' | 'error') => (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      output = `${output}${text}`.slice(-TRIAL_OUTPUT_LIMIT)
      onOutput(text, level)
    }
    child.stdout.on('data', append('info'))
    child.stderr.on('data', append('error'))

    const finish = (outcome: ProcessOutcome) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timeout)
      resolve(outcome)
    }
    child.once('error', error => finish({
      passed: false,
      message: `试运行进程无法启动：${error.message}`,
      output: `${output}\n${error.stack ?? error.message}`.trim(),
      url: null,
    }))
    child.once('exit', code => finish({
      passed: false,
      message: `插件试运行异常退出（代码 ${code ?? '未知'}）。`,
      output,
      url: null,
    }))

    const poll = setInterval(() => {
      if (checking || settled) return
      checking = true
      void portAcceptsConnections(port)
        .then(ready => {
          if (!ready) {
            portReadyAt = null
            return
          }
          if (portReadyAt === null) {
            portReadyAt = Date.now()
            onOutput(`隔离 Web 端口 ${port} 已开始监听，继续观察 ${TRIAL_STABILITY_MS / 1000} 秒以确认插件树稳定。\n`, 'info')
            return
          }
          if (Date.now() - portReadyAt >= TRIAL_STABILITY_MS) {
            finish({
              passed: true,
              message: `隔离 Web 服务已稳定运行 ${TRIAL_STABILITY_MS / 1000} 秒，插件通过试运行。`,
              output,
              url: `http://127.0.0.1:${port}/`,
            })
          }
        })
        .finally(() => { checking = false })
    }, 250)
    const timeout = setTimeout(() => finish({
      passed: false,
      message: `插件试运行超过 ${Math.round(timeoutMs / 1000)} 秒，未检测到 Web 服务。`,
      output,
      url: null,
    }), timeoutMs)
  })
}

export function createPluginTrialManager(options: PluginTrialManagerOptions): PluginTrialManager {
  let active: PluginTrialResult | null = null
  let activeChild: ChildProcessWithoutNullStreams | null = null
  let cancelRequested = false
  let cachedResults: Map<string, PluginTrialResult> | null = null
  const spawnProcess = options.spawnProcess ?? spawnCommand
  const waitForStartup = options.observeProcess ?? observeTrialProcess
  const selectPort = options.findPort ?? findAvailableWebPort
  const stopProcess = options.killProcess ?? killProcessTree

  async function loadResults(): Promise<Map<string, PluginTrialResult>> {
    if (cachedResults) return cachedResults
    const next = new Map<string, PluginTrialResult>()
    try {
      const stored = await readJson<TrialStoreFile>(options.resultsPath)
      if (stored.version !== 2) {
        cachedResults = next
        return next
      }
      for (const result of stored.results ?? []) {
        if (result.phase === 'passed' || result.phase === 'failed') {
          next.set(pluginTrialKey(result.profileName, result.packageName), result)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.emitOutput('error', `读取插件试运行记录失败：${(error as Error).message}`)
      }
    }
    cachedResults = next
    return next
  }

  async function persist(result: PluginTrialResult): Promise<void> {
    const results = await loadResults()
    results.set(pluginTrialKey(result.profileName, result.packageName), result)
    await atomicWrite(options.resultsPath, `${JSON.stringify({ version: 2, results: [...results.values()] }, null, 2)}\n`)
  }

  async function trial(packageName: string, profileOverride?: string): Promise<PluginTrialResult> {
    if (active) throw new Error(`正在试运行 ${active.packageName}，请等待当前任务结束。`)
    if (options.isRuntimeRunning()) throw new Error('请先停止正在运行的 DSH，再试运行插件。')
    if (options.isInstallerBusy()) throw new Error('插件安装正在进行，请稍后再试运行。')

    const settings = await options.readSettings()
    cancelRequested = false
    const profileName = profileOverride ?? settings.profileName
    const startedAt = new Date().toISOString()
    active = {
      packageName,
      profileName,
      phase: 'running',
      message: '正在创建仅包含 DSH 核心与当前插件的隔离环境…',
      diagnostics: '',
      startedAt,
      testedAt: null,
      durationMs: null,
      url: null,
    }
    options.emitResult(active)
    options.emitOutput('info', `插件试运行：${packageName}（来源 Profile：${profileName}）`)

    const sessionRoot = path.join(options.trialRoot, `${Date.now()}-${process.pid}`)
    const trialHome = path.join(sessionRoot, 'dsh-home')
    const trialProfileDir = path.join(trialHome, 'profiles', TRIAL_PROFILE_NAME)
    let child: ChildProcessWithoutNullStreams | null = null
    const startedMs = Date.now()
    try {
      const sourceProfileDir = path.join(settings.dshHome, 'profiles', profileName)
      const sourceManifestPath = path.join(sourceProfileDir, 'package.json')
      const sourceManifest = await readJson<ProfileManifest>(sourceManifestPath)
      const specifier = sourceManifest.dependencies?.[packageName]
      if (!specifier) throw new Error(`当前 Profile 的 dependencies 中没有 ${packageName}，无法建立隔离试运行。`)

      const linkedSource = path.join(sourceProfileDir, 'node_modules', ...packageName.split('/'))
      if (!await pathExists(linkedSource)) throw new Error(`插件文件不存在：${linkedSource}`)
      const packageSource = await realpath(linkedSource)

      await mkdir(trialProfileDir, { recursive: true })
      await writeFile(
        path.join(trialProfileDir, 'package.json'),
        `${JSON.stringify(buildTrialManifest(packageName, specifier), null, 2)}\n`,
        'utf8',
      )
      const packageTarget = path.join(trialProfileDir, 'node_modules', ...packageName.split('/'))
      await mkdir(path.dirname(packageTarget), { recursive: true })
      await symlink(packageSource, packageTarget, process.platform === 'win32' ? 'junction' : 'dir')

      const nodeRuntime = await options.prepareNodeRuntime()
      const pnpmRuntime = await options.preparePnpmRuntime(nodeRuntime)
      const port = await selectPort(settings.webPort, 30)
      if (port === null) throw new Error(`从端口 ${settings.webPort} 开始未找到可用的试运行端口。`)
      const launch = buildTrialLaunch(settings, nodeRuntime, TRIAL_PROFILE_NAME, port)
      const cwd = await pathExists(settings.workspace) ? settings.workspace : trialHome
      const environment = withExecutableDirectoryOnPath(
        launch.executable,
        withExecutableDirectoryOnPath(
          pnpmRuntime.executable,
          withExecutableDirectoryOnPath(nodeRuntime.node, {
            ...process.env,
            DSH_HOME: trialHome,
            DSH_TELEMETRY_DISABLED: '1',
            FORCE_COLOR: '0',
          }),
        ),
      )
      const commandLine = formatCommandLine(launch.executable, launch.args)
      if (cancelRequested) throw new Error('插件试运行已取消。')
      options.emitOutput('info', `隔离启动：${commandLine}`)
      child = spawnProcess(launch.executable, launch.args, { cwd, env: environment })
      activeChild = child
      const outcome = await waitForStartup(
        child,
        port,
        options.timeoutMs ?? TRIAL_TIMEOUT_MS,
        (text, level) => options.emitOutput(level, text),
      )
      const diagnostics = [
        `插件：${packageName}`,
        `来源 Profile：${profileName}`,
        `依赖声明：${specifier}`,
        `隔离命令：${commandLine}`,
        `结果：${outcome.message}`,
        '',
        outcome.output.trim() || '进程没有输出诊断信息。',
      ].join('\n').slice(-TRIAL_OUTPUT_LIMIT)
      const result: PluginTrialResult = {
        packageName,
        profileName,
        phase: outcome.passed ? 'passed' : 'failed',
        message: outcome.message,
        diagnostics,
        startedAt,
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        url: outcome.url,
      }
      await persist(result)
      options.emitResult(result)
      options.emitOutput(outcome.passed ? 'success' : 'error', outcome.message)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result: PluginTrialResult = {
        packageName,
        profileName,
        phase: 'failed',
        message,
        diagnostics: `插件：${packageName}\n来源 Profile：${profileName}\n结果：${message}`,
        startedAt,
        testedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        url: null,
      }
      await persist(result).catch(() => undefined)
      options.emitResult(result)
      options.emitOutput('error', message)
      return result
    } finally {
      if (child) await stopProcess(child)
      if (activeChild === child) activeChild = null
      await rm(sessionRoot, { recursive: true, force: true }).catch(() => undefined)
      active = null
      cancelRequested = false
    }
  }

  async function list(): Promise<PluginTrialResult[]> {
    const stored = [...(await loadResults()).values()]
    if (!active) return stored
    return [...stored.filter(item => pluginTrialKey(item.profileName, item.packageName) !== pluginTrialKey(active!.profileName, active!.packageName)), active]
  }

  async function latestFailure(packageName: string, profileName?: string): Promise<PluginTrialResult> {
    const settings = await options.readSettings()
    const resolvedProfile = profileName ?? settings.profileName
    const result = (await loadResults()).get(pluginTrialKey(resolvedProfile, packageName))
    if (!result || result.phase !== 'failed') throw new Error('没有找到该插件最近一次失败的试运行诊断。')
    return result
  }

  return {
    trial,
    list,
    latestFailure,
    isBusy: () => active !== null,
    cancel: async () => {
      cancelRequested = true
      if (activeChild) await stopProcess(activeChild)
    },
  }
}
