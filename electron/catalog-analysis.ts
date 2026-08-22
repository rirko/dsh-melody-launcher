import type {
  ApplicationRepositoryAnalysis,
  CatalogAnalysisCheck,
  CatalogAnalysisProgress,
  CatalogComponentKind,
  CatalogRepositoryAnalysis,
  RepositoryAnalysis,
  ReleaseAnalysis,
  SkillRepositoryAnalysis,
} from '../src/types'
import { isDshRepository } from './dsh-install'

export interface CatalogAnalysisTasks {
  plugin: () => Promise<RepositoryAnalysis>
  skill: () => Promise<SkillRepositoryAnalysis>
  application: () => Promise<ApplicationRepositoryAnalysis>
}

const CHECK_LABELS: Record<CatalogAnalysisCheck, string> = {
  plugin: 'Plugin',
  skill: 'Skill',
  application: '应用加载项',
}

const KIND_LABELS: Record<CatalogRepositoryAnalysis['kind'], string> = {
  plugin: 'Plugin',
  skill: 'Skill',
  application: '应用加载项',
  preset: 'Agent 预设',
  hybrid: '混合资源',
  dsh: 'DSH 本体',
  invalid: '无效资源',
}

function progressMessage(checks: CatalogAnalysisProgress['checks']): string {
  const running = (Object.keys(checks) as CatalogAnalysisCheck[])
    .filter(check => checks[check] === 'running')
    .map(check => CHECK_LABELS[check])
  const failed = Object.values(checks).filter(state => state === 'failed').length
  const waiting = running.length > 0 ? `正在检查 ${running.join('、')}` : '结构检查已完成'
  return failed > 0 ? `${waiting}；${failed} 项请求失败` : waiting
}

/** 并行运行三个资源检测器，并在每个真实步骤完成时发送不可变快照。 */
export async function analyzeCatalogWithProgress(
  fullName: string,
  defaultBranch: string,
  tasks: CatalogAnalysisTasks,
  onProgress?: (progress: CatalogAnalysisProgress) => void,
): Promise<CatalogRepositoryAnalysis> {
  const checks: CatalogAnalysisProgress['checks'] = {
    plugin: 'pending',
    skill: 'pending',
    application: 'pending',
  }
  const emit = (phase: CatalogAnalysisProgress['phase'], message: string) => {
    onProgress?.({
      repository: fullName,
      phase,
      message,
      completed: Object.values(checks).filter(state => state === 'complete' || state === 'failed').length,
      total: 3,
      checks: { ...checks },
    })
  }

  emit('preparing', '正在准备仓库结构检测')
  if (isDshRepository(fullName)) {
    const result = classifyCatalogRepository(
      fullName,
      defaultBranch,
      { status: 'rejected', reason: new Error('skipped') },
      { status: 'rejected', reason: new Error('skipped') },
      { status: 'rejected', reason: new Error('skipped') },
    )
    emit('complete', `检测完成：${KIND_LABELS[result.kind]}`)
    return result
  }

  for (const check of Object.keys(checks) as CatalogAnalysisCheck[]) checks[check] = 'running'
  emit('checking', progressMessage(checks))

  const track = async <T>(check: CatalogAnalysisCheck, task: () => Promise<T>): Promise<T> => {
    try {
      const result = await task()
      checks[check] = 'complete'
      emit('checking', progressMessage(checks))
      return result
    } catch (error) {
      checks[check] = 'failed'
      emit('checking', progressMessage(checks))
      throw error
    }
  }

  const [pluginResult, skillResult, applicationResult] = await Promise.allSettled([
    track('plugin', tasks.plugin),
    track('skill', tasks.skill),
    track('application', tasks.application),
  ])
  emit('classifying', '正在汇总资源类型和安装入口')

  try {
    const result = classifyCatalogRepository(fullName, defaultBranch, pluginResult, skillResult, applicationResult)
    emit('complete', `检测完成：${KIND_LABELS[result.kind]}`)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit('error', `检测失败：${message}`)
    throw error
  }
}

function failureMessage(label: 'Plugin' | 'Skill' | '应用加载项', reason: unknown): string {
  const prefix = label === '应用加载项' ? label : `${label} `
  return `${prefix}检测失败：${reason instanceof Error ? reason.message : String(reason)}`
}

