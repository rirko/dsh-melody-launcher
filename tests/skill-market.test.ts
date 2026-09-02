import { describe, expect, it } from 'vitest'
import {
  SKILL_CATEGORIES,
  SKILL_MARKET_SOURCES,
  collectSkillMarketEntries,
  collectSkillsShEntries,
  filterSkillMarketEntries,
  formatInstalls,
  guessSkillCategory,
  localizeSkillEntry,
  partitionDshVersions,
  skillInstallRequestFor,
} from '../src/lib/skill-market'
import type { InstalledSkill, SkillInstallTarget, SkillRepositoryAnalysis, SkillsShSkill } from '../src/types'

function target(overrides: Partial<SkillInstallTarget> & { id: string; name: string }): SkillInstallTarget {
  return {
    description: '',
    sourcePath: `skills/${overrides.name}`,
    format: 'bundle',
    revision: 'a'.repeat(40),
    modelInvocable: false,
    userInvocable: false,
    ...overrides,
  }
}

function analysis(repository: string, targets: SkillInstallTarget[]): SkillRepositoryAnalysis {
  return { repository, defaultBranch: 'main', installability: 'ready', summary: '', targets }
}

const installed: InstalledSkill[] = [
  { name: 'pdf', description: '', path: 'C:\\dsh\\skills\\pdf', format: 'bundle', enabled: true, modelInvocable: false, userInvocable: false },
  { name: 'dsh-local-x', description: '', path: 'C:\\dsh\\skills\\dsh-local-x', format: 'flat', enabled: false, modelInvocable: false, userInvocable: false },
]

describe('collectSkillMarketEntries', () => {
  it('摊平各源 targets，按 name 去重（先出现的源优先），并标记已安装/启用', () => {
    const analyses = {
      'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [
        target({ id: 'pdf:pdf', name: 'pdf', description: '社区版 pdf' }),
        target({ id: 'dsh-office:office', name: 'dsh-office-artifacts', description: 'Office 产物' }),
      ]),
      'asakumizy/dsh-local-skills': analysis('asakumizy/dsh-local-skills', [
        target({ id: 'pdf:x', name: 'pdf', description: '重复的 pdf' }),
        target({ id: 'dsh-local-x:x', name: 'dsh-local-x', format: 'flat' }),
      ]),
    }
    const entries = collectSkillMarketEntries(analyses, installed)
    const names = entries.map(entry => entry.name)
    expect(names).toEqual(['pdf', 'dsh-office-artifacts', 'dsh-local-x'])
    const pdf = entries.find(entry => entry.name === 'pdf')!
    expect(pdf.source.repository).toBe('hackerfish/awesome-dsh-skills')
    expect(pdf.origin).toBe('repo')
    expect(pdf.installs).toBeNull()
    expect(pdf.installed).toBe(true)
    expect(pdf.enabled).toBe(true)
    const x = entries.find(entry => entry.name === 'dsh-local-x')!
    expect(x.installed).toBe(true)
    expect(x.enabled).toBe(false)
    expect(entries.find(entry => entry.name === 'dsh-office-artifacts')!.installed).toBe(false)
  })

  it('分析失败（null）的源被跳过而不是报错', () => {
    const entries = collectSkillMarketEntries({ 'hackerfish/awesome-dsh-skills': null }, [])
    expect(entries).toEqual([])
  })
})

describe('filterSkillMarketEntries', () => {
  const repoEntries = collectSkillMarketEntries({
    'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [target({ id: 'x:s', name: 'dsh-x', description: 'DSH 专属' })]),
  }, [])
  const indexEntries = collectSkillsShEntries([
    { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', installs: 189038, source: 'anthropics/skills' },
  ], [])
  const entries = [...indexEntries, ...repoEntries]

  it('搜索匹配名称与描述，大小写不敏感', () => {
    expect(filterSkillMarketEntries(entries, 'PDF', 'all').map(e => e.name)).toEqual(['pdf'])
    expect(filterSkillMarketEntries(entries, 'dsh', 'all').map(e => e.name)).toEqual(['dsh-x'])
  })

  it('按源类型筛选：索引条目属 general，仓库分析条目属 dsh', () => {
    expect(filterSkillMarketEntries(entries, '', 'general').map(e => e.name)).toEqual(['pdf'])
    expect(filterSkillMarketEntries(entries, '', 'dsh').map(e => e.name)).toEqual(['dsh-x'])
  })
})

describe('skillInstallRequestFor', () => {
  it('meta-repo 子模块 target 指向 sourceRepository 与精确 revision', () => {
    const entry = collectSkillMarketEntries({
      'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [
        target({ id: 'x:p', name: 'x', sourceRepository: 'someone/x-repo', revision: 'deadbeef' }),
      ]),
    }, [])[0]
    expect(skillInstallRequestFor(entry)).toEqual({
      repository: 'someone/x-repo',
      defaultBranch: 'deadbeef',
      targetId: 'x:p',
    })
  })

  it('普通 target 指向源仓库与默认分支', () => {
    const entry = collectSkillMarketEntries({
      'asakumizy/dsh-local-skills': analysis('asakumizy/dsh-local-skills', [target({ id: 'pdf:s', name: 'pdf' })]),
    }, [])[0]
    expect(skillInstallRequestFor(entry)).toEqual({
      repository: 'asakumizy/dsh-local-skills',
      defaultBranch: 'main',
      targetId: 'pdf:s',
    })
  })

  it('源常量只含 DSH 社区仓库（通用技能走 skills.sh 索引）', () => {
    expect(SKILL_MARKET_SOURCES.every(s => s.kind === 'dsh')).toBe(true)
    expect(SKILL_MARKET_SOURCES.length).toBeGreaterThan(0)
  })
})

