import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { formatCommandLine, spawnCommand, trackSpawnedProcess, withExecutableDirectoryOnPath } from './process'
import type { RuntimeVersionCandidate } from '../src/types'

export const NODE_RUNTIME_VERSION = 'v24.19.0'
export const PNPM_VERSION = '11.21.0'

export interface NodeRuntime {
  root: string
  node: string
  npm: string
  npx: string
  managed: boolean
}

export interface PnpmRuntime {
  root: string
  executable: string
}

export interface NodeRuntimeProgress {
  percent: number
  message: string
  downloadedBytes?: number
  totalBytes?: number
}

type ProgressListener = (progress: NodeRuntimeProgress) => void
type OutputListener = (level: 'info' | 'error', text: string) => void

/** 同一版本只允许一个下载任务；不同版本可以并行准备。 */
const installationPromises = new Map<string, Promise<NodeRuntime>>()
let pnpmInstallationPromise: Promise<PnpmRuntime> | null = null

/**
 * 可执行文件相对于 root 的两种摆放方式。
 *
 * - `bin-directory`：root 本身就是存放可执行文件的目录，例如 PATH 里的 `/usr/bin`。
 * - `distribution-root`：root 是官方发行包解压后的根目录，例如 `node-v24.19.0-linux-x64/`。
 *
 * Windows 上两者一致（zip 与 PATH 目录都是三个文件平铺）；
 * POSIX 上发行包把可执行文件放在 `bin/` 子目录里，差一层。
 */
type RuntimeLayout = 'bin-directory' | 'distribution-root'

export function runtimePaths(root: string, managed: boolean, layout: RuntimeLayout): NodeRuntime {
  if (process.platform === 'win32') {
    return {
      root,
      node: path.join(root, 'node.exe'),
      npm: path.join(root, 'npm.cmd'),
      npx: path.join(root, 'npx.cmd'),
      managed,
    }
  }
  const binary = layout === 'distribution-root' ? path.join(root, 'bin') : root
  return {
    root,
    node: path.join(binary, 'node'),
    npm: path.join(binary, 'npm'),
    npx: path.join(binary, 'npx'),
    managed,
  }
}

function isCompleteRuntime(runtime: NodeRuntime): boolean {
  return existsSync(runtime.node) && existsSync(runtime.npm) && existsSync(runtime.npx)
}

export function pnpmExecutable(runtimeRoot: string): string {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, 'node_modules', '.bin', 'pnpm.cmd')
    : path.join(runtimeRoot, 'node_modules', '.bin', 'pnpm')
}

function isCompletePnpmRuntime(runtime: PnpmRuntime): boolean {
  return existsSync(runtime.executable)
}

async function hasRequiredPnpmVersion(runtime: PnpmRuntime): Promise<boolean> {
  if (!isCompletePnpmRuntime(runtime)) return false
  try {
    const manifestPath = path.join(runtime.root, 'node_modules', 'pnpm', 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown }
    return manifest.version === PNPM_VERSION
  } catch {
    return false
  }
}

export function findSystemNodeRuntime(environment: NodeJS.ProcessEnv = process.env): NodeRuntime | null {
  const entries = (environment.PATH ?? environment.Path ?? environment.path ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  if (process.platform === 'win32') {
    entries.unshift(path.join(environment.ProgramFiles ?? 'C:\\Program Files', 'nodejs'))
  }
  for (const entry of entries) {
    // PATH 里的每一项本身就是可执行文件所在的目录。
    const runtime = runtimePaths(entry.replace(/^"|"$/g, ''), false, 'bin-directory')
    if (isCompleteRuntime(runtime)) return runtime
  }
  return null
}

export function normalizeNodeVersion(version: string): string {
  const normalized = version.trim()
  return normalized.startsWith('v') ? normalized : `v${normalized}`
}

export function managedNodeVersionRoot(runtimeRoot: string, version: string): string {
  return path.join(runtimeRoot, 'versions', normalizeNodeVersion(version))
}

export function nodeArchiveName(versionOrArchitecture = NODE_RUNTIME_VERSION, architecture = process.arch): string {
  // 保留旧的 nodeArchiveName('x64') 调用约定，同时支持 nodeArchiveName('v22.14.0', 'x64')。
  const isArchitecture = versionOrArchitecture === 'x64' || versionOrArchitecture === 'arm64'
  const version = isArchitecture ? NODE_RUNTIME_VERSION : versionOrArchitecture
  const selectedArchitecture = isArchitecture ? versionOrArchitecture : architecture
  const archiveArchitecture = selectedArchitecture === 'arm64' ? 'arm64' : 'x64'
  return `node-${normalizeNodeVersion(version)}-win-${archiveArchitecture}.zip`
}

export function parseNodeArchiveChecksum(checksums: string, archiveName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (match?.[2] === archiveName) return match[1].toLowerCase()
  }
  return null
}

