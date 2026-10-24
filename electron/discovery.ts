import type {
  CatalogCandidateType,
  CatalogRepositoryResult,
} from '../src/types'
import { isDshRepository } from './dsh-install'

/** GitHub Plugin / Skill 统一目录检索。解析与映射是纯函数，网络调用单独一层。 */

const SEARCH_ENDPOINT = 'https://api.github.com/search/repositories'
const PLUGIN_TOPIC = 'dsh-plugin'
const APPLICATION_TOPIC = 'dsh-app'
/** 资源市场每页最终展示的普通仓库数量。 */
export const CATALOG_PAGE_SIZE = 30
/** GitHub 单次搜索尽量取满，减少全局分页需要的请求次数。 */
export const CATALOG_SOURCE_PAGE_SIZE = 100
export const GITHUB_SEARCH_RESULT_LIMIT = 1000
export const GITHUB_SOURCE_MAX_PAGE = Math.ceil(GITHUB_SEARCH_RESULT_LIMIT / CATALOG_SOURCE_PAGE_SIZE)
export const CATALOG_MAX_PAGE = Math.ceil(GITHUB_SEARCH_RESULT_LIMIT * 2 / CATALOG_PAGE_SIZE)

export type DiscoverySort = 'stars' | 'updated'

/** GitHub Search API 返回的仓库条目中本模块用到的字段。 */
export interface GitHubRepositoryItem {
  id: number
  full_name: string
  name: string
  owner: { login: string }
  description: string | null
  html_url: string
  stargazers_count: number
  size?: number
  language: string | null
  updated_at: string
  topics?: string[]
  default_branch: string
}

export interface DiscoveryResponse {
  repositories: CatalogRepositoryResult[]
  topicTotals: Record<CatalogCandidateType, number>
  page: number
  pageCount: number
  rateRemaining?: number
  warnings: string[]
}

/**
 * 构造检索式。用户输入会被裁剪到 80 字符并剔除除字母、数字、点、下划线、
 * 空格和连字符以外的内容，避免注入额外的搜索限定符。
 */
export function buildSearchQuery(query: string, topic: string): string {
  const normalized = query.trim().replace(/[^\p{L}\p{N}._ -]/gu, ' ').slice(0, 80)
  return `topic:${topic}${normalized ? ` ${normalized} in:name,description` : ''}`
}

export function buildSearchUrl(query: string, sort: DiscoverySort, page: number, topic: string): URL {
  const normalizedPage = Math.min(GITHUB_SOURCE_MAX_PAGE, Math.max(1, Math.floor(Number(page) || 1)))
  const url = new URL(SEARCH_ENDPOINT)
  url.searchParams.set('q', buildSearchQuery(query, topic))
  url.searchParams.set('sort', sort)
  url.searchParams.set('order', 'desc')
  url.searchParams.set('per_page', String(CATALOG_SOURCE_PAGE_SIZE))
  url.searchParams.set('page', String(normalizedPage))
  return url
}

export function mapCatalogRepository(
  item: GitHubRepositoryItem,
  candidateTypes: CatalogCandidateType[],
): CatalogRepositoryResult {
  return {
    id: item.id,
    fullName: item.full_name,
    name: item.name,
    owner: item.owner.login,
    description: item.description ?? '此仓库没有提供说明。',
    url: item.html_url,
    stars: item.stargazers_count,
    sizeKb: item.size,
    language: item.language,
    updatedAt: item.updated_at,
    topics: item.topics ?? [],
    defaultBranch: item.default_branch,
    kind: isDshRepository(item.full_name) ? 'dsh' : 'repository',
    candidateTypes: isDshRepository(item.full_name) ? [] : [...new Set(candidateTypes)],
  }
}

export function describeSearchFailure(status: number): Error {
  if (status === 403) return new Error('GitHub 请求额度暂时用尽，请稍后重试。')
  return new Error(`GitHub 返回 ${status}，暂时无法获取插件。`)
}

/** 执行一次 GitHub 搜索，解析仓库列表与速率余量。 */
async function searchRepositories(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<{ repositories: GitHubRepositoryItem[]; totalCount: number; rateRemaining?: number }> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DSH-Launcher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) throw describeSearchFailure(response.status)

  const data = await response.json() as { total_count: number; items: GitHubRepositoryItem[] }
  const remainingHeader = response.headers.get('x-ratelimit-remaining')
  const remaining = remainingHeader == null ? Number.NaN : Number(remainingHeader)
  return {
    repositories: data.items,
    totalCount: data.total_count,
    rateRemaining: Number.isFinite(remaining) ? remaining : undefined,
  }
}

