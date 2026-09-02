import { describe, expect, it } from 'vitest'
import {
  SKILLS_SH_INDEX_TTL_MS,
  fetchSkillsShIndex,
  lookupSkillsShIndexCache,
  matchSkillsShTarget,
  mergeSkillsShIndex,
  parseSkillsShSearchResponse,
  skillsShIndexQueries,
} from '../electron/skills-sh'
import type { SkillInstallTarget } from '../src/types'

function target(overrides: Partial<SkillInstallTarget> & { name: string; sourcePath: string }): SkillInstallTarget {
  return {
    id: `${overrides.name}:${overrides.sourcePath}`,
    description: '',
    format: 'bundle',
    revision: 'main',
    modelInvocable: true,
    userInvocable: true,
    ...overrides,
  }
}

describe('parseSkillsShSearchResponse', () => {
  it('解析合法条目并丢弃结构不对的', () => {
    const parsed = parseSkillsShSearchResponse({
      skills: [
        { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', installs: 189038, source: 'anthropics/skills' },
        { id: 'broken', name: 'missing-source', installs: 5 },
        { id: 'x/y/z', skillId: 'z', name: 'z', installs: 'oops', source: 'x/y' },
        null,
      ],
    })
    expect(parsed).toEqual([
      { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', installs: 189038, source: 'anthropics/skills' },
    ])
  })

  it('非对象或 skills 不是数组时返回空表', () => {
    expect(parseSkillsShSearchResponse(null)).toEqual([])
    expect(parseSkillsShSearchResponse('nope')).toEqual([])
    expect(parseSkillsShSearchResponse({ skills: 'x' })).toEqual([])
  })
})

describe('mergeSkillsShIndex', () => {
  it('按 id 去重并按安装量降序', () => {
    const merged = mergeSkillsShIndex([
      [
        { id: 'a/b/one', skillId: 'one', name: 'one', installs: 10, source: 'a/b' },
        { id: 'a/b/two', skillId: 'two', name: 'two', installs: 999, source: 'a/b' },
      ],
      [
        { id: 'a/b/one', skillId: 'one', name: 'one', installs: 10, source: 'a/b' },
        { id: 'c/d/three', skillId: 'three', name: 'three', installs: 500, source: 'c/d' },
      ],
    ])
    expect(merged.map(item => item.id)).toEqual(['a/b/two', 'c/d/three', 'a/b/one'])
  })

  it('超出上限时截断', () => {
    const pages = Array.from({ length: 5 }, (_, i) => [
      { id: `x/y/s${i}`, skillId: `s${i}`, name: `s${i}`, installs: i, source: 'x/y' },
    ])
    expect(mergeSkillsShIndex(pages, 3)).toHaveLength(3)
  })
})

describe('lookupSkillsShIndexCache', () => {
  const skills = [{ id: 'a/b/c', skillId: 'c', name: 'c', installs: 1, source: 'a/b' }]

  it('TTL 内 fresh、超时 stale、无文件 miss', () => {
    expect(lookupSkillsShIndexCache(null, 0).status).toBe('miss')
    expect(lookupSkillsShIndexCache({ version: 1, fetchedAt: 1000, skills }, 1000 + SKILLS_SH_INDEX_TTL_MS - 1).status).toBe('fresh')
    expect(lookupSkillsShIndexCache({ version: 1, fetchedAt: 1000, skills }, 1000 + SKILLS_SH_INDEX_TTL_MS + 1).status).toBe('stale')
  })

  it('版本不对或 skills 非数组视为 miss', () => {
    expect(lookupSkillsShIndexCache({ version: 2 as 1, fetchedAt: 0, skills }, 0).status).toBe('miss')
    expect(lookupSkillsShIndexCache({ version: 1, fetchedAt: 0, skills: 'x' as never }, 0).status).toBe('miss')
  })
})

describe('matchSkillsShTarget', () => {
  const targets = [
    target({ name: 'pdf', sourcePath: 'skills/pdf/SKILL.md' }),
    target({ name: 'react-pdf', sourcePath: 'skills/react-pdf/SKILL.md' }),
    target({ name: 'quick-ref', sourcePath: 'quick-ref.md', format: 'flat' }),
    target({ name: 'Doc Helper', sourcePath: 'skills/doc-helper/SKILL.md' }),
  ]

  it('精确名优先，不会被前缀匹配抢走', () => {
    expect(matchSkillsShTarget(targets, 'pdf')?.name).toBe('pdf')
  })

  it('大小写与分隔符归一后匹配', () => {
    expect(matchSkillsShTarget(targets, 'doc_helper')?.name).toBe('Doc Helper')
  })

  it('名字匹配不上时回退到目录/文件路径', () => {
    expect(matchSkillsShTarget(targets, 'react-pdf')?.name).toBe('react-pdf')
    const renamed = [target({ name: 'weird', sourcePath: 'skills/hidden-skill/SKILL.md' })]
    expect(matchSkillsShTarget(renamed, 'hidden-skill')?.name).toBe('weird')
    const flatOnly = [target({ name: 'misc', sourcePath: 'docs/flat-skill.md', format: 'flat' })]
    expect(matchSkillsShTarget(flatOnly, 'flat-skill')?.name).toBe('misc')
  })

  it('匹配不到返回 null', () => {
    expect(matchSkillsShTarget(targets, 'nope')).toBeNull()
    expect(matchSkillsShTarget([], 'pdf')).toBeNull()
  })
})

describe('skillsShIndexQueries', () => {
  it('覆盖 26 字母、10 数字与常用词', () => {
    const queries = skillsShIndexQueries()
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') expect(queries).toContain(letter)
    for (const digit of '0123456789') expect(queries).toContain(digit)
    expect(queries).toContain('doc')
    expect(queries).toContain('code')
    expect(new Set(queries).size).toBe(queries.length)
  })
})

describe('fetchSkillsShIndex', () => {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response

  it('聚合多个查询结果并去重排序', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string) => {
      calls.push(input)
      const q = new URL(input).searchParams.get('q') ?? ''
      return json({
        skills: [
          { id: `repo/${q}-hot`, skillId: `${q}-hot`, name: `${q}-hot`, installs: 500, source: 'repo/x' },
          { id: 'shared/one', skillId: 'one', name: 'one', installs: 9999, source: 'shared/one' },
        ],
      })
    }) as typeof fetch
    const merged = await fetchSkillsShIndex(fetchImpl, { queries: ['a', 'b'] })
    expect(calls).toHaveLength(2)
    expect(calls.every(url => url.startsWith('https://www.skills.sh/api/search?q='))).toBe(true)
    expect(merged[0]?.id).toBe('shared/one')
    expect(merged.filter(item => item.id === 'shared/one')).toHaveLength(1)
  })

  it('部分查询失败不影响出结果，全部失败才报错', async () => {
    const fetchImpl = (async (input: string) => {
      if (input.includes('q=fail')) throw new Error('network down')
      return json({ skills: [{ id: 'a/b/c', skillId: 'c', name: 'c', installs: 3, source: 'a/b' }] })
    }) as typeof fetch
    await expect(fetchSkillsShIndex(fetchImpl, { queries: ['fail', 'ok'] })).resolves.toHaveLength(1)
    await expect(fetchSkillsShIndex((async () => { throw new Error('offline') }) as typeof fetch, { queries: ['a', 'b'] })).rejects.toThrow()
  })
})
