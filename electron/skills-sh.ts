// skills.sh 目录索引：技能市场「通用技能」栏的数据源。
// 该站没有公开的榜单 API，但 /api/search?q= 返回 JSON（单次 ≤100 条，含安装量）。
// 这里用「多查询聚合」拿头部目录：字母/数字/常用词各查一次，去重后按安装量排序。
// 索引条目只有名字与来源仓库，安装时才按仓库解析归档定位 target（见 ipc 的 install-by-name）。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SkillsShSkill, SkillInstallTarget } from '../src/types'

export const SKILLS_SH_SEARCH_URL = 'https://www.skills.sh/api/search'
export const SKILLS_SH_INDEX_LIMIT = 2500
export const SKILLS_SH_INDEX_TTL_MS = 24 * 60 * 60 * 1000

const WORD_QUERIES = ['doc', 'code', 'test', 'web', 'api', 'data', 'git', 'pdf', 'json', 'ui']

/** 聚合查询词：26 字母 + 10 数字 + 常用词。字母/数字保证任意技能名至少命中一次查询。 */
export function skillsShIndexQueries(): string[] {
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(97 + index))
  const digits = Array.from({ length: 10 }, (_, index) => String(index))
  return [...new Set([...letters, ...digits, ...WORD_QUERIES])]
}

/** 宽松解析搜索响应：结构不对的条目直接丢弃，不让脏数据进索引。 */
export function parseSkillsShSearchResponse(payload: unknown): SkillsShSkill[] {
  if (!payload || typeof payload !== 'object') return []
  const skills = (payload as { skills?: unknown }).skills
  if (!Array.isArray(skills)) return []
  const parsed: SkillsShSkill[] = []
  for (const item of skills) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id) continue
    if (typeof raw.name !== 'string' || !raw.name) continue
    if (typeof raw.source !== 'string' || !raw.source) continue
    if (typeof raw.installs !== 'number' || !Number.isFinite(raw.installs)) continue
    parsed.push({
      id: raw.id,
      skillId: typeof raw.skillId === 'string' && raw.skillId ? raw.skillId : raw.name,
      name: raw.name,
      installs: Math.max(0, Math.floor(raw.installs)),
      source: raw.source,
    })
  }
  return parsed
}

/** 多页结果合并：按 id 去重（先到先得），安装量降序，超出上限截断。 */
export function mergeSkillsShIndex(pages: SkillsShSkill[][], limit = SKILLS_SH_INDEX_LIMIT): SkillsShSkill[] {
  const byId = new Map<string, SkillsShSkill>()
  for (const page of pages) {
    for (const skill of page) {
      if (!byId.has(skill.id)) byId.set(skill.id, skill)
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.installs - a.installs || a.id.localeCompare(b.id))
    .slice(0, limit)
}

export interface SkillsShIndexCacheFile {
  version: 1
  fetchedAt: number
  skills: SkillsShSkill[]
}

export type SkillsShIndexLookup = { status: 'fresh' | 'stale' | 'miss'; skills: SkillsShSkill[] }

/** TTL 内 fresh、超时 stale（可继续展示并后台刷新）、结构损坏 miss。 */
export function lookupSkillsShIndexCache(file: SkillsShIndexCacheFile | null, now: number, ttlMs = SKILLS_SH_INDEX_TTL_MS): SkillsShIndexLookup {
  if (!file || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.skills) || typeof file.fetchedAt !== 'number') {
    return { status: 'miss', skills: [] }
  }
  const skills = parseSkillsShSearchResponse({ skills: file.skills })
  return { status: now - file.fetchedAt <= ttlMs ? 'fresh' : 'stale', skills }
}

function normalizeSkillName(value: string): string {
  return value.toLowerCase().replace(/\.(md|markdown)$/i, '').replace(/[^a-z0-9]+/g, '')
}

/**
 * 在仓库分析出的 targets 里定位 skills.sh 条目对应的技能：
 * 精确名 > 归一化名 > sourcePath 目录/文件名段。全部落空返回 null（安装时报友好错误）。
 */
export function matchSkillsShTarget(targets: SkillInstallTarget[], skillId: string): SkillInstallTarget | null {
  const needle = normalizeSkillName(skillId)
  if (!needle) return null
  return targets.find(target => target.name === skillId)
    ?? targets.find(target => normalizeSkillName(target.name) === needle)
    ?? targets.find(target => target.sourcePath.toLowerCase().split('/').some(segment => normalizeSkillName(segment) === needle))
    ?? null
}

/** 磁盘缓存仓库：损坏文件按 miss 处理，写入失败静默（下次冷启动重拉）。 */
export function createSkillsShIndexStore(filePath: string) {
  return {
    async read(): Promise<SkillsShIndexCacheFile | null> {
      try {
        return JSON.parse(await readFile(filePath, 'utf8')) as SkillsShIndexCacheFile
      } catch {
        return null
      }
    },
    async write(file: SkillsShIndexCacheFile): Promise<void> {
      try {
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, JSON.stringify(file), 'utf8')
      } catch {
        // 缓存只是加速器，写失败不影响本次返回。
      }
    },
  }
}

export interface FetchSkillsShIndexOptions {
  queries?: string[]
  limit?: number
  timeoutMs?: number
  concurrency?: number
}

/** 拉取并聚合整个索引。部分查询失败不影响出结果；全部失败才抛错。 */
export async function fetchSkillsShIndex(fetchImpl: typeof fetch, options: FetchSkillsShIndexOptions = {}): Promise<SkillsShSkill[]> {
  const queries = options.queries ?? skillsShIndexQueries()
  const limit = options.limit ?? SKILLS_SH_INDEX_LIMIT
  const timeoutMs = options.timeoutMs ?? 20_000
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const pages: SkillsShSkill[][] = []
  let failures = 0
  const request = async (query: string): Promise<SkillsShSkill[]> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parseSkillsShSearchResponse(await response.json())
    } finally {
      clearTimeout(timer)
    }
  }
  for (let offset = 0; offset < queries.length; offset += concurrency) {
    const batch = queries.slice(offset, offset + concurrency)
    const settled = await Promise.allSettled(batch.map(request))
    for (const result of settled) {
      if (result.status === 'fulfilled') pages.push(result.value)
      else failures += 1
    }
  }
  if (failures === queries.length) throw new Error('skills.sh 目录读取失败')
  return mergeSkillsShIndex(pages, limit)
}
