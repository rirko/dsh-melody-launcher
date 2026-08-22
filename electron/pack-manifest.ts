// 整合包（Pack）清单的纯函数域：派生 Profile 名 / 解析校验 / 序列化 / 从安装凭据构建。
// 本模块不依赖 Electron 与 fs，便于单元测试；导出用序列化、导入用解析。
// 注意：v1 的 skills 字段与其它未知字段一律忽略（解析时跳过）。

import path from 'node:path'
import { parse, stringify } from 'yaml'
import type {
  ApplicationLaunchMode,
  InstalledApplicationAddon,
  PackApplicationEntry,
  PackManifest,
  PackPluginEntry,
  PackPresetEntry,
  PackSkillEntry,
} from '../src/types'
import { isSafePackageName, isSafeProfileName, isSafeRepositoryName } from './profile'
import type { PluginInstallReceipt } from './plugin-receipts'
import type { PresetInstallReceipt } from './preset-receipts'
import type { SkillInstallReceipt } from './skill-receipts'

/** 压缩包内的清单文件名（导出 / 导入共用）。 */
export const PACK_MANIFEST_FILENAME = 'dsh-pack.yaml'
export const PROFILE_MANIFEST_FILENAME = 'dsh-profile.yaml'

const PACK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/
const PACK_VERSION_RE = /^\d+\.\d+\.\d+/
const DSH_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const PACK_COMMIT_RE = /^[0-9a-f]{7,40}$/i
const PACK_DESCRIPTION_MAX = 500
const PACK_PROFILE_PREFIX = 'pack-'
const PACK_BUILD_KEY_RE = /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/

export function normalizePackDshVersion(value: string): string {
  return value.trim().replace(/^v/i, '')
}

export function isValidPackDshVersion(value: unknown): value is string {
  return typeof value === 'string' && DSH_VERSION_RE.test(value.trim())
}

/** 当前版本导入必须带 DSH 版本；底层 zip 工具仍可兼容读取旧清单。 */
export function assertPackDshVersion(manifest: PackManifest): string {
  if (!isValidPackDshVersion(manifest.dshVersion)) {
    throw new Error('整合包缺少有效的 dshVersion，请使用包含 DSH 版本号的整合包重新导出。')
  }
  const normalized = normalizePackDshVersion(manifest.dshVersion)
  manifest.dshVersion = normalized
  return normalized
}

/** 合法的分支名：非空、1-160 位、不含 ..，仅允许 URL 安全字符。 */
function safeBranch(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

/** commit 允许 7-40 位十六进制 SHA，或合法的分支名。 */
function safeCommit(value: string): boolean {
  return PACK_COMMIT_RE.test(value) || safeBranch(value)
}

/** subdirectory 不得含 .. 段 / 反斜杠 / 绝对路径 / 空段。 */
function safeSubdirectory(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\\') || path.posix.isAbsolute(value)) return false
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  const normalized = path.posix.normalize(value)
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../')
}

/** 由整合包名称派生安全 Profile 名（含 pack- 前缀）。 */
export function packProfileName(name: string): string {
  if (!name || !name.trim()) throw new Error('整合包名称不能为空。')
  const derived = `${PACK_PROFILE_PREFIX}${name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`
  if (!isSafeProfileName(derived)) throw new Error('整合包名称无法生成安全的 Profile 名。')
  return derived
}

/**
 * 校验整合包名称能派生「有意义的」包标识：纯中文/纯符号名会退化成 `pack------`，
 * 既难以辨认又易撞名，直接拒绝并提示用户补字母或数字。
 * 返回派生出的包标识（含 pack- 前缀），供调用方直接使用。
 */
export function assertMeaningfulPackName(name: string): string {
  const packId = packProfileName(name)
  if (!/[a-z0-9]/.test(packId.slice(PACK_PROFILE_PREFIX.length))) {
    throw new Error('整合包名称需包含字母或数字，否则无法生成包标识。')
  }
  return packId
}

const PACK_PRESET_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parsePackPreset(item: unknown, index: number): PackPresetEntry {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`presets[${index}] 必须是映射（对象）。`)
  }
  const raw = item as Record<string, unknown>
  const name = raw.name
  if (typeof name !== 'string' || !PACK_PRESET_NAME_RE.test(name)) {
    throw new Error(`presets[${index}] 的 name 缺失或格式非法（须为 kebab-case）。`)
  }
  const entry: PackPresetEntry = { name }
  if (raw.repository !== undefined) {
    if (typeof raw.repository !== 'string' || !isSafeRepositoryName(raw.repository)) {
      throw new Error(`presets[${index}] 的 repository 格式非法。`)
    }
    entry.repository = raw.repository
  }
  if (raw.sourcePath !== undefined) {
    if (typeof raw.sourcePath !== 'string' || !safeSubdirectory(raw.sourcePath)) {
      throw new Error(`presets[${index}] 的 sourcePath 格式非法。`)
    }
    entry.sourcePath = raw.sourcePath
  }
  if (raw.revision !== undefined) {
    if (typeof raw.revision !== 'string' || !safeCommit(raw.revision)) {
      throw new Error(`presets[${index}] 的 revision 格式非法。`)
    }
    entry.revision = raw.revision
  }
  return entry
}

