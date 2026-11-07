import { describe, expect, it } from 'vitest'
import {
  buildSearchQuery,
  buildSearchUrl,
  CATALOG_MAX_PAGE,
  CATALOG_PAGE_SIZE,
  CATALOG_SOURCE_PAGE_SIZE,
  describeSearchFailure,
  GITHUB_SEARCH_RESULT_LIMIT,
  GITHUB_SOURCE_MAX_PAGE,
  mapCatalogRepository,
  searchCatalogRepositories,
  type GitHubRepositoryItem,
} from '../electron/discovery'

const item: GitHubRepositoryItem = {
  id: 42,
  full_name: 'someone/dsh-example',
  name: 'dsh-example',
  owner: { login: 'someone' },
  description: 'An example plugin',
  html_url: 'https://github.com/someone/dsh-example',
  stargazers_count: 12,
  size: 1536,
  language: 'TypeScript',
  updated_at: '2026-08-01T00:00:00Z',
  topics: ['dsh-plugin'],
  default_branch: 'main',
}

function searchResponse(items: GitHubRepositoryItem[], total = items.length, remaining = 8): Response {
  return new Response(JSON.stringify({ total_count: total, items }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-ratelimit-remaining': String(remaining),
    },
  })
}

function searchFetch(
  plugin: Response,
  skill: Response,
  application: Response = searchResponse([], 0, 9),
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const query = url.searchParams.get('q') ?? ''
    if (query.includes('topic:dsh-skill')) return skill.clone()
    if (query.includes('topic:dsh-app')) return application.clone()
    return plugin.clone()
  }) as typeof fetch
}

describe('buildSearchQuery', () => {
  it('scopes searches to the requested topic', () => {
    expect(buildSearchQuery('', 'dsh-plugin')).toBe('topic:dsh-plugin')
    expect(buildSearchQuery('   ', 'dsh-skill')).toBe('topic:dsh-skill')
  })

  it('appends a sanitized name and description filter', () => {
    expect(buildSearchQuery('memory', 'dsh-plugin')).toBe('topic:dsh-plugin memory in:name,description')
    expect(buildSearchQuery('user:evil org:target', 'dsh-plugin')).toBe('topic:dsh-plugin user evil org target in:name,description')
    expect(buildSearchQuery('记忆', 'dsh-skill')).toBe('topic:dsh-skill 记忆 in:name,description')
  })

  it('caps the query length', () => {
    expect(buildSearchQuery('a'.repeat(200), 'dsh-plugin')).toBe(`topic:dsh-plugin ${'a'.repeat(80)} in:name,description`)
  })
})

describe('buildSearchUrl', () => {
  it('uses fifteen rows per source and carries the requested sort', () => {
    const url = buildSearchUrl('memory', 'updated', 2, 'dsh-plugin')
    expect(url.origin + url.pathname).toBe('https://api.github.com/search/repositories')
    expect(url.searchParams.get('sort')).toBe('updated')
    expect(url.searchParams.get('order')).toBe('desc')
    expect(url.searchParams.get('per_page')).toBe(String(CATALOG_SOURCE_PAGE_SIZE))
    expect(url.searchParams.get('page')).toBe('2')
  })

  it('clamps pages to each topic search window', () => {
    expect(buildSearchUrl('', 'stars', 0, 'dsh-plugin').searchParams.get('page')).toBe('1')
    expect(buildSearchUrl('', 'stars', 999, 'dsh-plugin').searchParams.get('page')).toBe(String(GITHUB_SOURCE_MAX_PAGE))
  })
})

describe('catalog repository mapping', () => {
  it('maps candidate source labels and placeholders', () => {
    expect(mapCatalogRepository({ ...item, description: null, topics: undefined }, ['plugin'])).toMatchObject({
      id: 42,
      fullName: 'someone/dsh-example',
      description: '此仓库没有提供说明。',
      topics: [],
      sizeKb: 1536,
      kind: 'repository',
      candidateTypes: ['plugin'],
    })
  })

  it('marks the official repository as DSH core', () => {
    const mapped = mapCatalogRepository({ ...item, full_name: 'deepseek-ai/deepseek-harness' }, ['plugin'])
    expect(mapped.kind).toBe('dsh')
    expect(mapped.candidateTypes).toEqual([])
  })
})