function skillsSh(overrides: Partial<SkillsShSkill> & { id: string }): SkillsShSkill {
  return {
    skillId: overrides.id.split('/').at(-1)!,
    name: overrides.id.split('/').at(-1)!,
    installs: 0,
    source: overrides.id.split('/').slice(0, 2).join('/'),
    ...overrides,
  }
}

describe('collectSkillsShEntries', () => {
  it('索引条目转市场条目：installs/来源仓库/origin=index/target=null', () => {
    const entries = collectSkillsShEntries([
      skillsSh({ id: 'anthropics/skills/pdf', name: 'pdf', installs: 189038, source: 'anthropics/skills' }),
      skillsSh({ id: 'vercel-labs/skills/find-skills', name: 'find-skills', installs: 5000, source: 'vercel-labs/skills' }),
    ], installed)
    expect(entries.map(e => e.name)).toEqual(['pdf', 'find-skills'])
    const pdf = entries[0]
    expect(pdf.origin).toBe('index')
    expect(pdf.installs).toBe(189038)
    expect(pdf.source.kind).toBe('general')
    expect(pdf.source.repository).toBe('anthropics/skills')
    expect(pdf.target).toBeNull()
    expect(pdf.installed).toBe(true)
    expect(pdf.enabled).toBe(true)
    expect(entries[1].installed).toBe(false)
  })

  it('中文名与分类走映射表，描述缺省时回退「来自 owner/repo」', () => {
    const entries = collectSkillsShEntries([
      skillsSh({ id: 'anthropics/skills/pdf', name: 'pdf', installs: 1, source: 'anthropics/skills' }),
      skillsSh({ id: 'some/repo/quantum-frob', name: 'quantum-frob', installs: 1, source: 'some/repo' }),
    ], [])
    expect(entries[0].displayName).toBe('PDF 文档处理')
    expect(entries[0].displayDescription).toBe('对 PDF 文件做任何事：读取、合并、拆分、填写与转换。')
    expect(entries[1].displayName).toBe('quantum-frob')
    expect(entries[1].displayDescription).toBe('来自 some/repo')
    expect(entries[1].category).toBe('其它')
  })

  it('按 id 去重', () => {
    const dup = skillsSh({ id: 'a/b/c', name: 'c', installs: 2, source: 'a/b' })
    expect(collectSkillsShEntries([dup, dup], [])).toHaveLength(1)
  })
})

describe('formatInstalls', () => {
  it('一万以下原样，万以上折算 万/亿', () => {
    expect(formatInstalls(999)).toBe('999')
    expect(formatInstalls(10_000)).toBe('1 万')
    expect(formatInstalls(189_038)).toBe('18.9 万')
    expect(formatInstalls(1_234_567_890)).toBe('12.3 亿')
    expect(formatInstalls(-5)).toBe('0')
  })
})

describe('partitionDshVersions', () => {
  const candidate = (version: string, prerelease: boolean) => ({ version, label: null, lts: null, date: null, prerelease })

  it('剔除已安装版本，并按预发布标记分组', () => {
    const grouped = partitionDshVersions(
      [candidate('0.1.0', false), candidate('0.1.1-rc.2', true), candidate('0.0.9', false)],
      new Set(['0.1.0']),
    )
    expect(grouped.stable.map(item => item.version)).toEqual(['0.0.9'])
    expect(grouped.prerelease.map(item => item.version)).toEqual(['0.1.1-rc.2'])
  })
})

describe('guessSkillCategory', () => {
  it('按关键词启发式归类，未命中落入其它', () => {
    expect(guessSkillCategory('pdf', 'anything')).toBe('文档')
    expect(guessSkillCategory('canvas-design', 'Create beautiful visual art')).toBe('设计')
    expect(guessSkillCategory('mcp-builder', 'Guide for creating MCP servers')).toBe('开发')
    expect(guessSkillCategory('dsh-chinese-docs', '撰写中文技术文档时使用')).toBe('文档')
    expect(guessSkillCategory('quantum-frobnicator', 'zzz')).toBe('其它')
  })
})

describe('localizeSkillEntry', () => {
  const base = collectSkillMarketEntries({
    'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [target({ id: 'pdf:s', name: 'pdf', description: 'Use this skill for PDF files' })]),
  }, [])[0]

  it('命中映射表时给出中文名/中文简介/表内分类', () => {
    const localized = localizeSkillEntry(base)
    expect(localized.displayName).toBe('PDF 文档处理')
    expect(localized.displayDescription).toContain('PDF')
    expect(localized.category).toBe('文档')
  })

  it('未命中映射表时：描述含中文则原样优先，分类回退启发式', () => {
    const zh = collectSkillMarketEntries({
      'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [target({ id: 'x:s', name: 'totally-unknown', description: '排查 DSH 启动失败时使用' })]),
    }, [])[0]
    const localized = localizeSkillEntry(zh)
    expect(localized.displayName).toBe('totally-unknown')
    expect(localized.displayDescription).toBe('排查 DSH 启动失败时使用')
  })
})

describe('filterSkillMarketEntries 分类过滤', () => {
  it('category=all 不筛，指定分类时只留该组', () => {
    const entries = collectSkillMarketEntries({
      'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [
        target({ id: 'pdf:s', name: 'pdf', description: 'PDF' }),
        target({ id: 'canvas-design:s', name: 'canvas-design', description: 'visual art' }),
      ]),
    }, [])
    expect(filterSkillMarketEntries(entries, '', 'all', 'all').length).toBe(2)
    expect(filterSkillMarketEntries(entries, '', 'all', '文档').map(e => e.name)).toEqual(['pdf'])
    expect(filterSkillMarketEntries(entries, '', 'all', '设计').map(e => e.name)).toEqual(['canvas-design'])
    expect(SKILL_CATEGORIES).toContain('其它')
  })
})