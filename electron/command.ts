import { formatCommandLine, spawnCommand, terminateProcessTree } from './process'

/**
 * 「启动子进程 → 转发输出 → 收集输出 → 等待退出码」这套流程原本在
 * 插件命令和 DSH 本体安装两处各写了一遍。这里抽成单一实现。
 */

export type OutputLevel = 'info' | 'error'

/** 只描述本模块真正用到的部分，便于测试传入替身。 */
export interface CommandProcess {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  pid?: number
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
  kill?: (signal?: NodeJS.Signals | number) => boolean
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
}

export interface CollectOptions {
  /** 每段输出到达时回调，用于转发到日志面板和进度解析。 */
  onOutput?: (text: string, level: OutputLevel) => void
  /** 保留的输出上限（字符数），只保留末尾部分。 */
  captureLimit?: number
  /** 连续没有任何子进程输出时的保护时间；不设置则一直等待。 */
  inactivityTimeoutMs?: number
  /** 子进程无输出超时时的附加通知。 */
  onTimeout?: (timeoutMs: number) => void
  /** 超过该时长（毫秒）后终止整个子进程树，并以 exitCode -1 返回。 */
  timeoutMs?: number
}

export interface CommandOptions extends CollectOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** 进程启动后回调，供运行环境取消当前下载。 */
  onSpawn?: (child: ReturnType<typeof spawnCommand>) => void
}

export interface CommandResult {
  exitCode: number
  /** 末尾若干字符的合并输出（stdout 与 stderr 按到达顺序）。 */
  output: string
}

export const DEFAULT_CAPTURE_LIMIT = 48_000

export class CommandTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`命令连续 ${Math.ceil(timeoutMs / 1000)} 秒没有输出，已终止命令及其子进程。`)
    this.name = 'CommandTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** 监听一个已启动的子进程直到退出。子进程报错时 reject。 */
export function collectCommandOutput(child: CommandProcess, options: CollectOptions = {}): Promise<CommandResult> {
  const limit = options.captureLimit ?? DEFAULT_CAPTURE_LIMIT
  const inactivityTimeoutMs = options.inactivityTimeoutMs && options.inactivityTimeoutMs > 0
    ? options.inactivityTimeoutMs
    : undefined
  let output = ''
  let inactivityTimer: NodeJS.Timeout | undefined
  let absoluteTimer: NodeJS.Timeout | undefined
  let settled = false
  let idleTimedOut = false
  let absoluteTimedOut = false

  const clearInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer)
    inactivityTimer = undefined
  }

  const armInactivityTimer = (onTimeout: () => void) => {
    if (!inactivityTimeoutMs || settled) return
    clearInactivityTimer()
    inactivityTimer = setTimeout(onTimeout, inactivityTimeoutMs)
    inactivityTimer.unref?.()
  }

  const handle = (level: OutputLevel) => (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    output = `${output}${text}`.slice(-limit)
    options.onOutput?.(text, level)
    armInactivityTimer(onIdleTimeout)
  }

  const onIdleTimeout = () => {
    if (settled || idleTimedOut || absoluteTimedOut || !inactivityTimeoutMs) return
    idleTimedOut = true
    clearInactivityTimer()
    options.onTimeout?.(inactivityTimeoutMs)
    const error = new CommandTimeoutError(inactivityTimeoutMs)
    // Do not wait for a broken child to emit `exit`: on Windows a DSH CLI can
    // synchronously wait for pnpm, while taskkill must terminate the full tree.
    void terminateProcessTree(child as Parameters<typeof terminateProcessTree>[0])
      .catch(() => undefined)
      .finally(() => {
        if (settled) return
        settled = true
        rejectPromise?.(error)
      })
  }

  child.stdout.on('data', handle('info'))
  child.stderr.on('data', handle('error'))

  let rejectPromise: ((error: Error) => void) | undefined
  return new Promise<CommandResult>((resolve, reject) => {
    rejectPromise = reject
    armInactivityTimer(onIdleTimeout)
    const absoluteTimeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined
    const onAbsoluteTimeout = () => {
      if (settled || idleTimedOut || absoluteTimedOut || !absoluteTimeoutMs) return
      absoluteTimedOut = true
      clearInactivityTimer()
      output = `${output}[命令执行超时（${Math.round(absoluteTimeoutMs / 1000)} 秒），已自动终止]\n`.slice(-limit)
      // Do not wait for a wrapper process to forward its exit event. The
      // process-tree helper terminates pnpm/dsh descendants as well.
      void terminateProcessTree(child as Parameters<typeof terminateProcessTree>[0])
        .catch(() => undefined)
        .finally(() => {
          if (settled) return
          settled = true
          if (absoluteTimer) clearTimeout(absoluteTimer)
          resolve({ exitCode: -1, output })
        })
    }
    if (absoluteTimeoutMs) {
      absoluteTimer = setTimeout(onAbsoluteTimeout, absoluteTimeoutMs)
      absoluteTimer.unref?.()
    }
    child.once('error', error => {
      if (settled || idleTimedOut || absoluteTimedOut) return
      settled = true
      clearInactivityTimer()
      if (absoluteTimer) clearTimeout(absoluteTimer)
      reject(error)
    })
    child.once('exit', code => {
      if (settled || idleTimedOut || absoluteTimedOut) return
      settled = true
      clearInactivityTimer()
      resolve({ exitCode: code ?? 1, output })
      if (absoluteTimer) clearTimeout(absoluteTimer)
    })
  })
}

/** 启动一条命令并等待它结束。 */
export async function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const commandLine = formatCommandLine(executable, args)
  options.onOutput?.(`命令：${commandLine}\n工作目录：${options.cwd}`, 'info')
  let child
  try {
    child = spawnCommand(executable, args, { cwd: options.cwd, env: options.env, stdin: 'ignore' })
    options.onSpawn?.(child)
  } catch (error) {
    options.onOutput?.(`命令启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    throw error
  }
  let result: CommandResult
  try {
    result = await collectCommandOutput(child, options)
  } catch (error) {
    options.onOutput?.(`命令执行异常：${error instanceof Error ? error.message : String(error)}`, 'error')
    throw error
  }
  options.onOutput?.(`命令退出：${result.exitCode}`, result.exitCode === 0 ? 'info' : 'error')
  return result
}
