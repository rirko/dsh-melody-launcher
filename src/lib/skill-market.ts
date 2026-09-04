// 技能市场（C 端设置页内嵌）的纯数据层：展示整形、摊平去重、筛选、安装请求构造。
// 通用技能来自 skills.sh 目录索引（api.skillMarketCatalog，千级、带安装量）；
// DSH 社区栏仍走精选仓库的归档式检测（api.skillMarketAnalyze，主进程带缓存）。

import type { InstalledSkill, RuntimeVersionCandidate, SkillInstallRequest, SkillInstallTarget, SkillRepositoryAnalysis, SkillsShSkill } from '../types'

export type SkillMarketSourceKind = 'general' | 'dsh'

export interface SkillMarketSource {
  /** GitHub owner/repo。 */
  repository: string
  defaultBranch: string
  label: string
  kind: SkillMarketSourceKind
}

/**
 * DSH 社区精选仓库（归档式检测）。通用技能不再逐仓库预析，改由 skills.sh 索引提供。
 * 某源拉取失败只会显示该源的重试行，不影响其它源出结果。
 */
export const SKILL_MARKET_SOURCES: SkillMarketSource[] = [
  { repository: 'hackerfish/awesome-dsh-skills', defaultBranch: 'main', label: 'DSH 社区精选', kind: 'dsh' },
  { repository: 'asakumizy/dsh-local-skills', defaultBranch: 'main', label: 'DSH 本地技能', kind: 'dsh' },
]

export interface SkillMarketEntry {
  key: string
  name: string
  description: string
  format: 'bundle' | 'flat'
  source: SkillMarketSource
  /** 仓库分析条目携带安装 target；skills.sh 索引条目为 null（安装时主进程再定位）。 */
  target: SkillInstallTarget | null
  /** 条目来源：repo = 精选仓库归档分析；index = skills.sh 目录索引。 */
  origin: 'repo' | 'index'
  /** skills.sh 安装量（索引条目），仓库条目为 null。 */
  installs: number | null
  installed: boolean
  enabled: boolean
  /** 展示用中文名（映射表命中时），否则回退原文名。 */
  displayName: string
  /** 展示用简介：表内中文 > 原文含中文 > 原文。 */
  displayDescription: string
  category: SkillCategory
}

export type SkillCategory = '文档' | '设计' | '开发' | '效率' | '其它'

export const SKILL_CATEGORIES: SkillCategory[] = ['文档', '设计', '开发', '效率', '其它']

interface SkillZhMeta {
  category: SkillCategory
  nameZh?: string
  descriptionZh?: string
}

/**
 * 精选技能的中文展示表（key = SKILL.md 的 name）。
 * 未收录的技能回退原文描述 + 启发式分类；新技能出现时往这里补一行即可。
 */
