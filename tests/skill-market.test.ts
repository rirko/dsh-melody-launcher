import { describe, expect, it } from 'vitest'
import {
  SKILL_CATEGORIES,
  SKILL_MARKET_SOURCES,
  collectSkillMarketEntries,
  filterSkillMarketEntries,
  guessSkillCategory,
  localizeSkillEntry,
  partitionDshVersions,
  skillInstallRequestFor,
} from '../src/lib/skill-market'
import type { InstalledSkill, SkillInstallTarget, SkillRepositoryAnalysis } from '../src/types'

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
      'anthropics/skills': analysis('anthropics/skills', [
        target({ id: 'pdf:skills/pdf', name: 'pdf', description: 'PDF 处理' }),
        target({ id: 'docx:skills/docx', name: 'docx', description: 'Word 处理' }),
      ]),
      'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [
        target({ id: 'pdf:pdf', name: 'pdf', description: '社区版 pdf' }),
        target({ id: 'dsh-local-x:x', name: 'dsh-local-x', format: 'flat' }),
      ]),
      'asakumizy/dsh-local-skills': null,
    }
    const entries = collectSkillMarketEntries(analyses, installed)
    const names = entries.map(entry => entry.name)
    expect(names).toEqual(['pdf', 'docx', 'dsh-local-x'])
    const pdf = entries.find(entry => entry.name === 'pdf')!
    expect(pdf.source.repository).toBe('anthropics/skills')
    expect(pdf.installed).toBe(true)
    expect(pdf.enabled).toBe(true)
    const x = entries.find(entry => entry.name === 'dsh-local-x')!
    expect(x.installed).toBe(true)
    expect(x.enabled).toBe(false)
    expect(entries.find(entry => entry.name === 'docx')!.installed).toBe(false)
  })

  it('分析失败（null）的源被跳过而不是报错', () => {
    const entries = collectSkillMarketEntries({ 'anthropics/skills': null }, [])
    expect(entries).toEqual([])
  })
})

describe('filterSkillMarketEntries', () => {
  const analyses = {
    'anthropics/skills': analysis('anthropics/skills', [target({ id: 'pdf:s', name: 'pdf', description: 'PDF 文档处理' })]),
    'hackerfish/awesome-dsh-skills': analysis('hackerfish/awesome-dsh-skills', [target({ id: 'x:s', name: 'dsh-x', description: 'DSH 专属' })]),
  }
  const entries = collectSkillMarketEntries(analyses, [])

  it('搜索匹配名称与描述，大小写不敏感', () => {
    expect(filterSkillMarketEntries(entries, 'PDF', 'all').map(e => e.name)).toEqual(['pdf'])
    expect(filterSkillMarketEntries(entries, 'dsh', 'all').map(e => e.name)).toEqual(['dsh-x'])
  })

  it('按源类型筛选', () => {
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
      'anthropics/skills': analysis('anthropics/skills', [target({ id: 'pdf:s', name: 'pdf' })]),
    }, [])[0]
    expect(skillInstallRequestFor(entry)).toEqual({
      repository: 'anthropics/skills',
      defaultBranch: 'main',
      targetId: 'pdf:s',
    })
  })

  it('源常量包含 Anthropic 官方与 DSH 社区仓库', () => {
    expect(SKILL_MARKET_SOURCES.some(s => s.repository === 'anthropics/skills')).toBe(true)
    expect(SKILL_MARKET_SOURCES.filter(s => s.kind === 'dsh').length).toBeGreaterThan(0)
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
    'anthropics/skills': analysis('anthropics/skills', [target({ id: 'pdf:s', name: 'pdf', description: 'Use this skill for PDF files' })]),
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
      'anthropics/skills': analysis('anthropics/skills', [
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