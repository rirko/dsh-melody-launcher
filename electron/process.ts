import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'

export interface SpawnedProcessTracker {
  track(child: ChildProcess): void
}

/** 将命令参数格式化为可读、可复制的日志文本；不记录环境变量中的密钥。 */
export function formatCommandLine(executable: string, args: string[]): string {
  const quote = (value: string): string => {
    if (value.length === 0) return '""'
    if (!/[\s"&|<>^()%!]/.test(value)) return value
    return `"${value.replace(/"/g, '""')}"`
  }
  return [executable, ...args].map(quote).join(' ')
}

let processTracker: SpawnedProcessTracker | null = null
const localProcesses = new Set<ChildProcess>()

export function configureProcessTracker(tracker: SpawnedProcessTracker | null): void {
  processTracker = tracker
}

export function trackSpawnedProcess<T extends ChildProcess>(child: T): T {
  localProcesses.add(child)
  const forget = () => localProcesses.delete(child)
  child.once('exit', forget)
  child.once('error', forget)
  processTracker?.track(child)
  return child
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => resolve()
    child.once('exit', finish)
    child.once('error', finish)
  })
}

/**
 * 结束启动器自己创建的进程。监督器通常会先完成同样的工作；这里保留
 * 主进程中的句柄作为兜底，覆盖监督器启动较晚、通信丢失或窗口快速关闭的情况。
 */
export async function shutdownTrackedProcesses(): Promise<void> {
  const processes = [...localProcesses]
  await Promise.allSettled(processes.map(async child => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      await waitForExit(killer)
      return
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // 子进程可能已经在监督器中被结束。
    }
    await waitForExit(child)
  }))
}

interface SpawnCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

function quoteWindowsBatchToken(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('命令参数不能包含换行或空字符。')
  return `"${value.replace(/"/g, '""')}"`
}

export function buildWindowsBatchCommand(executable: string, args: string[]): string {
  return `"${[executable, ...args].map(quoteWindowsBatchToken).join(' ')}"`
}

export function withExecutableDirectoryOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(executable)) return environment
  const executableDirectory = path.dirname(executable)
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const currentPath = environment[pathKey] ?? ''
  const alreadyIncluded = currentPath
    .split(path.delimiter)
    .some(entry => entry.toLowerCase() === executableDirectory.toLowerCase())
  if (alreadyIncluded) return environment
  return {
    ...environment,
    [pathKey]: currentPath ? `${executableDirectory}${path.delimiter}${currentPath}` : executableDirectory,
  }
}

export function spawnCommand(
  executable: string,
  args: string[],
  options: SpawnCommandOptions,
): ChildProcessWithoutNullStreams {
  const environment = withExecutableDirectoryOnPath(executable, options.env)
  const isWindowsBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
  if (isWindowsBatch) {
    const commandInterpreter = environment.ComSpec || process.env.ComSpec || 'cmd.exe'
    return trackSpawnedProcess(spawn(commandInterpreter, [
      '/d',
      '/s',
      '/v:off',
      '/c',
      buildWindowsBatchCommand(executable, args),
    ], {
      ...options,
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
  }

  return trackSpawnedProcess(spawn(executable, args, {
    ...options,
    env: environment,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }))
}