function versionFromNodeDirectory(directory: string): string | null {
  const match = directory.match(/^node-(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-(?:x64|arm64)$/i)
  return match ? normalizeNodeVersion(match[1]) : null
}

export interface ManagedNodeVersion {
  version: string
  runtime: NodeRuntime
  root: string
  source: 'launcher' | 'legacy'
}

export async function findManagedNodeRuntimes(runtimeRoot: string): Promise<ManagedNodeVersion[]> {
  if (!existsSync(runtimeRoot)) return []
  const entries = await readdir(runtimeRoot, { withFileTypes: true })
  const roots: Array<{ root: string; source: 'launcher' | 'legacy' }> = []
  const versionsRoot = path.join(runtimeRoot, 'versions')
  const versionEntries = await readdir(versionsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of versionEntries) {
    if (entry.isDirectory()) roots.push({ root: path.join(versionsRoot, entry.name), source: 'launcher' })
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('node-v')) roots.push({ root: path.join(runtimeRoot, entry.name), source: 'legacy' })
  }
  const found: ManagedNodeVersion[] = []
  for (const item of roots) {
    const runtime = runtimePaths(item.root, true, 'distribution-root')
    const version = item.source === 'launcher'
      ? (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i.test(path.basename(item.root)) ? normalizeNodeVersion(path.basename(item.root)) : null)
      : versionFromNodeDirectory(path.basename(item.root))
    if (version && isCompleteRuntime(runtime)) found.push({ version, runtime, root: item.root, source: item.source })
  }
  return found.sort((left, right) => right.version.localeCompare(left.version, 'en'))
}

export async function findManagedNodeRuntime(runtimeRoot: string, requestedVersion?: string | null): Promise<NodeRuntime | null> {
  const runtimes = await findManagedNodeRuntimes(runtimeRoot)
  if (requestedVersion) {
    const normalized = normalizeNodeVersion(requestedVersion)
    return runtimes.find(item => item.version === normalized)?.runtime ?? null
  }
  return runtimes[0]?.runtime ?? null
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadFile(url: string, target: string, onProgress: (ratio: number, downloadedBytes: number, totalBytes: number | null) => void): Promise<void> {
  const existingSize = existsSync(target) ? (await stat(target)).size : 0
  const response = await fetch(url, {
    redirect: 'follow',
    headers: existingSize > 0 ? { Range: `bytes=${existingSize}-` } : undefined,
  })
  if (response.status === 416 && existingSize > 0) {
    onProgress(1, existingSize, existingSize)
    return
  }
  if (!response.ok || !response.body) throw new Error(`下载 Node.js 运行环境失败（HTTP ${response.status}）。`)
  const resumed = response.status === 206 && existingSize > 0
  const contentLength = Number(response.headers.get('content-length'))
  const contentRange = response.headers.get('content-range')
  const rangeTotal = contentRange ? Number(contentRange.split('/').at(-1)) : Number.NaN
  const total = Number.isFinite(rangeTotal) ? rangeTotal : (resumed ? existingSize : 0) + contentLength
  const file = await open(target, resumed ? 'a' : 'w')
  let received = resumed ? existingSize : 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await file.write(chunk)
      received += chunk.byteLength
      onProgress(
        Number.isFinite(total) && total > 0 ? Math.min(received / total, 1) : 0,
        received,
        Number.isFinite(total) && total > 0 ? total : null,
      )
    }
  } finally {
    await file.close()
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
}