async function searchRepositoryPrefix(
  query: string,
  sort: DiscoverySort,
  targetCount: number,
  topic: string,
  fetchImpl: typeof fetch,
): Promise<{ repositories: GitHubRepositoryItem[]; totalCount: number; rateRemaining?: number }> {
  const cappedTarget = Math.min(GITHUB_SEARCH_RESULT_LIMIT, Math.max(1, targetCount))
  const sourcePages = Math.min(GITHUB_SOURCE_MAX_PAGE, Math.ceil(cappedTarget / CATALOG_SOURCE_PAGE_SIZE))
  const results = await Promise.all(Array.from({ length: sourcePages }, (_, index) =>
    searchRepositories(buildSearchUrl(query, sort, index + 1, topic), fetchImpl)))
  const remaining = results
    .map(result => result.rateRemaining)
    .filter((value): value is number => value !== undefined)
  return {
    repositories: results.flatMap(result => result.repositories).slice(0, cappedTarget),
    totalCount: results[0]?.totalCount ?? 0,
    rateRemaining: remaining.length > 0 ? Math.min(...remaining) : undefined,
  }
}

function mergeRepository(
  repositories: Map<string, CatalogRepositoryResult>,
  item: GitHubRepositoryItem,
  candidateType: CatalogCandidateType,
): void {
  const key = item.full_name.toLowerCase()
  const existing = repositories.get(key)
  if (!existing) {
    repositories.set(key, mapCatalogRepository(item, [candidateType]))
    return
  }
  if (existing.kind === 'dsh') return
  if (!existing.candidateTypes.includes(candidateType)) {
    existing.candidateTypes = [...existing.candidateTypes, candidateType]
  }
  if (existing.sizeKb == null && item.size != null) existing.sizeKb = item.size
  existing.topics = [...new Set([...existing.topics, ...(item.topics ?? [])])]
}

function mergeSearchItem(
  repositories: Map<string, CatalogRepositoryResult>,
  item: GitHubRepositoryItem,
  sourceType: CatalogCandidateType,
): void {
  mergeRepository(repositories, item, sourceType)
}

function repositoryOrder(sort: DiscoverySort) {
  return (left: CatalogRepositoryResult, right: CatalogRepositoryResult): number => {
    const primary = sort === 'stars'
      ? right.stars - left.stars
      : right.updatedAt.localeCompare(left.updatedAt)
    return primary || left.fullName.localeCompare(right.fullName)
  }
}

function failureWarning(type: CatalogCandidateType, reason: unknown): string {
  const label = type === 'plugin' ? 'Plugin' : type === 'skill' ? 'Skill' : '应用加载项'
  const message = reason instanceof Error ? reason.message : String(reason)
  const sourceLabel = type === 'application' ? `${label}来源` : `${label} 来源`
  return `${sourceLabel}检索失败：${message}`
}

/**
 * 资源市场只从 Plugin 与应用加载项 topic 获取候选。Skill 不作为独立来源，
 * 但统一仓库分析器仍会检查候选仓库中的 Skill 组件。
 */
export async function searchCatalogRepositories(
  query: string,
  sort: DiscoverySort,
  page: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResponse> {
  const normalizedPage = Math.min(CATALOG_MAX_PAGE, Math.max(1, Math.floor(Number(page) || 1)))
  const targetCount = normalizedPage * CATALOG_PAGE_SIZE
  const [pluginResult, applicationResult] = await Promise.allSettled([
    searchRepositoryPrefix(query, sort, targetCount, PLUGIN_TOPIC, fetchImpl),
    searchRepositoryPrefix(query, sort, targetCount, APPLICATION_TOPIC, fetchImpl),
  ])

  if (pluginResult.status === 'rejected' && applicationResult.status === 'rejected') {
    throw new Error([
      failureWarning('plugin', pluginResult.reason),
      failureWarning('application', applicationResult.reason),
    ].join('；'))
  }

  const warnings: string[] = []
  if (pluginResult.status === 'rejected') warnings.push(failureWarning('plugin', pluginResult.reason))
  if (applicationResult.status === 'rejected') warnings.push(failureWarning('application', applicationResult.reason))

  const pluginFound = pluginResult.status === 'fulfilled' ? pluginResult.value : null
  const applicationFound = applicationResult.status === 'fulfilled' ? applicationResult.value : null
  const repositories = new Map<string, CatalogRepositoryResult>()

  for (const item of pluginFound?.repositories ?? []) mergeSearchItem(repositories, item, 'plugin')
  for (const item of applicationFound?.repositories ?? []) mergeSearchItem(repositories, item, 'application')

  const remaining = [pluginFound?.rateRemaining, applicationFound?.rateRemaining]
    .filter((value): value is number => value !== undefined)
  const sortedRepositories = [...repositories.values()].sort(repositoryOrder(sort))
  const pageStart = (normalizedPage - 1) * CATALOG_PAGE_SIZE
  const pageRepositories = sortedRepositories.slice(pageStart, pageStart + CATALOG_PAGE_SIZE)
  const totalAvailable = [pluginFound?.totalCount, applicationFound?.totalCount]
    .reduce<number>((sum, total) => sum + Math.min(total ?? 0, GITHUB_SEARCH_RESULT_LIMIT), 0)
  return {
    repositories: pageRepositories,
    topicTotals: {
      plugin: pluginFound?.totalCount ?? 0,
      skill: 0,
      application: applicationFound?.totalCount ?? 0,
    },
    page: normalizedPage,
    pageCount: Math.max(normalizedPage, Math.ceil(totalAvailable / CATALOG_PAGE_SIZE), 1),
    rateRemaining: remaining.length > 0 ? Math.min(...remaining) : undefined,
    warnings,
  }
}
