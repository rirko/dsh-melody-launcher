import { describe, expect, it } from 'vitest'
import { DSH_MARKET_CACHE_TTL_MS, lookupDshMarketCache } from '../electron/dsh-market'

const registry = { updated: '2026-09-01', count: 1, categories: {}, plugins: [{ name: 'p', owner: 'o', url: 'https://github.com/o/p', category: 'ui', description: {}, stars: 1, added: '', install: '' }] }

describe('lookupDshMarketCache', () => {
  it('TTL 内 fresh、超时 stale、无文件 miss', () => {
    expect(lookupDshMarketCache(null, 0).status).toBe('miss')
    const file = { version: 1 as const, fetchedAt: 1000, validator: 'etag-1', registry }
    expect(lookupDshMarketCache(file, 1000 + DSH_MARKET_CACHE_TTL_MS - 1).status).toBe('fresh')
    const stale = lookupDshMarketCache(file, 1000 + DSH_MARKET_CACHE_TTL_MS + 1)
    expect(stale.status).toBe('stale')
    expect(stale.registry).not.toBeNull()
    expect(stale.validator).toBe('etag-1')
  })

  it('结构损坏按 miss 处理', () => {
    expect(lookupDshMarketCache({ version: 2, fetchedAt: 0, validator: null, registry } as never, 0).status).toBe('miss')
    expect(lookupDshMarketCache({ version: 1, fetchedAt: 'x', validator: null, registry } as never, 0).status).toBe('miss')
    expect(lookupDshMarketCache({ version: 1, fetchedAt: 0, validator: null, plugins: 'nope' } as never, 0).status).toBe('miss')
  })
})
