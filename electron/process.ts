import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
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

/** 终止整个子进程树（Windows 用 taskkill /T /F，其他平台 SIGTERM）。 */
export async function killChildProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        killer.kill()
        resolve()
      }, 5_000)
      const finish = () => {
        clearTimeout(timeout)
        resolve()
      }
      killer.once('error', finish)
      killer.once('exit', finish)
    })
  } else {
    child.kill('SIGTERM')
  }
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
 * 结束一条命令及其后代进程。Windows 下插件安装通常经过 cmd -> dsh ->
 * pnpm 多层包装，只结束最外层 Node 进程会把 pnpm 留在后台继续占用 Profile。
 */
export async function terminateProcessTree(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>): Promise<void> {
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
    // 子进程可能已经退出，或已经被其他监督器结束。
  }
  await waitForExit(child as ChildProcess)
}

/**
 * 结束启动器自己创建的进程。监督器通常会先完成同样的工作；这里保留
 * 主进程中的句柄作为兜底，覆盖监督器启动较晚、通信丢失或窗口快速关闭的情况。
 */
export async function shutdownTrackedProcesses(): Promise<void> {
  const processes = [...localProcesses]
  await Promise.allSettled(processes.map(async child => {
    await terminateProcessTree(child)
  }))
}

interface SpawnCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** 普通安装命令不应保留一个永不关闭的 stdin；ACP 等交互进程仍使用默认 pipe。 */
  stdin?: 'pipe' | 'ignore'
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
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams)
  }

  return trackSpawnedProcess(spawn(executable, args, {
    ...options,
    env: environment,
    windowsHide: true,
    stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  }) as unknown as ChildProcessWithoutNullStreams)
}

/**
 * Resolve a Git executable for package-manager child processes.
 *
 * pnpm invokes `git` itself for GitHub dependencies. Electron applications can
 * be launched with a reduced PATH (for example from a shortcut), even when Git
 * is installed normally, so looking only at the parent process is not enough.
 * Keep this lookup synchronous: it runs immediately before spawning an install
 * command and must not start another process that could itself depend on PATH.
 */
export function findGitExecutable(environment: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = [environment.GIT_EXECUTABLE, environment.GIT_EXE]
    .find(value => typeof value === 'string' && value.trim().length > 0)
  const candidates: string[] = []
  if (explicit) candidates.push(explicit.trim().replace(/^"|"$/g, ''))

  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path')
  const pathEntries = (pathKey ? environment[pathKey] : '')
    ?.split(path.delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean) ?? []
  for (const entry of pathEntries) {
    // PATH entries are directories, but accepting a direct git.exe path makes
    // the helper work with custom launcher configurations as well.
    candidates.push(/\.exe$/i.test(entry) ? entry : path.join(entry, process.platform === 'win32' ? 'git.exe' : 'git'))
  }

  if (process.platform === 'win32') {
    const programFiles = environment.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = environment.LOCALAPPDATA
    const userProfile = environment.USERPROFILE ?? environment.HOME
    candidates.push(
      path.join(programFiles, 'Git', 'cmd', 'git.exe'),
      path.join(programFiles, 'Git', 'bin', 'git.exe'),
      path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
      path.join(programFilesX86, 'Git', 'bin', 'git.exe'),
      ...(localAppData ? [path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe')] : []),
      ...(localAppData ? [path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe')] : []),
      ...(userProfile ? [path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe')] : []),
      path.join(programFiles, 'GitHub Desktop', 'resources', 'app', 'git', 'cmd', 'git.exe'),
    )
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git')
  }

  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.toLowerCase())) continue
    seen.add(candidate.toLowerCase())
    if (existsSync(candidate)) return path.resolve(candidate)
  }
  return null
}

/** Add the resolved Git directory to a child-process environment. */
export function withGitOnPath(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const executable = findGitExecutable(environment)
  if (!executable) return environment
  const withGit = withExecutableDirectoryOnPath(executable, environment)
  // Never allow a Git dependency to wait for credentials or an interactive
  // editor in the launcher terminal.
  return {
    ...withGit,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  }
}

export function gitUnavailableMessage(): string {
  return '未找到 Git。GitHub 源插件需要 Git for Windows，请安装 Git 并重新启动启动器，或把 git.exe 加入系统 PATH。'
}

/** True when pnpm output identifies a missing Git executable. */
export function isGitUnavailableOutput(output: string): boolean {
  return /(?:git(?:\.exe)?["'`]?\s*(?:不是内部或外部命令|is not recognized|command not found)|spawn\s+git(?:\.exe)?\s+ENOENT|failed to spawn git|exec(?:utive)?\s+git(?:\.exe)?.*ENOENT|Command failed with exit code \d+:\s*git(?:\.exe)?\s+-c\s+["']?core\.longpaths=true["']?\s+init[\s\S]{0,500}(?:ENOENT|不是内部|not recognized|command not found|\uFFFD{2,}))/i.test(output)
}

/** Whether an install specifier asks pnpm to fetch a GitHub repository. */
export function isGitHostedSpecifier(value: string): boolean {
  return /^(?:github:|git\+https?:\/\/|git:\/\/|https?:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?(?:#|$))/i.test(value.trim())
}