function parsePackSkill(item: unknown, index: number): PackSkillEntry {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`skills[${index}] 必须是映射（对象）。`)
  }
  const raw = item as Record<string, unknown>
  const name = raw.name
  if (typeof name !== 'string' || !PACK_PRESET_NAME_RE.test(name)) {
    throw new Error(`skills[${index}] 的 name 缺失或格式非法（须为 kebab-case）。`)
  }
  const format = raw.format
  if (format !== 'bundle' && format !== 'flat') {
    throw new Error(`skills[${index}] 的 format 只能是 bundle / flat。`)
  }
  const entry: PackSkillEntry = { name, format }
  if (raw.repository !== undefined) {
    if (typeof raw.repository !== 'string' || !isSafeRepositoryName(raw.repository)) {
      throw new Error(`skills[${index}] 的 repository 格式非法。`)
    }
    entry.repository = raw.repository
  }
  if (raw.sourcePath !== undefined) {
    if (typeof raw.sourcePath !== 'string' || !safeSubdirectory(raw.sourcePath)) {
      throw new Error(`skills[${index}] 的 sourcePath 格式非法。`)
    }
    entry.sourcePath = raw.sourcePath
  }
  if (raw.revision !== undefined) {
    if (typeof raw.revision !== 'string' || !safeCommit(raw.revision)) {
      throw new Error(`skills[${index}] 的 revision 格式非法。`)
    }
    entry.revision = raw.revision
  }
  return entry
}

const PACK_APPLICATION_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/
const PACK_LAUNCH_MODES = new Set<ApplicationLaunchMode>(['runtime-replacement', 'after-runtime', 'standalone'])

