import type { CatalogIndexEntry, CatalogRepositoryAnalysis } from '../types'

// v7：Release 可执行资产加入分析结果；旧检测结果必须重新获取。
const STORAGE_KEY = 'dsh-launcher.catalog-analysis.v7'
const LEGACY_STORAGE_KEYS = [
  'dsh-launcher.catalog-analysis.v1',
  'dsh-launcher.catalog-analysis.v2',
  'dsh-launcher.catalog-analysis.v3',
  'dsh-launcher.catalog-analysis.v4',
  'dsh-launcher.catalog-analysis.v5',
  'dsh-launcher.catalog-analysis.v6',
]
const INDEX_STORAGE_KEY = 'dsh-launcher.catalog-index.v1'
const memoryCache = new Map<string, CatalogCacheEntry>()

export interface CatalogCacheEntry {
  repository: string
  defaultBranch: string
  analysis: CatalogRepositoryAnalysis
  cachedAt: number
}

function cacheKey(repository: string, defaultBranch: string): string {
  return `${repository.toLowerCase()}#${defaultBranch}`
}

function readStorage(): Record<string, CatalogCacheEntry> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, CatalogCacheEntry>
  } catch {
    return {}
  }
}

function writeStorage(entries: Record<string, CatalogCacheEntry>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Private browsing and quota errors fall back to the in-memory cache.
  }
}

function clearLegacyStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return
    for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key)
  } catch {
    // Ignore unavailable storage.
  }
}

// Do this once when the cache module is loaded so an already-running launcher
// does not retain stale analysis after upgrading to the Release-aware format.
clearLegacyStorage()

export function readCatalogAnalysisCache(
  repository: string,
  defaultBranch: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
): CatalogRepositoryAnalysis | null {
  const key = cacheKey(repository, defaultBranch)
  const stored = readStorage()[key] ?? memoryCache.get(key)
  if (!stored || Date.now() - stored.cachedAt > maxAgeMs || stored.repository.toLowerCase() !== repository.toLowerCase()) return null
  memoryCache.set(key, stored)
  return stored.analysis
}

export function writeCatalogAnalysisCache(
  repository: string,
  defaultBranch: string,
  analysis: CatalogRepositoryAnalysis,
): void {
  const key = cacheKey(repository, defaultBranch)
  const entry: CatalogCacheEntry = { repository, defaultBranch, analysis, cachedAt: Date.now() }
  memoryCache.set(key, entry)
  const entries = readStorage()
  entries[key] = entry
  writeStorage(entries)
}

export function clearCatalogAnalysisCache(): void {
  memoryCache.clear()
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY)
      clearLegacyStorage()
    }
  } catch {
    // Ignore unavailable storage.
  }
}

/** 只保存远端共享索引中的最终标签，供市场在未做本地深度检测前显示类型。 */
export function readCatalogIndexCache(): CatalogIndexEntry[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(INDEX_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(entry => {
      if (!entry || typeof entry !== 'object') return false
      const value = entry as Partial<CatalogIndexEntry>
      return typeof value.repository === 'string'
        && typeof value.defaultBranch === 'string'
        && Array.isArray(value.tags)
    }) as CatalogIndexEntry[]
  } catch {
    return []
  }
}

export function writeCatalogIndexCache(entries: CatalogIndexEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Private browsing and quota errors do not affect the actual catalog detection.
  }
}