describe('unified catalog search', () => {
  it('reads plugin/application sources, deduplicates repositories, and sorts the page', async () => {
    const core = { ...item, id: 1, full_name: 'deepseek-ai/deepseek-harness', stargazers_count: 100 }
    const plugin = { ...item, id: 2, full_name: 'demo/plugin', stargazers_count: 20 }
    const hybrid = { ...item, id: 3, full_name: 'demo/hybrid', stargazers_count: 30, topics: ['dsh-plugin', 'dsh-skill'] }
    const result = await searchCatalogRepositories('', 'stars', 1, searchFetch(
      searchResponse([plugin, hybrid, core], 3, 7),
      searchResponse([], 2, 5),
    ))

    expect(result.repositories.map(repo => repo.fullName)).toEqual([
      'deepseek-ai/deepseek-harness',
      'demo/hybrid',
      'demo/plugin',
    ])
    expect(result.repositories.find(repo => repo.fullName === 'demo/hybrid')?.candidateTypes).toEqual(['plugin'])
    expect(result.topicTotals).toEqual({ plugin: 3, skill: 0, application: 0 })
    expect(result.rateRemaining).toBe(7)
    expect(result.warnings).toEqual([])
  })

  it('calculates page count from the capped enabled sources', async () => {
    const result = await searchCatalogRepositories('', 'stars', 1, searchFetch(
      searchResponse([], 3_257),
      searchResponse([], 15),
    ))
    expect(result.pageCount).toBe(Math.ceil(GITHUB_SEARCH_RESULT_LIMIT / CATALOG_PAGE_SIZE))
    expect(result.pageCount).toBeLessThan(CATALOG_MAX_PAGE)
  })

  it('keeps the working source when the other source fails', async () => {
    const application = { ...item, topics: ['dsh-app'] }
    const result = await searchCatalogRepositories('', 'stars', 1, searchFetch(
      new Response('failed', { status: 500 }),
      searchResponse([], 1),
      searchResponse([application], 1),
    ))
    expect(result.repositories).toHaveLength(1)
    expect(result.repositories[0].fullName).toBe('someone/dsh-example')
    expect(result.topicTotals).toEqual({ plugin: 0, skill: 0, application: 1 })
    expect(result.warnings[0]).toMatch(/Plugin 来源检索失败/)
  })

  it('merges application candidates and preserves all topic labels', async () => {
    const application = {
      ...item,
      id: 9,
      full_name: 'demo/desktop-host',
      topics: ['dsh-plugin', 'dsh-skill', 'dsh-app'],
    }
    const result = await searchCatalogRepositories('', 'stars', 1, searchFetch(
      searchResponse([application], 1, 8),
      searchResponse([application], 1, 7),
      searchResponse([application], 1, 6),
    ))

    expect(result.repositories).toHaveLength(1)
    expect(result.repositories.find(repo => repo.fullName === 'demo/desktop-host')?.candidateTypes).toEqual(['plugin', 'application'])
    expect(result.topicTotals).toEqual({ plugin: 1, skill: 0, application: 1 })
    expect(result.rateRemaining).toBe(6)
  })

  it('fails only when all enabled topic searches fail', async () => {
    await expect(searchCatalogRepositories('', 'stars', 1, searchFetch(
      new Response('failed', { status: 500 }),
      new Response('limited', { status: 403 }),
      new Response('unavailable', { status: 502 }),
    ))).rejects.toThrow(/Plugin 来源检索失败.*应用加载项来源检索失败/)
  })

  it('does not request the dsh-skill topic', async () => {
    const queries: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.pathname === '/search/repositories') queries.push(url.searchParams.get('q') ?? '')
      return searchResponse([], 0)
    }) as typeof fetch

    await searchCatalogRepositories('', 'stars', 1, fetchImpl)
    expect(queries.some(query => query.includes('topic:dsh-skill'))).toBe(false)
    expect(queries.some(query => query.includes('topic:dsh-plugin'))).toBe(true)
    expect(queries.some(query => query.includes('topic:dsh-app'))).toBe(true)
  })

  it('globally fills the popular page before lower-star application candidates', async () => {
    const plugins = Array.from({ length: CATALOG_PAGE_SIZE + 1 }, (_, index) => ({
      ...item,
      id: 100 + index,
      full_name: `demo/plugin-${index}`,
      name: `plugin-${index}`,
      stargazers_count: 10_000 - index,
    }))
    const lowStarApplication = {
      ...item,
      id: 999,
      full_name: 'demo/low-star-application',
      stargazers_count: 187,
      topics: ['dsh-app'],
    }
    const result = await searchCatalogRepositories('', 'stars', 1, searchFetch(
      searchResponse(plugins, plugins.length),
      searchResponse([], 0),
      searchResponse([lowStarApplication], 1),
    ))
    expect(result.repositories).toHaveLength(CATALOG_PAGE_SIZE)
    expect(result.repositories.every(repository => repository.stars > lowStarApplication.stargazers_count)).toBe(true)
    expect(result.repositories.some(repository => repository.fullName === lowStarApplication.full_name)).toBe(false)
  })
})

describe('search result neutrality', () => {
  it.each(['', 'DSH Oil UI', 'unrelated-keyword'])('does not inject repositories into empty results for %j', async query => {
    const urls: URL[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url))
      return searchResponse([], 0)
    }) as typeof fetch
    const result = await searchCatalogRepositories(query, 'stars', 1, fetchImpl)
    expect(result.repositories).toEqual([])
    expect(urls).toHaveLength(2)
    expect(urls.every(url => url.pathname === '/search/repositories')).toBe(true)
  })

  it('sorts the previously recommended repository like every other matching result', async () => {
    const repository = { ...item, id: 2, full_name: 'yjh051108/dsh-routing-suite', stargazers_count: 1 }
    const popular = { ...item, id: 3, full_name: 'demo/normal-result', stargazers_count: 50 }
    const result = await searchCatalogRepositories('routing', 'stars', 1, searchFetch(
      searchResponse([repository, popular]), searchResponse([]),
    ))
    expect(result.repositories.map(repo => repo.fullName)).toEqual(['demo/normal-result', 'yjh051108/dsh-routing-suite'])
    expect(result.repositories[1].description).toBe(item.description)
  })
})

describe('describeSearchFailure', () => {
  it('explains a rate limit separately from other failures', () => {
    expect(describeSearchFailure(403).message).toMatch(/额度/)
    expect(describeSearchFailure(500).message).toMatch(/500/)
  })
})
