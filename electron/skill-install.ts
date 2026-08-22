import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { InstalledSkill, SkillInstallTarget } from '../src/types'
import { downloadGitHubArchive, githubArchiveUrl } from './github-archive'
import { isSafeRepositoryName } from './profile'
import { isSkillName, parseSkillDocument, type ParsedSkill } from './skill-format'

const MAX_FILES = 5000
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_FILES = 12_000

export interface SkillInstallProgress {
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

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Skill 安装路径超出了允许范围。')
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
  onProgress: (progress: SkillInstallProgress) => void,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (!fetchImpl) {
    const archive = await downloadGitHubArchive(repository, revision, MAX_ARCHIVE_BYTES, (received, total) => {
      if (total) onProgress({ percent: 18 + Math.round(Math.min(1, received / total) * 42), message: `正在下载 Skill ${Math.round(received / total * 100)}%`, downloadedBytes: received, totalBytes: total })
    })
    await writeFile(destination, archive, { flag: 'wx' })
    return
  }
  const response = await fetchImpl(githubArchiveUrl(repository, revision), {
    headers: { 'User-Agent': 'DSH-Launcher' },
  })
  if (!response.ok || !response.body) throw new Error(`下载 Skill 仓库失败（HTTP ${response.status}）。`)
  const total = Number(response.headers.get('content-length'))
  if (Number.isFinite(total) && total > MAX_ARCHIVE_BYTES) throw new Error('Skill 仓库压缩包过大，已停止安装。')
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
        throw new Error('Skill 仓库压缩包过大，已停止安装。')
      }
      if (!writer.write(Buffer.from(chunk.value))) await once(writer, 'drain')
      if (Number.isFinite(total) && total > 0) {
        onProgress({ percent: 18 + Math.round(Math.min(1, received / total) * 42), message: `正在下载 Skill ${Math.round(received / total * 100)}%`, downloadedBytes: received, totalBytes: total })
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

export async function installSkillFromRepository(
  cacheRoot: string,
  dshHome: string,
  repository: string,
  target: SkillInstallTarget,
  onProgress: (progress: SkillInstallProgress) => void,
  fetchImpl?: typeof fetch,
): Promise<InstalledSkill> {
  if (!isSafeRepositoryName(repository) || !safeRevision(target.revision) || !isSkillName(target.name)) {
    throw new Error('Skill 仓库、版本或名称无效。')
  }
  const sourcePath = safeArchivePath(target.sourcePath)
  if (!sourcePath) throw new Error('Skill 来源路径无效。')

  await mkdir(cacheRoot, { recursive: true })
  const skillRoot = path.join(dshHome, 'skills')
  const stagingRoot = path.join(dshHome, '.skill-staging', `${process.pid}-${Date.now()}`)
  const zipPath = path.join(cacheRoot, `.skill-${process.pid}-${Date.now()}.zip`)
  assertInside(cacheRoot, zipPath)
  assertInside(dshHome, stagingRoot)
  await mkdir(stagingRoot, { recursive: true })

  try {
    onProgress({ percent: 12, message: '正在下载 Skill 仓库', indeterminate: true })
    await downloadArchive(repository, target.revision, zipPath, onProgress, fetchImpl)
    onProgress({ percent: 64, message: '正在核对 Skill 文件' })
    const archive = new AdmZip(zipPath)
    const entries = archive.getEntries()
    if (entries.length > MAX_ARCHIVE_FILES) throw new Error('Skill 仓库文件数量超过安全限制。')
    const firstFile = entries.find(entry => !entry.isDirectory)
    const archiveRoot = firstFile?.entryName.split('/')[0]
    if (!archiveRoot) throw new Error('Skill 仓库压缩包结构无效。')

    const sourceDirectory = target.format === 'bundle'
      ? path.posix.dirname(sourcePath) === '.' ? '' : path.posix.dirname(sourcePath)
      : null
    const staged = target.format === 'bundle'
      ? path.join(stagingRoot, target.name)
      : path.join(stagingRoot, `${target.name}.md`)
    let copiedFiles = 0
    let unpackedBytes = 0

    for (const entry of entries) {
      if (entry.isDirectory) continue
      const archivePath = safeArchivePath(entry.entryName)
      if (!archivePath || !archivePath.startsWith(`${archiveRoot}/`)) throw new Error('Skill 压缩包包含不安全路径。')
      const repositoryPath = archivePath.slice(archiveRoot.length + 1)
      let relativePath: string | null = null
      if (target.format === 'flat') {
        if (repositoryPath === sourcePath) relativePath = path.basename(staged)
      } else if (!sourceDirectory) {
        relativePath = repositoryPath
      } else if (repositoryPath.startsWith(`${sourceDirectory}/`)) {
        relativePath = repositoryPath.slice(sourceDirectory.length + 1)
      }
      if (!relativePath) continue
      const safeRelative = safeArchivePath(relativePath)
      if (!safeRelative) throw new Error('Skill 组件包含不安全路径。')
      copiedFiles += 1
      unpackedBytes += Number(entry.header.size) || 0
      if (copiedFiles > MAX_FILES || unpackedBytes > MAX_UNPACKED_BYTES) throw new Error('Skill 组件体积或文件数量超过安全限制。')
      const outputPath = target.format === 'flat' ? staged : path.join(staged, ...safeRelative.split('/'))
      assertInside(stagingRoot, outputPath)
      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(outputPath, entry.getData())
    }

    const stagedSkillFile = target.format === 'bundle' ? path.join(staged, 'SKILL.md') : staged
    const parsed = parseSkillDocument(await readFile(stagedSkillFile, 'utf8'))
    if (!parsed || parsed.name !== target.name) throw new Error('下载内容不再是检测时确认的 Skill。')

    onProgress({ percent: 84, message: '正在写入 DSH Skill 目录' })
    await mkdir(skillRoot, { recursive: true })
    const destination = target.format === 'bundle'
      ? path.join(skillRoot, target.name)
      : path.join(skillRoot, `${target.name}.md`)
    const conflicting = target.format === 'bundle'
      ? path.join(skillRoot, `${target.name}.md`)
      : path.join(skillRoot, target.name)
    assertInside(skillRoot, destination)
    assertInside(skillRoot, conflicting)
    const disabledRoot = path.join(skillRoot, '.disabled')
    const disabledDestination = target.format === 'bundle'
      ? path.join(disabledRoot, target.name)
      : path.join(disabledRoot, `${target.name}.md`)
    const disabledConflicting = target.format === 'bundle'
      ? path.join(disabledRoot, `${target.name}.md`)
      : path.join(disabledRoot, target.name)
    assertInside(skillRoot, disabledDestination)
    assertInside(skillRoot, disabledConflicting)
    await replacePath(staged, destination)
    await rm(conflicting, { recursive: true, force: true })
    await rm(disabledDestination, { recursive: true, force: true })
    await rm(disabledConflicting, { recursive: true, force: true })
    onProgress({ percent: 96, message: '正在验证本地 Skill' })
    return {
      name: parsed.name,
      description: parsed.description,
      path: destination,
      format: target.format,
      enabled: true,
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
    }
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined)
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 从本地目录/单文件安装 Skill（raw 整合包导入用）。
 * 源必须在 dshHome 内（pack.ts 在 dshHome/.pack-raw-staging-* 解出，保证与 skills/ 同卷，
 * replacePath 的 rename 不跨 EXDEV）。bundle：source 为含 SKILL.md 的目录；flat：source 为单个 .md。
 * 落盘段对齐 installSkillFromRepository：冲突变体与 .disabled/ 旧副本一并清理。
 */
export async function installSkillFromDirectory(
  dshHome: string,
  name: string,
  format: 'bundle' | 'flat',
  source: string,
): Promise<InstalledSkill> {
  if (!isSkillName(name)) throw new Error('Skill 名称无效。')
  if (format !== 'bundle' && format !== 'flat') throw new Error('Skill 格式无效。')
  const resolvedSource = path.resolve(source)
  assertInside(dshHome, resolvedSource)

  const skillFile = format === 'bundle' ? path.join(resolvedSource, 'SKILL.md') : resolvedSource
  let parsed: ParsedSkill | null = null
  try {
    parsed = parseSkillDocument(await readFile(skillFile, 'utf8'))
  } catch {
    parsed = null
  }
  if (!parsed) throw new Error('Skill 文档缺失或无效。')
  if (parsed.name !== name) throw new Error('Skill 文档名称与入参不一致。')

  const skillRoot = path.join(dshHome, 'skills')
  await mkdir(skillRoot, { recursive: true })
  const destination = format === 'bundle'
    ? path.join(skillRoot, name)
    : path.join(skillRoot, `${name}.md`)
  const conflicting = format === 'bundle'
    ? path.join(skillRoot, `${name}.md`)
    : path.join(skillRoot, name)
  const disabledRoot = path.join(skillRoot, '.disabled')
  const disabledDestination = format === 'bundle'
    ? path.join(disabledRoot, name)
    : path.join(disabledRoot, `${name}.md`)
  const disabledConflicting = format === 'bundle'
    ? path.join(disabledRoot, `${name}.md`)
    : path.join(disabledRoot, name)
  for (const target of [destination, conflicting, disabledDestination, disabledConflicting]) {
    assertInside(skillRoot, target)
  }
  await replacePath(resolvedSource, destination)
  await rm(conflicting, { recursive: true, force: true })
  await rm(disabledDestination, { recursive: true, force: true })
  await rm(disabledConflicting, { recursive: true, force: true })
  return {
    name: parsed.name,
    description: parsed.description,
    path: destination,
    format,
    enabled: true,
    modelInvocable: parsed.modelInvocable,
    userInvocable: parsed.userInvocable,
  }
}
