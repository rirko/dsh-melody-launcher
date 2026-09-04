import { describe, expect, it } from 'vitest'
import { skillTargetsFromArchiveEntries, type SkillArchiveEntry } from '../electron/skill-catalog'

function skillFile(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n正文`
}

const entries: SkillArchiveEntry[] = [
  { path: 'skills/pdf/SKILL.md', content: skillFile('pdf', 'PDF 处理') },
  { path: 'skills/docx/SKILL.md', content: skillFile('docx', 'Word 处理') },
  { path: 'quick-ref.md', content: skillFile('quick-ref', '速查') },
  { path: 'README.md', content: skillFile('readme', '不该出现') },
  { path: 'docs/guide.md', content: '没有 frontmatter 的普通文档' },
]

describe('skillTargetsFromArchiveEntries', () => {
  it('bundle 取 SKILL.md、flat 取顶层 .md，README 与无 frontmatter 文档被排除', () => {
    const targets = skillTargetsFromArchiveEntries('anthropics/skills', 'main', entries)
    expect(targets.map(target => target.name)).toEqual(['docx', 'pdf', 'quick-ref'])
    const pdf = targets.find(target => target.name === 'pdf')!
    expect(pdf.format).toBe('bundle')
    expect(pdf.sourcePath).toBe('skills/pdf/SKILL.md')
    expect(pdf.revision).toBe('main')
    expect(pdf.id).toBe('pdf:skills/pdf/SKILL.md')
    expect(targets.find(target => target.name === 'quick-ref')!.format).toBe('flat')
  })

  it('同名候选按 preferTarget 去重：路径浅者优先', () => {
    const duplicated: SkillArchiveEntry[] = [
      { path: 'skills/pdf/SKILL.md', content: skillFile('pdf', '深路径') },
      { path: 'pdf/SKILL.md', content: skillFile('pdf', '浅路径') },
    ]
    const targets = skillTargetsFromArchiveEntries('a/b', 'main', duplicated)
    expect(targets).toHaveLength(1)
    expect(targets[0].sourcePath).toBe('pdf/SKILL.md')
  })
})