function excludeReplacementHostedPlugins(
  pluginAnalysis: RepositoryAnalysis | null,
  applicationAnalysis: ApplicationRepositoryAnalysis | null,
): RepositoryAnalysis | null {
  if (!pluginAnalysis || !applicationAnalysis) return pluginAnalysis
  if (!['ready', 'choice'].includes(pluginAnalysis.installability)) return pluginAnalysis
  const replacementPackages = new Set(applicationAnalysis.targets
    .filter(target => target.launchMode === 'runtime-replacement')
    .map(target => target.packageName.toLowerCase()))
  if (replacementPackages.size === 0) return pluginAnalysis
  const targets = pluginAnalysis.targets.filter(target => !replacementPackages.has(target.packageName.toLowerCase()))
  if (targets.length === pluginAnalysis.targets.length) return pluginAnalysis
  if (targets.length === 0) {
    return {
      ...pluginAnalysis,
      installability: 'application',
      summary: '该 Bundle 由同一个替代运行时应用提供，不应单独加入普通 DSH Profile。',
      targets: [],
    }
  }
  return {
    ...pluginAnalysis,
    installability: targets.length === 1 ? 'ready' : 'choice',
    summary: `检测到 ${targets.length} 个独立 Plugin；替代运行时应用自带的同包 Bundle 已从普通安装列表移除。`,
    targets,
  }
}

function hasPluginComponents(analysis: RepositoryAnalysis | null | undefined): boolean {
  return Boolean(analysis && ['ready', 'choice', 'dynamic'].includes(analysis.installability))
}

function hasSkillComponents(analysis: SkillRepositoryAnalysis | null | undefined): boolean {
  return Boolean(analysis && ['ready', 'choice'].includes(analysis.installability))
}

function hasApplicationComponents(analysis: ApplicationRepositoryAnalysis | null | undefined): boolean {
  return Boolean(analysis && ['ready', 'choice', 'unsupported'].includes(analysis.installability))
}

function hasPresetComponents(analysis: CatalogRepositoryAnalysis['presetAnalysis']): boolean {
  return Boolean(analysis && analysis.installability === 'ready')
}

function mergeReleaseAnalyses(
  ...analyses: Array<ReleaseAnalysis | null | undefined>
): ReleaseAnalysis | null {
  const available = analyses.filter((analysis): analysis is ReleaseAnalysis => analysis?.state === 'found' && analysis.assets.length > 0)
  if (available.length === 0) return analyses.find(Boolean) ?? null
  if (available.length === 1) return available[0]
  const assets = [...new Map(
    available.flatMap(analysis => analysis.assets).map(asset => [asset.url, asset]),
  ).values()]
  return {
    state: 'found',
    releaseTag: null,
    releaseName: `${available.length} 个 Release`,
    publishedAt: null,
    assets,
  }
}

function catalogComponentKinds(analysis: Pick<CatalogRepositoryAnalysis,
  'pluginAnalysis' | 'skillAnalysis' | 'applicationAnalysis' | 'presetAnalysis'>,
): CatalogComponentKind[] {
  const componentKinds: CatalogComponentKind[] = []
  if (hasPluginComponents(analysis.pluginAnalysis)) componentKinds.push('plugin')
  if (hasSkillComponents(analysis.skillAnalysis)) componentKinds.push('skill')
  if (hasApplicationComponents(analysis.applicationAnalysis)) componentKinds.push('application')
  if (hasPresetComponents(analysis.presetAnalysis)) componentKinds.push('preset')
  return componentKinds
}

function catalogKind(componentKinds: CatalogComponentKind[]): CatalogRepositoryAnalysis['kind'] {
  return componentKinds.length > 1 ? 'hybrid' : componentKinds[0] ?? 'invalid'
}

/**
 * 聚合仓库既可以有子模块组件，也可以在根目录声明自己的应用加载项。
 * 子模块展开只补充组件，绝不能覆盖根仓库已经验证过的启动入口。
 */