export const SKILL_ZH_META: Record<string, SkillZhMeta> = {
  'academy-guide': { category: '开发', nameZh: '学院指南', descriptionZh: '回答 Claude Code 用法问题前先查阅的使用指南。' },
  'algorithmic-art': { category: '设计', nameZh: '算法艺术', descriptionZh: '用 p5.js 与种子随机创作算法艺术。' },
  'brand-guidelines': { category: '设计', nameZh: '品牌规范', descriptionZh: '为产物套用 Anthropic 官方品牌配色与字体。' },
  'canvas-design': { category: '设计', nameZh: '画布设计', descriptionZh: '以设计理念创作 PNG/PDF 视觉作品。' },
  'claude-api': { category: '开发', nameZh: 'Claude API', descriptionZh: 'Claude API / SDK 参考：模型、定价、参数、流式与工具调用。' },
  'discernment-nudge': { category: '效率', nameZh: '判断提醒', descriptionZh: '在给出可执行建议前触发二次审视与风险提示。' },
  'doc-coauthoring': { category: '文档', nameZh: '文档合写', descriptionZh: '引导用户按结构化流程共同撰写文档。' },
  docx: { category: '文档', nameZh: 'Word 文档', descriptionZh: '创建、读取、编辑与转换 .docx 文档。' },
  'frontend-design': { category: '设计', nameZh: '前端设计', descriptionZh: '构建或重塑 UI 时的视觉设计指导。' },
  'internal-comms': { category: '文档', nameZh: '内部沟通', descriptionZh: '按公司格式撰写各类内部通告与沟通稿。' },
  'mcp-builder': { category: '开发', nameZh: 'MCP 服务器构建', descriptionZh: '创建高质量 MCP（Model Context Protocol）服务器的指南。' },
  pdf: { category: '文档', nameZh: 'PDF 文档处理', descriptionZh: '对 PDF 文件做任何事：读取、合并、拆分、填写与转换。' },
  pptx: { category: '文档', nameZh: 'PPT 演示文稿', descriptionZh: '涉及 .pptx/.potx 幻灯片的创建、读取与编辑。' },
  'skill-creator': { category: '开发', nameZh: '技能创建器', descriptionZh: '创建、改进与评测 Agent 技能。' },
  'slack-gif-creator': { category: '设计', nameZh: 'Slack GIF', descriptionZh: '制作适配 Slack 的动图 GIF。' },
  'template-skill': { category: '其它', nameZh: '技能模板', descriptionZh: '新建技能时的 SKILL.md 模板示例。' },
  'theme-factory': { category: '设计', nameZh: '主题工厂', descriptionZh: '为幻灯片、文档、报告等产物套用主题样式工具集。' },
  'web-artifacts-builder': { category: '开发', nameZh: 'Web 产物构建', descriptionZh: '构建复杂多组件的 claude.ai HTML 产物。' },
  'webapp-testing': { category: '开发', nameZh: 'Web 应用测试', descriptionZh: '用 Playwright 交互并测试本地 Web 应用。' },
  xlsx: { category: '文档', nameZh: 'Excel 表格', descriptionZh: '以电子表格为输入/输出的读取、编辑与生成。' },
  'dsh-office-artifacts': { category: '文档', descriptionZh: '创建、修复与校验 XLSX/DOCX/PPTX/PDF 交付物。' },
  'dsh-skill-adapter': { category: '开发', descriptionZh: '把公开 SKILL.md 转换为 DSH 兼容技能。' },
  'dsh-webapp-testing': { category: '开发', descriptionZh: '校验本地 Web 应用的浏览器渲染行为。' },
  'dsh-changelog': { category: '文档' },
  'dsh-chinese-docs': { category: '文档' },
  'dsh-code-review': { category: '开发' },
  'dsh-debug-session': { category: '开发' },
  'dsh-dependency-audit': { category: '开发' },
  'dsh-doc-sync': { category: '文档' },
  'dsh-git-commit': { category: '效率' },
  'dsh-plugin-client': { category: '开发' },
  'dsh-plugin-dev': { category: '开发' },
  'dsh-plugin-i18n': { category: '开发' },
  'dsh-plugin-publish': { category: '开发' },
  'dsh-pr-review': { category: '开发' },
  'dsh-refactor-safe': { category: '开发' },
  'dsh-task-breakdown': { category: '效率' },
  'dsh-test-first': { category: '开发' },
  'code-review': { category: '开发' },
  'git-commit': { category: '效率' },
  // ---- obra/superpowers ----
  brainstorming: { category: '效率', nameZh: '头脑风暴', descriptionZh: '动手前先把问题、约束与方案空间聊清楚。' },
  'writing-plans': { category: '效率', nameZh: '撰写计划', descriptionZh: '把目标拆成可验证的分步实施计划。' },
  'executing-plans': { category: '效率', nameZh: '执行计划', descriptionZh: '按计划推进并逐段核验产出。' },
  'test-driven-development': { category: '开发', nameZh: '测试驱动开发', descriptionZh: '先写失败测试，再最小实现，最后重构。' },
  'systematic-debugging': { category: '开发', nameZh: '系统化调试', descriptionZh: '按假设-验证循环定位缺陷，而非乱改碰运气。' },
  'requesting-code-review': { category: '开发', nameZh: '请求代码评审', descriptionZh: '提交评审前自查范围、测试与说明。' },
  // ---- vercel-labs/skills ----
  'find-skills': { category: '效率', nameZh: '技能发现', descriptionZh: '按任务检索并推荐可安装的技能。' },
  // ---- mattpocock/skills ----
  'grill-me': { category: '效率', nameZh: '拷问方案', descriptionZh: '对设计/方案逐条追问直到边界清晰。' },
  tdd: { category: '开发', nameZh: 'TDD 红绿循环', descriptionZh: '红-绿-重构的小步循环写测试与实现。' },
}

const CATEGORY_KEYWORDS: Array<[SkillCategory, RegExp]> = [
  ['文档', /pdf|docx|xlsx|pptx|markdown|docs?|document|changelog|文档|写作/i],
  ['设计', /design|\bart\b|canvas|theme|brand|gif|visual|\bui\b|设计|视觉/i],
  ['开发', /code|api|plugin|mcp|test|debug|refactor|review|git|commit|skill|sdk|build|开发|代码|测试|审查|重构/i],
  ['效率', /task|breakdown|nudge|coauthor|comm|guide|指南|效率|拆解/i],
]

/** 未收录技能的启发式分类：名称+描述关键词匹配，全部落空归「其它」。 */
export function guessSkillCategory(name: string, description: string): SkillCategory {
  const haystack = `${name} ${description}`
  for (const [category, pattern] of CATEGORY_KEYWORDS) {
    if (pattern.test(haystack)) return category
  }
  return '其它'
}

/** 解析条目的中文展示：表内中文 > 原文含中文 > 原文；分类表内优先、回退启发式。 */
export function localizeSkillEntry(entry: SkillMarketEntry): { displayName: string; displayDescription: string; category: SkillCategory } {
  const meta = SKILL_ZH_META[entry.name]
  return {
    displayName: meta?.nameZh ?? entry.name,
    displayDescription: meta?.descriptionZh ?? entry.description,
    category: meta?.category ?? guessSkillCategory(entry.name, entry.description),
  }
}