export async function installManagedNodeRuntime(
  runtimeRoot: string,
  version = NODE_RUNTIME_VERSION,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
): Promise<NodeRuntime> {
  if (process.platform !== 'win32') {
    throw new Error('未检测到 Node.js。自动准备运行环境目前仅支持 Windows。')
  }

  const normalizedVersion = normalizeNodeVersion(version)
  const archiveName = nodeArchiveName(normalizedVersion)
  const extractedName = archiveName.slice(0, -4)
  const finalRoot = managedNodeVersionRoot(runtimeRoot, normalizedVersion)
  const existing = runtimePaths(finalRoot, true, 'distribution-root')
  if (isCompleteRuntime(existing)) return existing

  const nonce = `${process.pid}-${Date.now()}`
  const archivePath = path.join(runtimeRoot, archiveName)
  const stagingRoot = path.join(runtimeRoot, `.node-runtime-${nonce}`)
  const baseUrl = `https://nodejs.org/dist/${normalizedVersion}`
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(path.dirname(finalRoot), { recursive: true })
  await mkdir(stagingRoot, { recursive: true })

  try {
    onProgress?.({ percent: 3, message: '正在读取 Node.js 官方校验信息' })
    const checksumResponse = await fetch(`${baseUrl}/SHASUMS256.txt`, { redirect: 'follow' })
    if (!checksumResponse.ok) throw new Error(`读取 Node.js 校验信息失败（HTTP ${checksumResponse.status}）。`)
    const expectedChecksum = parseNodeArchiveChecksum(await checksumResponse.text(), archiveName)
    if (!expectedChecksum) throw new Error('Node.js 官方校验信息中没有找到当前 Windows 安装包。')

    let actualChecksum = existsSync(archivePath) ? await sha256(archivePath) : ''
    if (actualChecksum !== expectedChecksum) {
      onProgress?.({ percent: 8, message: '正在下载 Node.js 便携运行环境' })
      let lastProgress = -1
      const reportDownload = (ratio: number, downloadedBytes: number, totalBytes: number | null) => {
        const percent = 8 + Math.round(ratio * 67)
        if (percent !== lastProgress) {
          lastProgress = percent
          onProgress?.({ percent, message: `正在下载 Node.js ${normalizedVersion}`, downloadedBytes, totalBytes: totalBytes ?? undefined })
        }
      }
      await downloadFile(`${baseUrl}/${archiveName}`, archivePath, reportDownload)
      onProgress?.({ percent: 78, message: '正在校验 Node.js 安装包' })
      actualChecksum = await sha256(archivePath)
      if (actualChecksum !== expectedChecksum) {
        await rm(archivePath, { force: true })
        await downloadFile(`${baseUrl}/${archiveName}`, archivePath, reportDownload)
        actualChecksum = await sha256(archivePath)
      }
    }
    if (actualChecksum !== expectedChecksum) {
      await rm(archivePath, { force: true })
      throw new Error('Node.js 安装包校验失败，请重试。')
    }

    onProgress?.({ percent: 84, message: '正在解压 Node.js 运行环境' })
    const extractor = trackSpawnedProcess(spawn('tar.exe', ['-xf', archivePath, '-C', stagingRoot], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    onOutput?.('info', `命令：${formatCommandLine('tar.exe', ['-xf', archivePath, '-C', stagingRoot])}\n工作目录：${runtimeRoot}`)
    let extractionError = ''
    extractor.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
    extractor.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      extractionError += text
      onOutput?.('error', text)
    })
    const exitCode = await waitForExit(extractor)
    onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
    if (exitCode !== 0) throw new Error(`解压 Node.js 运行环境失败：${extractionError.trim() || `代码 ${exitCode}`}`)

    const stagedRoot = path.join(stagingRoot, extractedName)
    const stagedRuntime = runtimePaths(stagedRoot, true, 'distribution-root')
    if (!isCompleteRuntime(stagedRuntime)) throw new Error('Node.js 运行环境解压后文件不完整。')
    await rm(finalRoot, { recursive: true, force: true })
    await rename(stagedRoot, finalRoot)
    const installed = runtimePaths(finalRoot, true, 'distribution-root')
    await rm(archivePath, { force: true })
    onProgress?.({ percent: 100, message: `Node.js ${normalizedVersion} 已就绪` })
    return installed
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function listAvailableNodeVersions(fetchImpl: typeof fetch = fetch): Promise<RuntimeVersionCandidate[]> {
  const response = await fetchImpl('https://nodejs.org/dist/index.json', { redirect: 'follow' })
  if (!response.ok) throw new Error(`读取 Node.js 版本列表失败（HTTP ${response.status}）。`)
  const entries = await response.json() as Array<{ version?: unknown; date?: unknown; lts?: unknown }>
  return entries
    .filter(entry => typeof entry.version === 'string')
    .map(entry => ({
      version: normalizeNodeVersion(entry.version as string),
      label: typeof entry.lts === 'string' ? entry.lts : null,
      lts: typeof entry.lts === 'string' ? entry.lts : entry.lts === false ? false : null,
      date: typeof entry.date === 'string' ? entry.date : null,
      prerelease: /-/.test(entry.version as string),
    }))
}

export async function ensureNodeRuntime(
  runtimeRoot: string,
  onProgress?: ProgressListener,
  requestedVersion?: string | null,
  onOutput?: OutputListener,
): Promise<NodeRuntime> {
  if (!requestedVersion) {
    const systemRuntime = findSystemNodeRuntime()
    if (systemRuntime) return systemRuntime
  }
  const managedRuntime = await findManagedNodeRuntime(runtimeRoot, requestedVersion)
  if (managedRuntime) return managedRuntime
  const version = normalizeNodeVersion(requestedVersion ?? NODE_RUNTIME_VERSION)
  const key = `${path.resolve(runtimeRoot)}:${version}`.toLowerCase()
  const existing = installationPromises.get(key)
  if (existing) return existing
  const installation = installManagedNodeRuntime(runtimeRoot, version, onProgress, onOutput).finally(() => {
    installationPromises.delete(key)
  })
  installationPromises.set(key, installation)
  return installation
}

async function installManagedPnpmRuntime(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
): Promise<PnpmRuntime> {
  const runtime = { root: runtimeRoot, executable: pnpmExecutable(runtimeRoot) }
  if (await hasRequiredPnpmVersion(runtime)) return runtime

  await mkdir(runtimeRoot, { recursive: true })
  onProgress?.({ percent: 10, message: '正在准备 pnpm 插件运行环境' })
  const args = [
    'install',
    '--prefix', runtimeRoot,
    '--save-exact',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--loglevel=verbose',
    `pnpm@${PNPM_VERSION}`,
  ]
  onOutput?.('info', `命令：${formatCommandLine(nodeRuntime.npm, args)}\n工作目录：${runtimeRoot}`)
  const child = spawnCommand(nodeRuntime.npm, args, {
    cwd: runtimeRoot,
    env: withExecutableDirectoryOnPath(nodeRuntime.node, {
      ...process.env,
      FORCE_COLOR: '0',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    }),
  })
  let diagnostics = ''
  child.stdout.on('data', chunk => onOutput?.('info', chunk.toString('utf8')))
  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8')
    diagnostics = `${diagnostics}${text}`.slice(-8_000)
    onOutput?.('error', text)
  })
  const exitCode = await waitForExit(child)
  onOutput?.(exitCode === 0 ? 'info' : 'error', `命令退出：${exitCode}`)
  if (exitCode !== 0 || !await hasRequiredPnpmVersion(runtime)) {
    throw new Error(`pnpm 插件运行环境准备失败${diagnostics ? `：${diagnostics.trim()}` : `（代码 ${exitCode}）`}`)
  }
  onProgress?.({ percent: 100, message: `pnpm ${PNPM_VERSION} 已就绪` })
  return runtime
}

