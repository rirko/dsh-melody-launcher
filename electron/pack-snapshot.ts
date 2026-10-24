import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import AdmZip from 'adm-zip'
import { assertInside, safeArchivePath } from './pack-zip'

/**
 * 快照整合包（序曲发布线的官方包格式）的导入半边。
 *
 * 快照 zip = 一个 DSH 家目录镜像（settings.yaml、profiles/<id>/、skills/、tools/）
 * + 根下 `dsh-snapshot.json` 元数据（格式版本、平台、符号链接清单、隐私放行清单）。
 * 符号链接不作为 zip 条目存储，由导入端按清单重建。
 *
 * 与上游序曲实现的差异：解压用 adm-zip 单句柄（不引入它们的 yauzl 分片并发层），
 * 万级文件的解压耗时从 ~15s 退到 ~25-30s，换取移植面最小。
 */

export const SNAPSHOT_META_FILENAME = 'dsh-snapshot.json'
export const SNAPSHOT_FORMAT_VERSION = 1

export const SNAPSHOT_ZIP_LIMITS = {
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxFiles: 400_000,
  maxUnpackedBytes: 6 * 1024 * 1024 * 1024,
}

/** 导入端路径长度预检阈值：只挡极端异常值。 */
export const SNAPSHOT_MAX_PATH_LENGTH = 1000

export interface SnapshotLinkEntry {
  /** zip 内相对路径（正斜杠）。 */
  path: string
  /** 相对于链接自身所在目录的目标（正斜杠，可含 ../）。 */
  target: string
}

export interface SnapshotMeta {
  format: number
  platform: string
  exportedAt: string
  /** 符号链接清单：zip 里不写链接条目，由导入端按此重建。 */
  links: SnapshotLinkEntry[]
  /** 被剔除的相对路径（截断保存，供导入端核对与用户知情）。 */
  excluded: string[]
  /** 无法相对化、原样保留的依赖（包外本体已丢失）。 */
  warnings: string[]
  /** 这次导出被显式放行的隐私类别（缺省 = 全脱敏）。 */
  private?: SnapshotPrivacyCategory[]
}

export type SnapshotPrivacyCategory = 'credentials' | 'sessions'

export interface SnapshotPrivacyInclude {
  credentials?: boolean
  sessions?: boolean
}

/** 每个类别对应家目录里的哪些顶层条目。 */
const PRIVACY_TOP_LEVEL: Record<SnapshotPrivacyCategory, ReadonlySet<string>> = {
  credentials: new Set(['.credentials.yaml']),
  sessions: new Set(['sessions', 'dsh-session-archive', 'attachments']),
}

const EXCLUDED_TOP_LEVEL = new Set([
  '.credentials.yaml',
  '.anonymous-user-id',
  'sessions',
  'dsh-session-archive',
  'dsh-usage',
  'task-board',
  'attachments',
  'storages',
  'pet.json',
  '.dsh-module-fallback',
  '.skill-staging',
  '.preset-staging',
  '.pack-offline-import',
])

const EXCLUDED_TOP_LEVEL_PREFIXES = ['.pack-raw-staging-', '.pack-raw-preset-staging-', '.pack-offline-import-']
/** 任何层级出现即剔除的目录（DSH 自建缓存/临时目录）。 */
const EXCLUDED_ANYWHERE = new Set(['.dsh-module-fallback', '.skill-staging', '.preset-staging', '.pack-offline-import'])
/** 具体路径前缀：本地凭据或平台令牌缓存，随包公开会泄露机主身份。 */
const EXCLUDED_PATH_PREFIXES = ['skin-center/wallpapers/.cache']
/** pnpm 自己的元数据：含源机 store 绝对路径。 */
const EXCLUDED_PROFILE_FILES = new Set([
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.package-map.json',
])

export function privacyIncludeFromList(list: SnapshotPrivacyCategory[] | undefined): SnapshotPrivacyInclude {
  return { credentials: list?.includes('credentials'), sessions: list?.includes('sessions') }
}

