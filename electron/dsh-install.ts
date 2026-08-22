import { access, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { DSH_PACKAGE_NAME, DSH_REPOSITORY } from '../src/constants'
import type { DshInstallationStatus, InstallProgress } from '../src/types'

export { DSH_PACKAGE_NAME, DSH_REPOSITORY }

interface DshDetectionOptions {
  managedRoot: string
  configuredExecutable?: string
  environment?: NodeJS.ProcessEnv
}

export function isDshRepository(fullName: string): boolean {
  return fullName.toLowerCase() === DSH_REPOSITORY
}

export function managedDshExecutable(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
}

function missingDshStatus(): DshInstallationStatus {
  return { installed: false, version: null, executable: null, source: null }
}

function isDshExecutableName(filePath: string): boolean {
  return /^(?:dsh|dsh\.cmd|dsh\.exe)$/i.test(path.basename(filePath))
}

async function pnpmGlobalManifestCandidates(binDirectory: string): Promise<string[]> {
  // pnpm global shims live in PNPM_HOME, while the package itself lives under
  // PNPM_HOME/global/<store-version>/node_modules. A .cmd shim cannot be
  // resolved to that package with realpath, so inspect the known layout.
  const globalRoot = path.join(binDirectory, 'global')
  const entries = await readdir(globalRoot, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(globalRoot, entry.name, 'node_modules', ...DSH_PACKAGE_NAME.split('/'), 'package.json'))
}

async function manifestCandidates(executable: string, resolvedExecutable: string): Promise<string[]> {
  const candidates = new Set<string>()
  const binDirectories = new Set<string>()
  for (const candidateExecutable of [executable, resolvedExecutable]) {
    const binDirectory = path.dirname(candidateExecutable)
    binDirectories.add(binDirectory)
    candidates.add(path.join(binDirectory, 'node_modules', ...DSH_PACKAGE_NAME.split('/'), 'package.json'))
    if (path.basename(binDirectory).toLowerCase() === '.bin') {
      candidates.add(path.join(binDirectory, '..', ...DSH_PACKAGE_NAME.split('/'), 'package.json'))
    }
    let current = binDirectory
    for (let depth = 0; depth < 6; depth += 1) {
      candidates.add(path.join(current, 'package.json'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const pnpmCandidates = await Promise.all([...binDirectories].map(pnpmGlobalManifestCandidates))
  pnpmCandidates.flat().forEach(candidate => candidates.add(candidate))
  return [...candidates]
}

async function inspectDshExecutable(
  executable: string,
  source: DshInstallationStatus['source'],
): Promise<DshInstallationStatus> {
  if (!path.isAbsolute(executable) || !isDshExecutableName(executable)) return missingDshStatus()
  try {
    await access(executable)
    const resolvedExecutable = await realpath(executable).catch(() => executable)
    for (const manifestPath of await manifestCandidates(executable, resolvedExecutable)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (manifest.name !== DSH_PACKAGE_NAME || typeof manifest.version !== 'string' || !manifest.version.trim()) continue
        return { installed: true, version: manifest.version, executable, source }
      } catch {
        // Keep checking other standard npm layouts.
      }
    }
  } catch {
    // Missing and inaccessible candidates are not installations.
  }
  return missingDshStatus()
}

function systemDshCandidates(configuredExecutable: string | undefined, environment: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  if (configuredExecutable && path.isAbsolute(configuredExecutable)) candidates.push(configuredExecutable)

  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path')
  const pathEntries = (pathKey ? environment[pathKey] : '')?.split(path.delimiter).filter(Boolean) ?? []
  const pnpmHomes = process.platform === 'win32'
    ? [
        environment.PNPM_HOME ?? '',
        environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'pnpm') : '',
      ]
    : [
        environment.PNPM_HOME ?? '',
        environment.XDG_DATA_HOME ? path.join(environment.XDG_DATA_HOME, 'pnpm') : '',
        environment.HOME ? path.join(environment.HOME, '.local', 'share', 'pnpm') : '',
        environment.HOME ? path.join(environment.HOME, 'Library', 'pnpm') : '',
      ]
  const extraEntries = process.platform === 'win32'
    ? [
        environment.APPDATA ? path.join(environment.APPDATA, 'npm') : '',
        environment.npm_config_prefix ?? '',
        path.join(environment.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
        ...pnpmHomes,
      ]
    : [environment.npm_config_prefix ? path.join(environment.npm_config_prefix, 'bin') : '', ...pnpmHomes]
  const executableNames = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const entry of [...pathEntries, ...extraEntries]) {
    const normalized = entry.trim().replace(/^"|"$/g, '')
    if (!normalized) continue
    for (const name of executableNames) candidates.push(path.join(normalized, name))
  }

  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const key = process.platform === 'win32' ? path.resolve(candidate).toLowerCase() : path.resolve(candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function findInstalledDsh(options: DshDetectionOptions): Promise<DshInstallationStatus> {
  const managed = await getManagedDshStatus(options.managedRoot)
  if (managed.installed) return managed

  for (const executable of systemDshCandidates(options.configuredExecutable, options.environment ?? process.env)) {
    const detected = await inspectDshExecutable(executable, 'system')
    if (detected.installed) return detected
  }
  return missingDshStatus()
}

export function installWaitingMessage(initialMessage: string, elapsedMilliseconds: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMilliseconds / 1000))
  return elapsedSeconds >= 5 ? `安装中 · 已等待 ${elapsedSeconds} 秒` : initialMessage
}

export function packageManagerProgress(
  text: string,
  currentPercent: number,
  npmFetchedCount = 0,
  npmPlacedCount = 0,
): Pick<InstallProgress, 'percent' | 'message' | 'indeterminate'> | null {
  const pnpmMatches = [...text.matchAll(/Progress:\s*resolved\s+(\d+),\s*reused\s+(\d+),\s*downloaded\s+(\d+),\s*added\s+(\d+)/gi)]
  const pnpm = pnpmMatches.at(-1)
  if (pnpm) {
    const resolved = Number(pnpm[1])
    const reused = Number(pnpm[2])
    const downloaded = Number(pnpm[3])
    const processed = Math.min(resolved, reused + downloaded)
    const percent = resolved > 0 ? 25 + Math.round((processed / resolved) * 55) : 25
    return {
      percent: Math.max(currentPercent, Math.min(80, percent)),
      message: `正在下载：${downloaded} 个新包，${reused} 个已复用`,
    }
  }

  const gitMatches = [...text.matchAll(/Receiving objects:\s*(\d+)%/gi)]
  const git = gitMatches.at(-1)
  if (git) {
    const received = Math.min(100, Number(git[1]))
    return {
      percent: Math.max(currentPercent, 25 + Math.round(received * 0.55)),
      message: `正在下载仓库 ${received}%`,
    }
  }

  // npm verbose 输出没有总包数，不能伪造精确百分比；阶段判断按输出中
  // 更靠后的依赖树动作优先，避免同一批同时包含 fetch/placeDep 时仍显示旧阶段。
  const npmPlacements = (text.match(/npm\s+silly\s+placeDep\b/gi) ?? []).length
  if (npmPlacements > 0) {
    const placed = npmPlacedCount + npmPlacements
    return {
      percent: Math.max(currentPercent, Math.min(86, 78 + Math.floor(placed / 25))),
      message: `正在整理 npm 依赖（已整理 ${placed} 项）`,
    }
  }

  const npmFetches = (text.match(/npm\s+(?:http\s+(?:fetch\s+GET|cache)|silly\s+fetch\s+manifest)\b/gi) ?? []).length
  if (npmFetches > 0) {
    const fetched = npmFetchedCount + npmFetches
    return {
      percent: Math.max(currentPercent, Math.min(75, 34 + Math.min(40, fetched))),
      message: `正在解析 npm 依赖（已请求 ${fetched} 项）`,
      indeterminate: true,
    }
  }

  if (/npm\s+timing\s+idealTree/i.test(text)) {
    return { percent: Math.max(currentPercent, 87), message: '正在完成 npm 依赖树解析' }
  }
  if (/npm\s+timing\s+reify/i.test(text)) {
    return { percent: Math.max(currentPercent, 90), message: '正在写入 npm node_modules' }
  }
  if (/npm\s+info\s+run\b|npm\s+verb\s+(?:reify|audit)/i.test(text)) {
    return { percent: Math.max(currentPercent, 84), message: '正在执行 npm 安装步骤' }
  }

  if (/added\s+\d+\s+packages?/i.test(text) || /Packages:\s*\+\d+/i.test(text)) {
    return { percent: Math.max(currentPercent, 82), message: '下载完成，正在安装依赖' }
  }
  if (/download|fetch|resolve|reify|progress:/i.test(text)) {
    return { percent: Math.max(currentPercent, 35), message: '正在下载所需文件', indeterminate: true }
  }
  return null
}

export async function getManagedDshStatus(runtimeRoot: string): Promise<DshInstallationStatus> {
  const executable = managedDshExecutable(runtimeRoot)
  return inspectDshExecutable(executable, 'launcher')
}