export async function ensurePnpmRuntime(
  runtimeRoot: string,
  nodeRuntime: NodeRuntime,
  onProgress?: ProgressListener,
  onOutput?: OutputListener,
): Promise<PnpmRuntime> {
  const existing = { root: runtimeRoot, executable: pnpmExecutable(runtimeRoot) }
  if (await hasRequiredPnpmVersion(existing)) return existing
  if (!pnpmInstallationPromise) {
    pnpmInstallationPromise = installManagedPnpmRuntime(runtimeRoot, nodeRuntime, onProgress, onOutput).finally(() => {
      pnpmInstallationPromise = null
    })
  }
  return pnpmInstallationPromise
}

export function resolveNodeExecutable(executable: string, runtime: NodeRuntime): string {
  const name = path.basename(executable).toLowerCase()
  if (name === 'node' || name === 'node.exe') return runtime.node
  if (name === 'npm' || name === 'npm.cmd') return runtime.npm
  if (name === 'npx' || name === 'npx.cmd') return runtime.npx
  return executable
}

export function requiresNodeRuntime(executable: string, args: string[]): boolean {
  const name = path.basename(executable).toLowerCase()
  return ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'dsh', 'dsh.cmd'].includes(name)
    || args.includes('@deepseek-ai/dsh')
    || executable.toLowerCase().includes('dsh-runtime')
}