/** 相对家目录的路径是否不进包/不解压（正斜杠、不含前导 ./）。 */
export function isSnapshotExcluded(rel: string, include: SnapshotPrivacyInclude = {}): boolean {
  const segments = rel.split('/')
  const top = segments[0]
  if (EXCLUDED_TOP_LEVEL.has(top)) {
    for (const category of Object.keys(PRIVACY_TOP_LEVEL) as SnapshotPrivacyCategory[]) {
      if (include[category] && PRIVACY_TOP_LEVEL[category].has(top)) return false
    }
    return true
  }
  if (EXCLUDED_TOP_LEVEL_PREFIXES.some(prefix => top.startsWith(prefix))) return true
  if (segments.some(segment => EXCLUDED_ANYWHERE.has(segment))) return true
  if (EXCLUDED_PATH_PREFIXES.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) return true
  if (segments.length === 1 && top.toLowerCase().endsWith('.log')) return true
  if (segments[0] === 'profiles' && segments.length >= 3) {
    if (EXCLUDED_PROFILE_FILES.has(segments.slice(2).join('/'))) return true
    if (EXCLUDED_PROFILE_FILES.has(segments.slice(1).join('/'))) return true
  }
  return false
}

export interface SnapshotInspection {
  meta: SnapshotMeta | null
  /** 包内 profile 目录名（源包 id）。 */
  profileId: string | null
  dshVersion: string | null
  fileCount: number
  unpackedBytes: number
}

function readYamlField(text: string, field: string): string | null {
  const match = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm').exec(text)
  if (!match) return null
  const value = match[1].trim().replace(/^['"]|['"]$/g, '')
  return value || null
}

/** 判断一个已加载的 zip 是否是快照包：根下有 settings.yaml / 元数据 / profiles/<id>/<file>。 */
export function looksLikeSnapshot(zip: AdmZip): boolean {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    if (safe === 'settings.yaml' || safe === SNAPSHOT_META_FILENAME) return true
    if (safe.startsWith('profiles/') && safe.split('/').length >= 3) return true
  }
  return false
}

function entryText(zip: AdmZip, entry: AdmZip.IZipEntry, maxBytes: number): string | null {
  const size = entry.header.size
  if (Number.isFinite(size) && size > maxBytes) return null
  const data = entry.getData()
  if (data.length > maxBytes) return null
  return data.toString('utf8')
}

/** 读快照包头部：元数据 + 源包 id + DSH 版本（只读少量条目，不解压整包）。 */
export function inspectSnapshotZip(zip: AdmZip): SnapshotInspection {
  let meta: SnapshotMeta | null = null
  let profileId: string | null = null
  let dshVersion: string | null = null
  let fileCount = 0
  let unpackedBytes = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    fileCount += 1
    unpackedBytes += Number(entry.header.size) || 0
    if (safe === SNAPSHOT_META_FILENAME) {
      const text = entryText(zip, entry, 4 * 1024 * 1024)
      try {
        meta = text ? JSON.parse(text) as SnapshotMeta : null
      } catch {
        meta = null
      }
      continue
    }
    const segments = safe.split('/')
    // profiles/<id>/profile.yaml 才是一个整合包 Profile 的标志。
    if (segments[0] !== 'profiles' || segments.length !== 3 || segments[2] !== 'profile.yaml') continue
    if (segments[1] === 'node_modules') continue
    const text = entryText(zip, entry, 256 * 1024)
    if (text === null) continue
    const name = readYamlField(text, 'name')
    if (profileId === null) profileId = name || segments[1]
    const version = readYamlField(text, 'dshVersion')
    if (version) dshVersion = version
  }
  return { meta, profileId, dshVersion, fileCount, unpackedBytes }
}

export interface SnapshotDescription extends SnapshotInspection {
  /** profile package.json 里的非核心依赖（= 包内插件）。 */
  pluginNames: string[]
  description: string
}