function parsePackApplication(item: unknown, index: number): PackApplicationEntry {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`applications[${index}] 必须是映射（对象）。`)
  }
  const raw = item as Record<string, unknown>
  const id = raw.id
  if (typeof id !== 'string' || !PACK_APPLICATION_ID_RE.test(id)) {
    throw new Error(`applications[${index}] 的 id 缺失或格式非法。`)
  }
  const name = raw.name
  const repository = raw.repository
  const packageName = raw.packageName
  const version = raw.version
  const binName = raw.binName
  const launchMode = raw.launchMode
  const launchArgs = raw.launchArgs
  const provides = raw.provides
  if (typeof name !== 'string' || !name.trim()) throw new Error(`applications[${index}] 的 name 缺失。`)
  if (typeof repository !== 'string' || !isSafeRepositoryName(repository)) throw new Error(`applications[${index}] 的 repository 格式非法。`)
  if (typeof packageName !== 'string' || !isSafePackageName(packageName)) throw new Error(`applications[${index}] 的 packageName 格式非法。`)
  if (typeof version !== 'string' || !PACK_VERSION_RE.test(version)) throw new Error(`applications[${index}] 的 version 格式非法。`)
  if (typeof binName !== 'string' || !binName.trim()) throw new Error(`applications[${index}] 的 binName 缺失。`)
  if (typeof launchMode !== 'string' || !PACK_LAUNCH_MODES.has(launchMode as ApplicationLaunchMode)) {
    throw new Error(`applications[${index}] 的 launchMode 格式非法。`)
  }
  if (!Array.isArray(launchArgs) || launchArgs.some(value => typeof value !== 'string')) {
    throw new Error(`applications[${index}] 的 launchArgs 必须是字符串数组。`)
  }
  if (!Array.isArray(provides) || provides.some(value => typeof value !== 'string')) {
    throw new Error(`applications[${index}] 的 provides 必须是字符串数组。`)
  }
  return {
    id,
    name,
    repository,
    packageName,
    version,
    binName,
    launchMode: launchMode as ApplicationLaunchMode,
    launchArgs,
    provides,
  }
}

function parsePackPlugin(item: unknown, index: number): PackPluginEntry {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`plugins[${index}] 必须是映射（对象）。`)
  }
  const raw = item as Record<string, unknown>
  const packageName = raw.packageName
  if (typeof packageName !== 'string' || !isSafePackageName(packageName)) {
    throw new Error(`plugins[${index}] 的 packageName 缺失或格式非法。`)
  }
  const entry: PackPluginEntry = { packageName }
  if (raw.targetId !== undefined) {
    if (typeof raw.targetId !== 'string' || raw.targetId.length === 0 || raw.targetId.length > 240 || raw.targetId.includes('..') || raw.targetId.includes('\\')) {
      throw new Error(`plugins[${index}] 的 targetId 格式非法。`)
    }
    entry.targetId = raw.targetId
  }
  if (raw.repository !== undefined) {
    if (typeof raw.repository !== 'string' || !isSafeRepositoryName(raw.repository)) {
      throw new Error(`plugins[${index}] 的 repository 格式非法。`)
    }
    entry.repository = raw.repository
  }
  if (raw.source !== undefined) {
    if (raw.source !== 'github' && raw.source !== 'npm' && raw.source !== 'local') {
      throw new Error(`plugins[${index}] 的 source 只能是 github / npm / local。`)
    }
    entry.source = raw.source
  }
  if (raw.subdirectory !== undefined) {
    if (typeof raw.subdirectory !== 'string' || !safeSubdirectory(raw.subdirectory)) {
      throw new Error(`plugins[${index}] 的 subdirectory 格式非法。`)
    }
    entry.subdirectory = raw.subdirectory
  }
  if (raw.defaultBranch !== undefined) {
    if (typeof raw.defaultBranch !== 'string' || !safeBranch(raw.defaultBranch)) throw new Error(`plugins[${index}] 的 defaultBranch 格式非法。`)
    entry.defaultBranch = raw.defaultBranch
  }
  if (raw.commit !== undefined) {
    if (typeof raw.commit !== 'string' || !safeCommit(raw.commit)) {
      throw new Error(`plugins[${index}] 的 commit 格式非法。`)
    }
    entry.commit = raw.commit
  }
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'string' || !PACK_VERSION_RE.test(raw.version)) {
      throw new Error(`plugins[${index}] 的 version 格式非法。`)
    }
    entry.version = raw.version
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error(`plugins[${index}] 的 enabled 必须是布尔值。`)
    entry.enabled = raw.enabled
  }
  for (const field of ['allowBuilds', 'denyBuilds'] as const) {
    const value = raw[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > 64 || value.some(key => typeof key !== 'string' || !PACK_BUILD_KEY_RE.test(key))) {
      throw new Error(`plugins[${index}] 的 ${field} 只能包含精确 npm 包版本，且不能使用通配符。`)
    }
    entry[field] = [...new Set(value as string[])]
  }
  if (entry.allowBuilds?.some(key => entry.denyBuilds?.includes(key))) {
    throw new Error(`plugins[${index}] 的同一构建键不能同时允许和禁止。`)
  }
  if (!entry.source) {
    // 缺省 source：有 repository 视为 github，否则 npm。
    entry.source = entry.repository ? 'github' : 'npm'
  }
  return entry
}

