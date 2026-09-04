// 技能市场磁盘缓存：纯函数（命中判定/合并）+ 注入路径的读写存储。
// 目的：归档分析要下载仓库 zip，缓存让第二次打开秒出；过期条目先返回旧的、后台刷新。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SkillInstallTarget } from '../src/types'

export interface SkillMarketCacheEntry {
  repository: string
  branch: string
  fetchedAt: number
  targets: SkillInstallTarget[]
}

export interface SkillMarketCacheFile {
  version: 1
  entries: Record<string, SkillMarketCacheEntry>
}

/** 市场目录变化不频繁：24 小时内视为新鲜。 */
export const SKILL_MARKET_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function skillMarketCacheKey(repository: string, branch: string): string {
  return `${repository.toLowerCase()}#${branch}`
}

export type SkillMarketCacheLookup
  = { state: 'fresh'; entry: SkillMarketCacheEntry }
  | { state: 'stale'; entry: SkillMarketCacheEntry }
  | { state: 'miss' }

export function lookupSkillMarketCache(
  file: SkillMarketCacheFile,
  repository: string,
  branch: string,
  now = Date.now(),
  ttlMs = SKILL_MARKET_CACHE_TTL_MS,
): SkillMarketCacheLookup {
  const entry = file.entries[skillMarketCacheKey(repository, branch)]
  if (!entry || !Array.isArray(entry.targets)) return { state: 'miss' }
  return now - entry.fetchedAt <= ttlMs ? { state: 'fresh', entry } : { state: 'stale', entry }
}

export function mergeSkillMarketCache(
  file: SkillMarketCacheFile,
  entry: SkillMarketCacheEntry,
  maxEntries = 24,
): SkillMarketCacheFile {
  const key = skillMarketCacheKey(entry.repository, entry.branch)
  const entries = { ...file.entries, [key]: entry }
  const keys = Object.keys(entries)
  if (keys.length > maxEntries) {
    // 按抓取时间淘汰最旧的条目，保持缓存文件有界。
    for (const stale of keys.sort((left, right) => entries[left].fetchedAt - entries[right].fetchedAt).slice(0, keys.length - maxEntries)) {
      delete entries[stale]
    }
  }
  return { version: 1, entries }
}

export interface SkillMarketCacheStore {
  read(): Promise<SkillMarketCacheFile>
  write(entry: SkillMarketCacheEntry): Promise<void>
}

const EMPTY: SkillMarketCacheFile = { version: 1, entries: {} }

export function createSkillMarketCacheStore(filePath: string): SkillMarketCacheStore {
  let memory: SkillMarketCacheFile | null = null

  async function read(): Promise<SkillMarketCacheFile> {
    if (memory) return memory
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<SkillMarketCacheFile>
      const valid = parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries as Record<string, unknown>
        : {}
      const entries: Record<string, SkillMarketCacheEntry> = {}
      for (const [key, value] of Object.entries(valid)) {
        const item = value as Partial<SkillMarketCacheEntry>
        if (item && typeof item.repository === 'string' && typeof item.branch === 'string'
          && typeof item.fetchedAt === 'number' && Array.isArray(item.targets)) {
          entries[key] = { repository: item.repository, branch: item.branch, fetchedAt: item.fetchedAt, targets: item.targets }
        }
      }
      memory = { version: 1, entries }
    } catch {
      memory = { version: 1, entries: {} }
    }
    return memory
  }

  return {
    read,
    async write(entry): Promise<void> {
      const current = await read()
      const next = mergeSkillMarketCache(current, entry)
      memory = next
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    },
  }
}