export function mergeMetaRepositoryAnalysis(
  root: CatalogRepositoryAnalysis,
  meta: CatalogRepositoryAnalysis,
): CatalogRepositoryAnalysis {
  // 纯 meta-repo 没有根目录组件时保持原对象，避免把无关的常规检测结果混入子模块结果。
  if (catalogComponentKinds(root).length === 0) return meta

  const pluginAnalysis = hasPluginComponents(meta.pluginAnalysis) ? meta.pluginAnalysis : root.pluginAnalysis
  const skillAnalysis = hasSkillComponents(meta.skillAnalysis) ? meta.skillAnalysis : root.skillAnalysis
  const applicationAnalysis = hasApplicationComponents(root.applicationAnalysis)
    ? root.applicationAnalysis
    : meta.applicationAnalysis
  const presetAnalysis = hasPresetComponents(meta.presetAnalysis) ? meta.presetAnalysis : root.presetAnalysis
  const releaseAnalysis = mergeReleaseAnalyses(
    root.pluginAnalysis?.releaseAnalysis,
    meta.pluginAnalysis?.releaseAnalysis,
  )
  const mergedPluginAnalysis = pluginAnalysis
    ? { ...pluginAnalysis, releaseAnalysis }
    : pluginAnalysis
  const componentKinds = catalogComponentKinds({
    pluginAnalysis: mergedPluginAnalysis,
    skillAnalysis,
    applicationAnalysis,
    presetAnalysis,
  })
  const kind = catalogKind(componentKinds)
  const componentSummary = componentKinds.map(component => {
    if (component === 'plugin') return `${pluginAnalysis?.targets.length ?? 0} 个 Plugin`
    if (component === 'skill') return `${skillAnalysis?.targets.length ?? 0} 个 Skill`
    if (component === 'application') return `${applicationAnalysis?.targets.length ?? 0} 个应用加载项`
    return `${presetAnalysis?.targets.length ?? 0} 个 Agent 预设`
  })

  return {
    ...root,
    kind,
    componentKinds,
    summary: `聚合仓库（meta-repo）：根仓库和子模块共检测到 ${componentSummary.join('、')}。`,
    pluginAnalysis,
    skillAnalysis,
    applicationAnalysis,
    presetAnalysis,
    warnings: [...new Set([...root.warnings, ...meta.warnings])],
  }
}

export function classifyCatalogRepository(
  fullName: string,
  defaultBranch: string,
  pluginResult: PromiseSettledResult<RepositoryAnalysis>,
  skillResult: PromiseSettledResult<SkillRepositoryAnalysis>,
  applicationResult: PromiseSettledResult<ApplicationRepositoryAnalysis>,
): CatalogRepositoryAnalysis {
  if (isDshRepository(fullName)) {
    return {
      repository: fullName,
      defaultBranch,
      kind: 'dsh',
      componentKinds: [],
      summary: '这是 DeepSeek Harness 官方仓库，将作为 DSH 本体安装。',
      pluginAnalysis: null,
      skillAnalysis: null,
      applicationAnalysis: null,
      presetAnalysis: null,
      warnings: [],
    }
  }

  const applicationAnalysis = applicationResult.status === 'fulfilled' ? applicationResult.value : null
  const pluginAnalysis = excludeReplacementHostedPlugins(
    pluginResult.status === 'fulfilled' ? pluginResult.value : null,
    applicationAnalysis,
  )
  const skillAnalysis = skillResult.status === 'fulfilled' ? skillResult.value : null
  const warnings: string[] = []
  if (pluginResult.status === 'rejected') warnings.push(failureMessage('Plugin', pluginResult.reason))
  if (skillResult.status === 'rejected') warnings.push(failureMessage('Skill', skillResult.reason))
  if (applicationResult.status === 'rejected') warnings.push(failureMessage('应用加载项', applicationResult.reason))

  const isPlugin = hasPluginComponents(pluginAnalysis)
  const isSkill = hasSkillComponents(skillAnalysis)
  const isApplication = hasApplicationComponents(applicationAnalysis)

  if (!isPlugin && !isSkill && !isApplication && warnings.length > 0) {
    throw new Error(`仓库类型检测未完成：${warnings.join('；')}`)
  }

  const componentKinds = catalogComponentKinds({ pluginAnalysis, skillAnalysis, applicationAnalysis, presetAnalysis: null })
  const kind = catalogKind(componentKinds)
  const summary = kind === 'hybrid'
    ? `确认包含 ${componentKinds.map(component => component === 'plugin'
      ? `${pluginAnalysis?.targets.length ?? 0} 个 Plugin`
      : component === 'skill'
        ? `${skillAnalysis?.targets.length ?? 0} 个 Skill`
        : `${applicationAnalysis?.targets.length ?? 0} 个应用加载项`).join('、')}。`
    : kind === 'plugin'
      ? pluginAnalysis?.summary ?? '确认是 DSH Plugin。'
      : kind === 'skill'
        ? skillAnalysis?.summary ?? '确认是 DSH Skill。'
        : kind === 'application'
          ? applicationAnalysis?.summary ?? '确认是 DSH 应用加载项。'
          : '没有找到符合 DSH 规范的 Plugin、Skill 或应用加载项。'

  return {
    repository: fullName,
    defaultBranch,
    kind,
    componentKinds,
    summary,
    pluginAnalysis,
    skillAnalysis,
    applicationAnalysis,
    presetAnalysis: null,
    warnings,
  }
}