/** 预览用：判断并读取快照包；不是快照包时返回 null。 */
export function describeSnapshotZip(zipPath: string): SnapshotDescription | null {
  const zip = new AdmZip(zipPath)
  if (!looksLikeSnapshot(zip)) return null
  const inspection = inspectSnapshotZip(zip)
  const pluginNames = readSnapshotPluginNames(zip, inspection.profileId)
  const sizeMb = Math.round(inspection.unpackedBytes / (1024 * 1024))
  return {
    ...inspection,
    pluginNames,
    description: `快照整合包：${inspection.fileCount} 个文件，解压约 ${sizeMb}MB。`,
  }
}

function readSnapshotPluginNames(zip: AdmZip, profileId: string | null): string[] {
  if (!profileId) return []
  const target = `profiles/${profileId}/package.json`
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (safeArchivePath(entry.entryName) !== target) continue
    const text = entryText(zip, entry, 4 * 1024 * 1024)
    try {
      const parsed = JSON.parse(text ?? '') as { dependencies?: Record<string, unknown> }
      return Object.keys(parsed.dependencies ?? {}).filter(name => !name.startsWith('@deepseek-ai/dsh-'))
    } catch {
      return []
    }
  }
  return []
}

/** 包内路径映射：profiles/<源id>/… → profiles/<新id>/…，其余原样。 */
export function mapSnapshotPath(rel: string, sourceId: string, newId: string): string {
  if (sourceId === newId) return rel
  if (rel === `profiles/${sourceId}`) return `profiles/${newId}`
  const prefix = `profiles/${sourceId}/`
  if (rel.startsWith(prefix)) return `profiles/${newId}/${rel.slice(prefix.length)}`
  return rel
}

/** 解压后修正包内自带 id 的字段（profile.yaml.name / package.json.name）。 */
async function finalizeExtractedProfile(home: string, newId: string, native: (value: string) => string): Promise<void> {
  const profileDir = path.join(home, 'profiles', newId)
  const profileYamlPath = native(path.join(profileDir, 'profile.yaml'))
  const profileText = await readFile(profileYamlPath, 'utf8').catch(() => null)
  if (profileText !== null) {
    const sanitized = sanitizeProfileYaml(profileText, newId)
    await writeFile(profileYamlPath, sanitized, 'utf8')
  }
  const packageJsonPath = native(path.join(profileDir, 'package.json'))
  const packageText = await readFile(packageJsonPath, 'utf8').catch(() => null)
  if (packageText === null) return
  try {
    const parsed = JSON.parse(packageText) as { name?: unknown }
    parsed.name = `dsh-profile-${newId}`
    await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  } catch {
    // 坏 JSON 留给启动诊断去报。
  }
}

