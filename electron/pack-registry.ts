/**
 * 整合包（Pack）注册表 —— 纯函数 + fs 持久化层。
 *
 * 功能定位：把整合包记录持久化到 `packs.json`（原子写：临时文件 + rename，
 * 对齐 plugin-receipts.ts 的写盘模式）。本模块只处理「记录本身」的读写，
 * 不涉及 DSH profile 切换、插件安装等副作用——那些由编排层 / pack.ts 负责。
 *
 * 约定：
 *   - 所有函数接收 registryPath（DI 注入），便于测试用临时目录。
 *   - 文件不存在 / JSON 损坏一律返回空数组，绝不抛错（读取是幂等的）。
 *   - 写入用 `{ version: 1, records: [...] }` 信封结构，为将来 schema 演进留位。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PackInstalledApplication, PackInstalledPlugin, PackInstalledPreset, PackInstalledSkill, PackSource, PackStatus } from '../src/types'

/** 注册表里的一条整合包记录。id = pack-<safeName>，只对应本地清单，不是 DSH profile 名。 */
export interface PackRecord {
  id: string
  name: string
  description: string
  version: string
  /** 当前整合包要求的 DSH 精确版本；旧注册表记录可能缺省。 */
  dshVersion?: string
  source: PackSource
  installedAt: string
  updatedAt: string
  state: 'complete' | 'partial' | 'failed'
  plugins: PackInstalledPlugin[]
  /** raw 导入的技能（全局安装，记入包以支持删包清理）。 */
  skills?: PackInstalledSkill[]
  /** 包内包含的 Agent 预设（全局安装，记入包以支持导出与删包清理）。 */
  presets?: PackInstalledPreset[]
  /** 包内包含的 Application Addon（独立安装目录，记入包以支持导出与删包清理）。 */
  applications?: PackInstalledApplication[]
  /** state 为 partial/failed 时的失败项（含原因），完整包缺省省略。 */
  failures?: { packageName: string; reason: string }[]
}

/** 落盘信封：version 保留给未来 schema 迁移。 */
interface RegistryFile {
  version: 1
  records: PackRecord[]
}

/** 原子写 `packs.json`：临时文件 + rename，rename 失败回退直接写（对齐 plugin-receipts）。 */
async function writeRegistryFile(registryPath: string, value: RegistryFile): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true })
  const temporaryPath = `${registryPath}.tmp`
  const content = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(temporaryPath, content, 'utf8')
  try {
    await rename(temporaryPath, registryPath)
  } catch {
    await writeFile(registryPath, content, 'utf8')
    await unlink(temporaryPath).catch(() => undefined)
  }
}

/**
 * 读取注册表。文件不存在、JSON 损坏、或信封结构不合法时一律返回 `[]`（不抛）。
 * 这是「只读永远是幂等空值」的容错语义：注册表不应让整合包列表页崩溃。
 */
export async function readPackRegistry(registryPath: string): Promise<PackRecord[]> {
  try {
    const value = JSON.parse(await readFile(registryPath, 'utf8')) as Partial<RegistryFile>
    return Array.isArray(value.records) ? value.records : []
  } catch {
    return [] // 文件不存在或 JSON 损坏，统一返回空数组
  }
}

/** 原子写注册表（临时文件 + rename）。 */
export async function writePackRegistry(registryPath: string, records: PackRecord[]): Promise<void> {
  await writeRegistryFile(registryPath, { version: 1, records })
}

/**
 * 按 id 幂等 upsert：已存在则覆盖（保留原位置），不存在则追加到末尾。
 * 返回写盘后的完整记录数组（与磁盘一致）。
 */
export async function upsertPackRecord(registryPath: string, record: PackRecord): Promise<PackRecord[]> {
  const records = await readPackRegistry(registryPath)
  const index = records.findIndex(item => item.id === record.id)
  const next = index >= 0
    ? [...records.slice(0, index), record, ...records.slice(index + 1)]
    : [...records, record]
  await writeRegistryFile(registryPath, { version: 1, records: next })
  return next
}

/**
 * 按 id 删除记录。找不到 id 时不写盘（保持磁盘状态不变），返回现数组。
 * 返回写盘后的完整记录数组。
 */
export async function removePackRecord(registryPath: string, packId: string): Promise<PackRecord[]> {
  const records = await readPackRegistry(registryPath)
  const next = records.filter(item => item.id !== packId)
  if (next.length !== records.length) {
    await writeRegistryFile(registryPath, { version: 1, records: next })
  }
  return next
}

/**
 * 把注册表记录映射为渲染层 `PackStatus`。`enabled` 表示该整合包清单是否
 * 是当前选中的清单；实际 DSH Profile 始终由设置中的 profileName 决定。
 */
export function toPackStatus(record: PackRecord, activePackId: string | null | undefined): PackStatus {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    dshVersion: record.dshVersion ?? null,
    source: record.source,
    enabled: record.id === activePackId,
    state: record.state,
    plugins: record.plugins,
    skills: record.skills,
    presets: record.presets,
    applications: record.applications,
    failures: record.failures,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  }
}