/** 解析并校验 dsh-pack.yaml 文本，非法时抛出含中文描述的错误。未知字段忽略。 */
export function parsePackManifest(text: string, options: { requireDshVersion?: boolean } = {}): PackManifest {
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    throw new Error(`dsh-pack.yaml 不是合法的 YAML（${error instanceof Error ? error.message : String(error)}）。`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('dsh-pack.yaml 顶层必须是映射（对象）。')
  }
  const raw = data as Record<string, unknown>

  if (typeof raw.name !== 'string' || !PACK_NAME_RE.test(raw.name)) {
    throw new Error('整合包 name 缺失或非法（须以字母/数字开头，1-64 位，仅含字母、数字、._ 与空格）。')
  }
  if (typeof raw.description !== 'string' || raw.description.trim().length === 0 || raw.description.length > PACK_DESCRIPTION_MAX) {
    throw new Error(`整合包 description 缺失、为空或超过 ${PACK_DESCRIPTION_MAX} 字符。`)
  }
  if (typeof raw.version !== 'string' || !PACK_VERSION_RE.test(raw.version)) {
    throw new Error('整合包 version 缺失或非法（须为 semver，如 1.0.0）。')
  }
  if (raw.dshVersion !== undefined && !isValidPackDshVersion(raw.dshVersion)) {
    throw new Error('整合包 dshVersion 非法（须为 DSH 精确版本，如 0.1.0-rc.7）。')
  }
  if (options.requireDshVersion && raw.dshVersion === undefined) {
    throw new Error('整合包缺少 dshVersion，请使用包含 DSH 版本号的整合包重新导出。')
  }
  if (!Array.isArray(raw.plugins)) {
    throw new Error('整合包 plugins 必须是数组。')
  }

  const manifest: PackManifest = {
    name: raw.name,
    description: raw.description,
    version: raw.version,
    ...(typeof raw.dshVersion === 'string' ? { dshVersion: normalizePackDshVersion(raw.dshVersion) } : {}),
    plugins: raw.plugins.map((item, index) => parsePackPlugin(item, index)),
  }
  if (typeof raw.author === 'string' && raw.author) manifest.author = raw.author
  if (raw.presets !== undefined) {
    if (!Array.isArray(raw.presets)) throw new Error('整合包 presets 必须是数组。')
    manifest.presets = raw.presets.map((item, index) => parsePackPreset(item, index))
  }
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) throw new Error('整合包 skills 必须是数组。')
    manifest.skills = raw.skills.map((item, index) => parsePackSkill(item, index))
  }
  if (raw.applications !== undefined) {
    if (!Array.isArray(raw.applications)) throw new Error('整合包 applications 必须是数组。')
    manifest.applications = raw.applications.map((item, index) => parsePackApplication(item, index))
  }
  return manifest
}

/** 序列化 manifest 为 dsh-pack.yaml 文本（导出用）。 */
export function serializePackManifest(manifest: PackManifest): string {
  const output: Record<string, unknown> = {
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    plugins: manifest.plugins,
  }
  if (manifest.dshVersion !== undefined) {
    if (!isValidPackDshVersion(manifest.dshVersion)) {
      throw new Error('整合包 dshVersion 非法（须为 DSH 精确版本，如 0.1.0-rc.7）。')
    }
    output.dshVersion = normalizePackDshVersion(manifest.dshVersion)
  }
  if (manifest.author) output.author = manifest.author
  if (manifest.presets !== undefined) output.presets = manifest.presets
  if (manifest.skills !== undefined) output.skills = manifest.skills
  if (manifest.applications !== undefined) output.applications = manifest.applications
  return stringify(output, { lineWidth: 0 })
}