/** profile.yaml：去掉机器相关字段（source.path / exportedAt），可选改写 name。 */
export function sanitizeProfileYaml(text: string, newName?: string): string {
  let document: unknown
  try {
    document = parse(text)
  } catch {
    return text
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return text
  const record = document as Record<string, unknown>
  if (newName) record.name = newName
  record.exportedAt = null
  const source = record.source
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    delete (source as Record<string, unknown>).path
  }
  // 只重组保序字段;用 yaml 库序列化需要引入字符串化差异，这里做保守的行级改写：
  // name 行替换、exportedAt 行替换、source.path 行删除。
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let inSource = false
  let replacedName = false
  let replacedExportedAt = false
  for (const line of lines) {
    const topLevel = /^[A-Za-z][\w-]*\s*:/.test(line)
    if (topLevel) inSource = line.startsWith('source:')
    if (newName && /^name\s*:/.test(line)) {
      out.push(`name: ${newName}`)
      replacedName = true
      continue
    }
    if (/^exportedAt\s*:/.test(line)) {
      out.push('exportedAt: null')
      replacedExportedAt = true
      continue
    }
    if (inSource && /^\s+path\s*:/.test(line)) continue
    out.push(line)
  }
  if (newName && !replacedName) out.push(`name: ${newName}`)
  if (!replacedExportedAt) out.push('exportedAt: null')
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

export interface ExtractSnapshotOptions {
  /** 新包 id：包内 profiles/<源id> 整体映射到 profiles/<新id>。 */
  newId: string
  onProgress?: (done: number, total: number) => void
}

export interface ExtractSnapshotResult {
  profileId: string
  links: number
  skipped: number
  longPaths: string[]
}

/**
 * 解压快照到家目录：zip-slip 校验、隐私剔除、profile 目录改名、重建符号链接。
 * 不做任何联网/安装动作——node_modules 随包而来，解开即用。
 */
export async function extractSnapshot(
  zipPath: string,
  home: string,
  options: ExtractSnapshotOptions,
): Promise<ExtractSnapshotResult> {
  const longPaths: string[] = []
  let skipped = 0
  const native = (value: string): string => process.platform === 'win32' ? path.toNamespacedPath(value) : value
  const zip = new AdmZip(zipPath)
  const inspection = inspectSnapshotZip(zip)
  const sourceProfileId = inspection.profileId
  if (!sourceProfileId) throw new Error('快照包内没有找到 profiles/<整合包> 目录。')
  // 平台护栏：快照里的原生二进制按导出平台预编译。
  const metaPlatform = inspection.meta?.platform
  if (metaPlatform && metaPlatform !== process.platform) {
    throw new Error(`快照包来自 ${metaPlatform} 平台，无法在 ${process.platform} 上使用。`)
  }
  const snapshotLinks = inspection.meta?.links ?? []
  // 包自己声明带了哪些隐私条目，解压时才按同一份清单放行；
  // 没声明（别人的包、旧版本包）就一律照黑名单剔除。
  const include = privacyIncludeFromList(inspection.meta?.private)

  const work: Array<{ entry: AdmZip.IZipEntry; target: string }> = []
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe || safe === SNAPSHOT_META_FILENAME || isSnapshotExcluded(safe, include)) {
      skipped += 1
      continue
    }
    const mapped = mapSnapshotPath(safe, sourceProfileId, options.newId)
    const target = path.join(home, ...mapped.split('/'))
    assertInside(home, target)
    if (target.length > SNAPSHOT_MAX_PATH_LENGTH) {
      if (longPaths.length < 50) longPaths.push(mapped)
      skipped += 1
      continue
    }
    work.push({ entry, target: native(target) })
  }

  const directories = [...new Set(work.map(item => path.dirname(item.target)))]
  for (const dir of directories) await mkdir(dir, { recursive: true })

  const total = work.length
  let done = 0
  for (const item of work) {
    const data = item.entry.getData()
    await mkdir(path.dirname(item.target), { recursive: true })
    await writeFile(item.target, data)
    done += 1
    options.onProgress?.(done, total)
  }

  let links = 0
  for (const link of snapshotLinks) {
    const safeLink = safeArchivePath(link.path)
    if (!safeLink || isSnapshotExcluded(safeLink)) continue
    const mapped = mapSnapshotPath(safeLink, sourceProfileId, options.newId)
    const linkPath = path.join(home, ...mapped.split('/'))
    assertInside(home, linkPath)
    if (linkPath.length > SNAPSHOT_MAX_PATH_LENGTH) continue
    const targetAbsolute = path.resolve(path.dirname(linkPath), link.target)
    const targetExists = await lstat(native(targetAbsolute)).then(() => true, () => false)
    if (!targetExists) {
      skipped += 1
      continue
    }
    await mkdir(native(path.dirname(linkPath)), { recursive: true })
    await rm(native(linkPath), { recursive: true, force: true }).catch(() => undefined)
    try {
      // junction 目标保持常规形式（与序曲实现一致）：带 \?\ 前缀的目标会让
      // Node 解析出死链，existsSync 跟随不到。
      await symlink(targetAbsolute, native(linkPath), 'junction')
      links += 1
    } catch {
      // 建链接失败（权限/文件系统）就退化成实体副本，保证包仍可启动。
      try {
        await cp(native(targetAbsolute), native(linkPath), { recursive: true })
        links += 1
      } catch {
        skipped += 1
      }
    }
  }
  await finalizeExtractedProfile(home, options.newId, native)
  return { profileId: options.newId, links, skipped, longPaths }
}
