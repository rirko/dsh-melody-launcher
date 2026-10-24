import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LauncherApi } from '../src/types'

let api: LauncherApi
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../src/demo-api')).demoApi
})

describe('demo catalog neutrality', () => {
  it.each(['', 'DSH Oil UI', 'unrelated-keyword'])('does not inject the routing suite for %j', async query => {
    const result = await api.discoverCatalog(query, 'stars', 1)
    expect(result.repositories.some(repository => repository.fullName === 'yjh051108/dsh-routing-suite')).toBe(false)
    if (query) expect(result.repositories).toEqual([])
  })

  it('handles its URL through the same generic import path as other unlisted repositories', async () => {
    const suite = await api.importCatalogUrl('https://github.com/yjh051108/dsh-routing-suite')
    const ordinary = await api.importCatalogUrl('https://github.com/example/unlisted-repository')
    expect(suite.repository.description).toBe(ordinary.repository.description)
    expect(suite.repository.candidateTypes).toEqual(ordinary.repository.candidateTypes)
    expect(suite.analysis.kind).toBe(ordinary.analysis.kind)
    expect(suite.analysis.componentKinds).toEqual(ordinary.analysis.componentKinds)
    expect(suite.analysis.presetAnalysis).toBeUndefined()
  })
})