/** 把各源的分析结果摊平成市场条目：按 name 去重（SKILL_MARKET_SOURCES 顺序即优先级），并标记本机已安装/启用。 */
export function collectSkillMarketEntries(
  analyses: Record<string, SkillRepositoryAnalysis | null>,
  installedSkills: InstalledSkill[],
): SkillMarketEntry[] {
  const installedByName = new Map(installedSkills.map(skill => [skill.name, skill]))
  const seen = new Set<string>()
  const entries: SkillMarketEntry[] = []
  for (const source of SKILL_MARKET_SOURCES) {
    const targets = analyses[source.repository]?.targets ?? []
    for (const target of targets) {
      if (seen.has(target.name)) continue
      seen.add(target.name)
      const installed = installedByName.get(target.name)
      const base: SkillMarketEntry = {
        key: `${source.repository}#${target.id}`,
        name: target.name,
        description: target.description,
        format: target.format,
        source,
        target,
        origin: 'repo',
        installs: null,
        installed: installed !== undefined,
        enabled: installed?.enabled === true,
        displayName: target.name,
        displayDescription: target.description,
        category: '其它',
      }
      entries.push({ ...base, ...localizeSkillEntry(base) })
    }
  }
  return entries
}

/** skills.sh 索引条目转市场条目：保留安装量，target 安装时才由主进程定位。 */
export function collectSkillsShEntries(skills: SkillsShSkill[], installedSkills: InstalledSkill[]): SkillMarketEntry[] {
  const installedByName = new Map(installedSkills.map(skill => [skill.name, skill]))
  const seen = new Set<string>()
  const entries: SkillMarketEntry[] = []
  for (const skill of skills) {
    if (seen.has(skill.id)) continue
    seen.add(skill.id)
    const installed = installedByName.get(skill.name)
    const base: SkillMarketEntry = {
      key: `skills.sh#${skill.id}`,
      name: skill.name,
      description: '',
      format: 'bundle',
      source: {
        repository: skill.source,
        defaultBranch: 'main',
        label: skill.source.split('/')[0] ?? skill.source,
        kind: 'general',
      },
      target: null,
      origin: 'index',
      installs: skill.installs,
      installed: installed !== undefined,
      enabled: installed?.enabled === true,
      displayName: skill.name,
      displayDescription: `来自 ${skill.source}`,
      category: '其它',
    }
    const localized = localizeSkillEntry(base)
    entries.push({
      ...base,
      displayName: localized.displayName,
      displayDescription: localized.displayDescription || base.displayDescription,
      category: localized.category,
    })
  }
  return entries
}

/** 安装量展示：一万以下原样；万以上折算「万」（≥100 万取整），亿级折算「亿」。 */
export function formatInstalls(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 10_000) return String(Math.floor(value))
  if (value < 100_000_000) {
    const wan = value / 10_000
    return `${wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10} 万`
  }
  return `${Math.round(value / 10_000_000) / 10} 亿`
}

/** 搜索（名称+描述，大小写不敏感）、按源类型与内容主题分类筛选。 */
export function filterSkillMarketEntries(
  entries: SkillMarketEntry[],
  query: string,
  sourceKind: 'all' | SkillMarketSourceKind,
  category: 'all' | SkillCategory = 'all',
): SkillMarketEntry[] {
  const text = query.trim().toLowerCase()
  return entries.filter(entry => {
    if (sourceKind !== 'all' && entry.source.kind !== sourceKind) return false
    if (category !== 'all' && entry.category !== category) return false
    if (!text) return true
    return `${entry.name} ${entry.displayName} ${entry.displayDescription}`.toLowerCase().includes(text)
  })
}

/** 安装请求：meta-repo 子模块 target 指向其 sourceRepository 与精确 revision；普通 target 指向源仓库默认分支。 */
export function skillInstallRequestFor(entry: SkillMarketEntry): SkillInstallRequest {
  if (!entry.target) throw new Error('skills.sh 索引条目请走 skillMarketInstallByName。')
  const submodule = entry.target.sourceRepository
  return {
    repository: submodule ?? entry.source.repository,
    defaultBranch: submodule ? entry.target.revision : entry.source.defaultBranch,
    targetId: entry.target.id,
  }
}

/** 可下载版本分组：剔除已安装，按预发布标记拆成稳定/预发布两组（各自保持 registry 顺序）。 */
export function partitionDshVersions(
  candidates: RuntimeVersionCandidate[],
  installedVersions: ReadonlySet<string>,
): { stable: RuntimeVersionCandidate[]; prerelease: RuntimeVersionCandidate[] } {
  const stable: RuntimeVersionCandidate[] = []
  const prerelease: RuntimeVersionCandidate[] = []
  for (const candidate of candidates) {
    if (installedVersions.has(candidate.version)) continue
    if (candidate.prerelease) prerelease.push(candidate)
    else stable.push(candidate)
  }
  return { stable, prerelease }
}