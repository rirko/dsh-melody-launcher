import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { InstalledPreset, PresetInstallTarget } from '../src/types'
import { downloadGitHubArchive, githubArchiveUrl } from './github-archive'
import { isSafeRepositoryName } from './profile'
import { removePresetReceipt } from './preset-receipts'
import { isSkillName } from './skill-format'

const MAX_FILES = 5000
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_FILES = 12_000

/** DSH agent-preset 的清单文件：目录存在此文件即视为已安装该预设。 */
const PRESET_MANIFEST = 'preset.yml'

export interface PresetInstallProgress {
  percent: number
  message: string
  indeterminate?: boolean
  downloadedBytes?: number
  totalBytes?: number
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Windows 上 `fs.rm` 递归删除大目录可能瞬时失败（ENOTEMPTY/EPERM，通常由杀毒
 * 软件短时占用触发）。删除 staging 目录是尽力而为的清理，多试几次再放弃。
 */
async function removeRecursive(target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 2) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('预设安装路径超出了允许范围。')
  }
}

function safeArchivePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
  return normalized
}

function safeRevision(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

async function downloadArchive(
  repository: string,
  revision: string,
  destination: string,
  onProgress: (progress: PresetInstallProgress) => void,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (!fetchImpl) {
    const archive = await downloadGitHubArchive(repository, revision, MAX_ARCHIVE_BYTES, (received, total) => {
      if (total) onProgress({ percent: 18 + Math.round(Math.min(1, received / total) * 42), message: `正在下载预设 ${Math.round(received / total * 100)}%`, downloadedBytes: received, totalBytes: total })
    })
    await writeFile(destination, archive, { flag: 'wx' })
    return
  }
  const response = await fetchImpl(githubArchiveUrl(repository, revision), {
    headers: { 'User-Agent': 'DSH-Launcher' },
  })
  if (!response.ok || !response.body) throw new Error(`下载预设仓库失败（HTTP ${response.status}）。`)
  const total = Number(response.headers.get('content-length'))
  if (Number.isFinite(total) && total > MAX_ARCHIVE_BYTES) throw new Error('预设仓库压缩包过大，已停止安装。')
  const writer = createWriteStream(destination, { flags: 'wx' })
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > MAX_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('预设仓库压缩包过大，已停止安装。')
      }
      if (!writer.write(Buffer.from(chunk.value))) await once(writer, 'drain')
      if (Number.isFinite(total) && total > 0) {
        onProgress({ percent: 18 + Math.round(Math.min(1, received / total) * 42), message: `正在下载预设 ${Math.round(received / total * 100)}%`, downloadedBytes: received, totalBytes: total })
      }
    }
    writer.end()
    await once(writer, 'finish')
  } catch (error) {
    writer.destroy()
    throw error
  }
}

async function replacePath(staged: string, destination: string): Promise<void> {
  const backup = `${destination}.dsh-launcher-backup-${process.pid}-${Date.now()}`
  const hadDestination = await exists(destination)
  if (hadDestination) await rename(destination, backup)
  try {
    await rename(staged, destination)
    if (hadDestination) await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (hadDestination && await exists(backup) && !await exists(destination)) await rename(backup, destination)
    throw error
  }
}

/**
 * 从子模块仓库安装一个 agent-preset：下载仓库 zip（pin commit），
 * 只抽取 `sourcePath` 目录复制到 `~/.dsh/.agent-presets/<name>`。
 * 安全防线与 skill-install 对齐（文件数 / 解包体积 / 路径穿越 / 原子替换）。
 */
export async function installPresetFromRepository(
  cacheRoot: string,
  dshHome: string,
  repository: string,
  target: PresetInstallTarget,
  onProgress: (progress: PresetInstallProgress) => void,
  fetchImpl?: typeof fetch,
): Promise<InstalledPreset> {
  if (!isSafeRepositoryName(repository) || !safeRevision(target.revision) || !isSkillName(target.name)) {
    throw new Error('预设仓库、版本或名称无效。')
  }
  const sourcePath = safeArchivePath(target.sourcePath)
  if (!sourcePath) throw new Error('预设来源路径无效。')

  await mkdir(cacheRoot, { recursive: true })
  const presetRoot = path.join(dshHome, '.agent-presets')
  const stagingRoot = path.join(dshHome, '.preset-staging', `${process.pid}-${Date.now()}`)
  const zipPath = path.join(cacheRoot, `.preset-${process.pid}-${Date.now()}.zip`)
  assertInside(cacheRoot, zipPath)
  assertInside(dshHome, stagingRoot)
  await mkdir(stagingRoot, { recursive: true })

  try {
    onProgress({ percent: 12, message: '正在下载预设仓库', indeterminate: true })
    await downloadArchive(repository, target.revision, zipPath, onProgress, fetchImpl)
    onProgress({ percent: 64, message: '正在核对预设文件' })
    const archive = new AdmZip(zipPath)
    const entries = archive.getEntries()
    if (entries.length > MAX_ARCHIVE_FILES) throw new Error('预设仓库文件数量超过安全限制。')
    const firstFile = entries.find(entry => !entry.isDirectory)
    const archiveRoot = firstFile?.entryName.split('/')[0]
    if (!archiveRoot) throw new Error('预设仓库压缩包结构无效。')

    const staged = path.join(stagingRoot, target.name)
    let copiedFiles = 0
    let unpackedBytes = 0
    for (const entry of entries) {
      if (entry.isDirectory) continue
      const archivePath = safeArchivePath(entry.entryName)
      if (!archivePath || !archivePath.startsWith(`${archiveRoot}/`)) throw new Error('预设压缩包包含不安全路径。')
      const repositoryPath = archivePath.slice(archiveRoot.length + 1)
      if (!repositoryPath.startsWith(`${sourcePath}/`)) continue
      const relativePath = repositoryPath.slice(sourcePath.length + 1)
      const safeRelative = safeArchivePath(relativePath)
      if (!safeRelative) throw new Error('预设组件包含不安全路径。')
      copiedFiles += 1
      unpackedBytes += Number(entry.header.size) || 0
      if (copiedFiles > MAX_FILES || unpackedBytes > MAX_UNPACKED_BYTES) throw new Error('预设组件体积或文件数量超过安全限制。')
      const outputPath = path.join(staged, ...safeRelative.split('/'))
      assertInside(stagingRoot, outputPath)
      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(outputPath, entry.getData())
    }

    const manifest = path.join(staged, PRESET_MANIFEST)
    if (!await exists(manifest)) throw new Error('下载内容缺少 preset.yml，不再是最初确认的预设。')

    onProgress({ percent: 84, message: '正在写入 DSH 预设目录' })
    await mkdir(presetRoot, { recursive: true })
    const destination = path.join(presetRoot, target.name)
    assertInside(presetRoot, destination)
    await replacePath(staged, destination)
    onProgress({ percent: 96, message: '正在验证本地预设' })
    return { name: target.name, path: destination, enabled: true }
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined)
    await removeRecursive(stagingRoot).catch(() => undefined)
  }
}

