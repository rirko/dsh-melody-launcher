import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SKILL_MARKET_CACHE_TTL_MS,
  createSkillMarketCacheStore,
  lookupSkillMarketCache,
  mergeSkillMarketCache,
  skillMarketCacheKey,
  type SkillMarketCacheEntry,
  type SkillMarketCacheFile,
} from '../electron/skill-market-cache'

const entry: SkillMarketCacheEntry = {
  repository: 'Anthropics/Skills',
  branch: 'main',
  fetchedAt: 1_000,
  targets: [{ id: 'pdf:s', name: 'pdf', description: '', sourcePath: 'skills/pdf/SKILL.md', format: 'bundle', revision: 'main', modelInvocable: true, userInvocable: true }],
}

const file = (entries: Record<string, SkillMarketCacheEntry>): SkillMarketCacheFile => ({ version: 1, entries })

describe('lookupSkillMarketCache', () => {
  it('新鲜/过期/未命中三态判定，key 大小写不敏感', () => {
    const stored = file({ [skillMarketCacheKey('anthropics/skills', 'main')]: entry })
    expect(lookupSkillMarketCache(stored, 'Anthropics/Skills', 'main', 1_000 + 60_000).state).toBe('fresh')
    expect(lookupSkillMarketCache(stored, 'anthropics/skills', 'main', 1_000 + SKILL_MARKET_CACHE_TTL_MS + 1).state).toBe('stale')
    expect(lookupSkillMarketCache(stored, 'other/repo', 'main').state).toBe('miss')
  })
})

describe('mergeSkillMarketCache', () => {
  it('同 key 覆盖，超出上限时按 fetchedAt 淘汰最旧', () => {
    let cache = file({})
    for (let index = 0; index < 5; index += 1) {
      cache = mergeSkillMarketCache(cache, { ...entry, repository: `a/repo-${index}`, fetchedAt: 100 + index }, 3)
    }
    const keys = Object.keys(cache.entries)
    expect(keys).toHaveLength(3)
    expect(keys).toContain(skillMarketCacheKey('a/repo-4', 'main'))
    expect(keys).not.toContain(skillMarketCacheKey('a/repo-0', 'main'))
  })
})

describe('createSkillMarketCacheStore', () => {
  it('读写往返；损坏文件回退为空而不抛错', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'skill-cache-'))
    const filePath = path.join(dir, 'skill-market-cache.json')
    try {
      const store = createSkillMarketCacheStore(filePath)
      expect((await store.read()).entries).toEqual({})
      await store.write(entry)
      const reopened = createSkillMarketCacheStore(filePath)
      const found = lookupSkillMarketCache(await reopened.read(), 'anthropics/skills', 'main', 1_000 + 10)
      expect(found.state).toBe('fresh')
      if (found.state !== 'miss') expect(found.entry.targets[0].name).toBe('pdf')

      const { writeFile } = await import('node:fs/promises')
      await writeFile(filePath, '{ not json', 'utf8')
      const broken = createSkillMarketCacheStore(filePath)
      expect((await broken.read()).entries).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})