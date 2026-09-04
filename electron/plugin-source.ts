import { createWriteStream } from 'node:fs'
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { PluginInstallTarget } from '../src/types'
import { isSafeRepositoryName } from './profile'

export interface PluginSourceProgress {
  percent: number
  message: string
  indeterminate?: boolean
  downloadedBytes?: number
  totalBytes?: number
}

type ProgressListener = (progress: PluginSourceProgress) => void

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('插件缓存路径超出了允许范围。')
  }
}
async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function downloadArchive(
  repository: string,
  commit: string,
  destination: string,
  onProgress: ProgressListener,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = `https://codeload.github.com/${repository}/zip/${commit}`
  let response: Response | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetchImpl(url, { headers: { 'User-Agent': 'DSH-Launcher' } })
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) break
    } catch (error) {
      lastError = error
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
  }
  if (!response) throw new Error(`下载插件仓库失败：${lastError instanceof Error ? lastError.message : String(lastError ?? '网络请求失败')}`)
  if (!response.ok || !response.body) throw new Error(`下载插件仓库失败（HTTP ${response.status}）。`)
  const declaredTotal = Number(response.headers.get('content-length'))
  const total = Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : undefined
  const writer = createWriteStream(destination, { flags: 'wx' })
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (!writer.write(Buffer.from(chunk.value))) await once(writer, 'drain')
      const percent = total == null
        ? 20
        : 22 + Math.round(Math.min(1, received / total) * 38)
      onProgress({
        percent,
        message: total == null ? '正在下载仓库' : `正在下载仓库 ${Math.round(received / total * 100)}%`,
        indeterminate: total == null,
        downloadedBytes: received,
        totalBytes: total,
      })
    }
    writer.end()
    await once(writer, 'finish')
  } catch (error) {
    writer.destroy()
    throw error
  }
}

export async function prepareSubdirectoryPlugin(
  cacheRoot: string,
  repository: string,
  target: PluginInstallTarget,
  onProgress: ProgressListener,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!isSafeRepositoryName(repository) || !/^[a-f0-9]{40}$/i.test(target.commit)) {
    throw new Error('插件仓库或提交版本无效。')
  }
  // Root-level GitHub Bundles are valid too. They use the exact same immutable
  // archive flow as a subdirectory Bundle, only without an extra path segment.
  const requestedSubdirectory = target.subdirectory ?? ''
  if (path.posix.isAbsolute(requestedSubdirectory)) throw new Error('插件子目录无效。')
  const normalizedSubdirectory = requestedSubdirectory === '' ? '' : path.posix.normalize(requestedSubdirectory)
  if (normalizedSubdirectory === '..' || normalizedSubdirectory.startsWith('../')) throw new Error('插件子目录超出了仓库范围。')

  const [owner, name] = repository.split('/')
  const repositoryCache = path.join(cacheRoot, owner, name)
  const destination = path.join(repositoryCache, target.commit)
  const packageDirectory = path.join(destination, ...normalizedSubdirectory.split('/'))
  assertInside(cacheRoot, destination)
  assertInside(destination, packageDirectory)
  if (await exists(path.join(packageDirectory, 'package.json'))) return packageDirectory

  await mkdir(repositoryCache, { recursive: true })
  const nonce = `${process.pid}-${Date.now()}`
  const zipPath = path.join(repositoryCache, `.download-${nonce}.zip`)
  const extractPath = path.join(repositoryCache, `.extract-${nonce}`)
  assertInside(cacheRoot, zipPath)
  assertInside(cacheRoot, extractPath)

  try {
    onProgress({ percent: 20, message: '正在下载包含插件组件的仓库', indeterminate: true })
    await downloadArchive(repository, target.commit, zipPath, onProgress, fetchImpl)
    onProgress({ percent: 64, message: '正在解压插件组件' })
    await mkdir(extractPath, { recursive: true })
    new AdmZip(zipPath).extractAllTo(extractPath, true)
    const roots = (await readdir(extractPath, { withFileTypes: true })).filter(entry => entry.isDirectory())
    if (roots.length !== 1) throw new Error('下载的仓库压缩包结构无效。')
    const extractedRoot = path.join(extractPath, roots[0].name)
    const extractedPackage = path.join(extractedRoot, ...normalizedSubdirectory.split('/'))
    assertInside(extractedRoot, extractedPackage)
    if (!await exists(path.join(extractedPackage, 'package.json'))) throw new Error('仓库子目录中没有找到 package.json。')
    if (await exists(destination)) await rm(destination, { recursive: true, force: true })
    await rename(extractedRoot, destination)
    onProgress({ percent: 68, message: '插件组件已准备完成' })
    return packageDirectory
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined)
    await rm(extractPath, { recursive: true, force: true }).catch(() => undefined)
  }
}