/**
 * 从本地目录安装 Agent 预设（raw 整合包扫描导入用）。
 * 目录必须包含 preset.yml；复制到 staging 后原子替换进 `.agent-presets/<name>`。
 */
export async function installPresetFromDirectory(
  dshHome: string,
  name: string,
  sourceDir: string,
): Promise<InstalledPreset> {
  if (!isSkillName(name)) throw new Error('预设名称无效。')
  if (!path.isAbsolute(sourceDir)) throw new Error('预设目录必须是绝对路径。')
  if (!await exists(path.join(sourceDir, PRESET_MANIFEST))) throw new Error('预设目录缺少 preset.yml。')

  const presetRoot = path.join(dshHome, '.agent-presets')
  const stagingRoot = path.join(dshHome, '.preset-staging', `${process.pid}-${Date.now()}`)
  assertInside(dshHome, stagingRoot)
  const staged = path.join(stagingRoot, name)

  try {
    await mkdir(staged, { recursive: true })
    await cp(sourceDir, staged, { recursive: true })
    if (!await exists(path.join(staged, PRESET_MANIFEST))) throw new Error('预设内容缺少 preset.yml。')

    await mkdir(presetRoot, { recursive: true })
    const destination = path.join(presetRoot, name)
    assertInside(presetRoot, destination)
    await replacePath(staged, destination)
    return { name, path: destination, enabled: true }
  } finally {
    await removeRecursive(stagingRoot).catch(() => undefined)
  }
}

/** 扫描一个预设根目录（启用或停用子目录），收集含 preset.yml 的预设。 */
async function readPresetDirectory(presetRoot: string, enabled: boolean): Promise<InstalledPreset[]> {
  let entries
  try {
    entries = await readdir(presetRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const presets: InstalledPreset[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const destination = path.join(presetRoot, entry.name)
    if (await exists(path.join(destination, PRESET_MANIFEST))) {
      presets.push({ name: entry.name, path: destination, enabled })
    }
  }
  return presets
}

/**
 * 列出 `~/.dsh/.agent-presets/` 下已安装的预设（含 preset.yml 的目录），
 * 与 skill 一致：`.agent-presets/` 为启用、`.agent-presets/.disabled/` 为停用。
 */
export async function readInstalledPresets(dshHome: string): Promise<InstalledPreset[]> {
  const presetRoot = path.join(dshHome, '.agent-presets')
  const presets = [
    ...await readPresetDirectory(presetRoot, true),
    ...await readPresetDirectory(path.join(presetRoot, '.disabled'), false),
  ]
  return presets.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 预设开关：在 `.agent-presets/<name>` 和 `.agent-presets/.disabled/<name>`
 * 之间移动目录，镜像 skill-install 的 `toggleInstalledSkill`。停用后 DSH 不可见。
 */
export async function toggleInstalledPreset(dshHome: string, name: string, enabled: boolean): Promise<InstalledPreset[]> {
  const presetRoot = path.join(dshHome, '.agent-presets')
  if (!isSkillName(name)) throw new Error('预设名称无效。')
  const current = await readInstalledPresets(dshHome)
  const preset = current.find(item => item.name === name)
  if (!preset) throw new Error(`未找到本地预设：${name}`)
  if (preset.enabled === enabled) return current

  const disabledRoot = path.join(presetRoot, '.disabled')
  const source = preset.path
  const destination = enabled
    ? path.join(presetRoot, name)
    : path.join(disabledRoot, name)
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await rename(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`无法${enabled ? '启用' : '停用'}预设「${name}」：目标位置已存在同名目录`)
    }
    throw error
  }
  return readInstalledPresets(dshHome)
}

/**
 * 卸载一个本地 agent-preset：删除其目录（启用或停用位置）并清理安装凭据。
 * 预设是全局资源，不随插件卸载联动，由用户在预设列表里显式删除。
 */
export async function uninstallInstalledPreset(dshHome: string, name: string, presetReceiptsPath: string): Promise<InstalledPreset[]> {
  if (!isSkillName(name)) throw new Error('预设名称无效。')
  const preset = (await readInstalledPresets(dshHome)).find(item => item.name === name)
  if (!preset) throw new Error(`未找到本地预设：${name}`)
  const presetRoot = path.join(dshHome, '.agent-presets')
  assertInside(presetRoot, preset.path)
  await rm(preset.path, { recursive: true, force: true })
  await removePresetReceipt(presetReceiptsPath, name)
  return readInstalledPresets(dshHome)
}