function manifestNameFromPackId(packId: string): string {
  let name = packId.startsWith(PACK_PROFILE_PREFIX) ? packId.slice(PACK_PROFILE_PREFIX.length) : packId
  if (!name) name = 'pack'
  if (!/^[A-Za-z0-9]/.test(name)) name = `p${name}`
  if (name.length > 64) name = name.slice(0, 64)
  if (!PACK_NAME_RE.test(name)) throw new Error('packId 无法派生合法的整合包 name。')
  return name
}

function receiptToPluginEntry(receipt: PluginInstallReceipt): PackPluginEntry {
  const entry: PackPluginEntry = { packageName: receipt.packageName }
  if (receipt.targetId) entry.targetId = receipt.targetId
  if (receipt.defaultBranch) entry.defaultBranch = receipt.defaultBranch
  if (receipt.source === 'github' || receipt.source === 'archive-subdirectory') {
    entry.source = 'github'
    if (receipt.repository) entry.repository = receipt.repository
    if (receipt.subdirectory) entry.subdirectory = receipt.subdirectory
    if (receipt.commit) entry.commit = receipt.commit
  } else if (receipt.source === 'local-directory') {
    // 离线 zip 导入的本体：来源映射为 local，导出时 body 会原样带上（联网安装方需要它）。
    entry.source = 'local'
    if (receipt.version) entry.version = receipt.version
  } else {
    entry.source = 'npm'
    if (receipt.version) entry.version = receipt.version
  }
  return entry
}

/** 从安装凭据生成 manifest：name=去 pack- 前缀的 packId，plugins 逐条由 receipt 填充。 */
export function buildManifestFromReceipts(
  packId: string,
  receipts: PluginInstallReceipt[],
  presetReceipts: PresetInstallReceipt[] = [],
  skillReceipts: SkillInstallReceipt[] = [],
  applicationAddons: InstalledApplicationAddon[] = [],
  dshVersion?: string,
): PackManifest {
  const plugins = receipts.map(receiptToPluginEntry)
  const presets = presetReceipts.map(receipt => ({
    name: receipt.name,
    repository: receipt.repository,
    sourcePath: receipt.sourcePath,
    revision: receipt.revision,
  }))
  const skills = skillReceipts.map(receipt => ({
    name: receipt.name,
    format: receipt.format,
    repository: receipt.repository,
    sourcePath: receipt.sourcePath,
    revision: receipt.revision,
  }))
  const applications = applicationAddons.map(addon => ({
    id: addon.id,
    name: addon.name,
    repository: addon.repository,
    packageName: addon.packageName,
    version: addon.version,
    binName: addon.binName,
    launchMode: addon.launchMode,
    launchArgs: addon.launchArgs,
    provides: addon.provides,
  }))
  const extra: string[] = []
  if (presetReceipts.length > 0) extra.push(`${presetReceipts.length} 个预设`)
  if (skillReceipts.length > 0) extra.push(`${skillReceipts.length} 个技能`)
  if (applicationAddons.length > 0) extra.push(`${applicationAddons.length} 个应用`)
  if (dshVersion !== undefined && !isValidPackDshVersion(dshVersion)) {
    throw new Error('整合包 dshVersion 非法（须为 DSH 精确版本，如 0.1.0-rc.7）。')
  }
  return {
    name: manifestNameFromPackId(packId),
    description: `由 DSH Launcher 从已安装插件导出（${receipts.length} 个插件${extra.length > 0 ? `、${extra.join('、')}` : ''}）。`,
    version: '1.0.0',
    ...(dshVersion !== undefined ? { dshVersion: normalizePackDshVersion(dshVersion) } : {}),
    plugins,
    ...(presetReceipts.length > 0 ? { presets } : {}),
    ...(skillReceipts.length > 0 ? { skills } : {}),
    ...(applicationAddons.length > 0 ? { applications } : {}),
  }
}
