// 技能市场（C 端设置页内嵌）的纯数据层：精选源、摊平去重、筛选、安装请求构造。
// 数据来自现成的 api.analyzeCatalogRepository（主进程已带缓存），此处只做展示整形。

import type { CatalogRepositoryAnalysis, InstalledSkill, SkillInstallRequest, SkillInstallTarget } from '../types'

export type SkillMarketSourceKind = 'anthropic' | 'dsh'

export interface SkillMarketSource {
  /** GitHub owner/repo。 */
  repository: string
  defaultBranch: string
  label: string
  kind: SkillMarketSourceKind
}

/** 精选技能源：Anthropic 官方仓库 + 本仓库 catalog 已同步的 DSH 社区技能仓库。 */
export const SKILL_MARKET_SOURCES: SkillMarketSource[] = [
  { repository: 'anthropics/skills', defaultBranch: 'main', label: 'Anthropic 官方', kind: 'anthropic' },
  { repository: 'hackerfish/awesome-dsh-skills', defaultBranch: 'main', label: 'DSH 社区精选', kind: 'dsh' },
  { repository: 'asakumizy/dsh-local-skills', defaultBranch: 'main', label: 'DSH 本地技能', kind: 'dsh' },
]

export interface SkillMarketEntry {
  key: string
  name: string
  description: string
  format: 'bundle' | 'flat'
  source: SkillMarketSource
  target: SkillInstallTarget
  installed: boolean
  enabled: boolean
}

/** 把各源的分析结果摊平成市场条目：按 name 去重（SKILL_MARKET_SOURCES 顺序即优先级），并标记本机已安装/启用。 */
export function collectSkillMarketEntries(
  analyses: Record<string, CatalogRepositoryAnalysis | null>,
  installedSkills: InstalledSkill[],
): SkillMarketEntry[] {
  const installedByName = new Map(installedSkills.map(skill => [skill.name, skill]))
  const seen = new Set<string>()
  const entries: SkillMarketEntry[] = []
  for (const source of SKILL_MARKET_SOURCES) {
    const targets = analyses[source.repository]?.skillAnalysis?.targets ?? []
    for (const target of targets) {
      if (seen.has(target.name)) continue
      seen.add(target.name)
      const installed = installedByName.get(target.name)
      entries.push({
        key: `${source.repository}#${target.id}`,
        name: target.name,
        description: target.description,
        format: target.format,
        source,
        target,
        installed: installed !== undefined,
        enabled: installed?.enabled === true,
      })
    }
  }
  return entries
}

/** 搜索（名称+描述，大小写不敏感）与按源类型筛选。 */
export function filterSkillMarketEntries(
  entries: SkillMarketEntry[],
  query: string,
  sourceKind: 'all' | SkillMarketSourceKind,
): SkillMarketEntry[] {
  const text = query.trim().toLowerCase()
  return entries.filter(entry => {
    if (sourceKind !== 'all' && entry.source.kind !== sourceKind) return false
    if (!text) return true
    return `${entry.name} ${entry.description}`.toLowerCase().includes(text)
  })
}

/** 安装请求：meta-repo 子模块 target 指向其 sourceRepository 与精确 revision；普通 target 指向源仓库默认分支。 */
export function skillInstallRequestFor(entry: SkillMarketEntry): SkillInstallRequest {
  const submodule = entry.target.sourceRepository
  return {
    repository: submodule ?? entry.source.repository,
    defaultBranch: submodule ? entry.target.revision : entry.source.defaultBranch,
    targetId: entry.target.id,
  }
}