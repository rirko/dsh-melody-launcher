import {
  AppWindow,
  BookOpenCheck,
  Bot,
  Box,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Download,
  ExternalLink,
  FolderGit2,
  Layers3,
  Link2,
  LoaderCircle,
  Play,
  RefreshCw,
  ScanSearch,
  Search,
  SquareTerminal,
  Star,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { CatalogPagination } from '../components/CatalogPagination'
import { PageHeading } from '../components/PageHeading'
import { AI_INSTALL_ENABLED, EMPTY_DSH_INSTALLATION } from '../constants'
import { errorText, formatBytes, formatRelativeTime, formatStars } from '../lib/format'
import { readCatalogAnalysisCache, readCatalogIndexCache, writeCatalogAnalysisCache, writeCatalogIndexCache } from '../lib/catalog-cache'
import { analyzeCatalogPageInParallel } from '../lib/catalog-batch'
import { isInstallProgressActive } from '../lib/install-progress'
import type {
  ApplicationInstallResult,
  ApplicationInstallTarget,
  CatalogAnalysisCheck,
  CatalogAnalysisProgress,
  CatalogIndexEntry,
  CatalogIndexTag,
  CatalogRepositoryAnalysis,
  CatalogRepositoryResult,
  DshInstallationStatus,
  InstalledPreset,
  InstalledSkill,
  InstalledApplicationAddon,
  InstallProgress,
  PluginInstallTarget,
  PluginTrialResult,
  PresetInstallResult,
  PresetInstallTarget,
  ProfileState,
  ReleaseAnalysis,
  RepositoryInstallResult,
  SkillInstallResult,
  SkillInstallTarget,
} from '../types'

interface BatchScanState {
  phase: 'running' | 'complete' | 'partial'
  sourcePage: number
  total: number
  completed: number
  available: number
  failed: number
}

interface InstallingState {
  repository: string
  kind: InstallProgress['kind']
}

interface DiscoverViewProps {
  profile: ProfileState
  analyses: Record<string, CatalogRepositoryAnalysis>
  installProgress: InstallProgress | null
  installedRepositories: Set<string>
  installedSkills: InstalledSkill[]
  installedApplications: InstalledApplicationAddon[]
  installedPresets: InstalledPreset[]
  pluginTrials: Record<string, PluginTrialResult>
  onAnalysis: (repository: string, analysis: CatalogRepositoryAnalysis) => void
  onInstallationState: (repositories: string[], skills: InstalledSkill[], applications: InstalledApplicationAddon[], presets: InstalledPreset[]) => void
  onInstallStarted: (progress: InstallProgress) => void
  onInstallFinished: (repository: string, succeeded?: boolean, message?: string) => void
  onPluginInstalled: (repository: string, result: RepositoryInstallResult) => void
  onSkillInstalled: (result: SkillInstallResult) => void
  onApplicationInstalled: (result: ApplicationInstallResult) => void
  onPresetInstalled: (result: PresetInstallResult) => void
  onError: (message: string) => void
  onOpenRepository: (url: string) => void
  /** 启动「AI 尝试」安装（仅非标准形态显示）。 */
  onAiInstall: (repo: CatalogRepositoryResult) => void
  onTrialPlugin: (packageName: string, profileName: string) => void
  onAdaptPlugin: (packageName: string, profileName: string) => void
  /** 正在跑 AI 任务的仓库，用于行内 spinner。 */
  aiRepository: string | null
  aiSubject: string | null
  /** 是否有 AI 任务在跑（全局禁用普通安装与再次触发）。 */
  aiActive: boolean
}

function pluginTargets(analysis: CatalogRepositoryAnalysis | undefined): PluginInstallTarget[] {
  if (!analysis?.pluginAnalysis) return []
  return ['ready', 'choice'].includes(analysis.pluginAnalysis.installability)
    ? analysis.pluginAnalysis.targets
    : []
}

function skillTargets(analysis: CatalogRepositoryAnalysis | undefined): SkillInstallTarget[] {
  if (!analysis?.skillAnalysis) return []
  return ['ready', 'choice'].includes(analysis.skillAnalysis.installability)
    ? analysis.skillAnalysis.targets
    : []
}

function applicationTargets(analysis: CatalogRepositoryAnalysis | undefined): ApplicationInstallTarget[] {
  if (!analysis?.applicationAnalysis) return []
  return ['ready', 'choice', 'unsupported'].includes(analysis.applicationAnalysis.installability)
    ? analysis.applicationAnalysis.targets
    : []
}

function presetTargets(analysis: CatalogRepositoryAnalysis | undefined): PresetInstallTarget[] {
  if (!analysis?.presetAnalysis) return []
  return analysis.presetAnalysis.installability === 'ready'
    ? analysis.presetAnalysis.targets
    : []
}

function analysisBadge(analysis: CatalogRepositoryAnalysis): { className: string; label: string } {
  if (analysis.kind === 'hybrid') {
    const label = analysis.componentKinds.map(kind => {
      if (kind === 'plugin') return 'Plugin'
      if (kind === 'skill') return 'Skill'
      if (kind === 'application') return '应用加载项'
      return 'Agent 预设'
    }).join(' + ')
    return { className: 'hybrid', label }
  }
  if (analysis.kind === 'skill') return { className: 'skill', label: 'Skill' }
  if (analysis.kind === 'application') return { className: 'application', label: '应用加载项' }
  if (analysis.kind === 'preset') return { className: 'preset', label: 'Agent 预设' }
  if (analysis.kind === 'plugin') {
    return analysis.pluginAnalysis?.installability === 'dynamic'
      ? { className: 'dynamic', label: 'Plugin · 动态' }
      : { className: 'plugin', label: 'Plugin' }
  }
  if (analysis.kind === 'dsh') return { className: 'dsh', label: 'DSH 本体' }
  return { className: 'invalid', label: '无效' }
}

function ReleaseExecutableNotice({
  releaseAnalysis,
  onOpenRepository,
}: {
  releaseAnalysis?: ReleaseAnalysis | null
  onOpenRepository: (url: string) => void
}) {
  if (releaseAnalysis?.state !== 'found' || releaseAnalysis.assets.length === 0) return null
  return (
    <span className="analysis-release" role="status">
      <Download size={12} />
      <strong>检测到可安装的可执行程序</strong>
      {releaseAnalysis.releaseTag && <em>{releaseAnalysis.releaseTag}</em>}
      <span className="analysis-release-assets">
        {releaseAnalysis.assets.slice(0, 4).map(asset => (
          <button type="button" key={asset.url} onClick={() => onOpenRepository(asset.url)} title={`${asset.name}${asset.size != null ? ` · ${formatBytes(asset.size)}` : ''}`}>
            {asset.name}
          </button>
        ))}
        {releaseAnalysis.assets.length > 4 && <small>还有 {releaseAnalysis.assets.length - 4} 个</small>}
      </span>
    </span>
  )
}

function catalogIndexBadge(entry: CatalogIndexEntry): { className: string; label: string } {
  if (entry.tags.includes('dsh')) return { className: 'dsh', label: 'DSH 本体' }
  if (entry.tags.includes('invalid')) return { className: 'invalid', label: '无效' }
  const labels = entry.tags.map((tag: CatalogIndexTag) => {
    if (tag === 'plugin') return 'Plugin'
    if (tag === 'skill') return 'Skill'
    if (tag === 'runtime') return '应用加载项'
    if (tag === 'preset') return 'Agent 预设'
    return tag
  })
  if (labels.length > 1) return { className: 'hybrid', label: labels.join(' + ') }
  if (entry.tags[0] === 'skill') return { className: 'skill', label: 'Skill' }
  if (entry.tags[0] === 'runtime') return { className: 'application', label: '应用加载项' }
  if (entry.tags[0] === 'preset') return { className: 'preset', label: 'Agent 预设' }
  return { className: 'plugin', label: 'Plugin' }
}

function catalogIndexEntryFromAnalysis(
  repository: string,
  defaultBranch: string,
  repositoryUpdatedAt: string | undefined,
  analysis: CatalogRepositoryAnalysis,
): CatalogIndexEntry {
  const tags: CatalogIndexTag[] = analysis.kind === 'dsh'
    ? ['dsh']
    : analysis.kind === 'invalid'
      ? ['invalid']
      : analysis.componentKinds.map(kind => kind === 'application' ? 'runtime' : kind)
  return { repository, defaultBranch, repositoryUpdatedAt: repositoryUpdatedAt ?? null, tags }
}

const ANALYSIS_CHECK_LABELS: Record<CatalogAnalysisCheck, string> = {
  plugin: 'Plugin',
  skill: 'Skill',
  application: '应用加载项',
}

function CatalogAnalysisSteps({ progress }: { progress?: CatalogAnalysisProgress }) {
  const current = progress ?? {
    repository: '',
    phase: 'preparing' as const,
    message: '正在准备仓库结构检测',
    completed: 0,
    total: 3 as const,
    checks: { plugin: 'pending' as const, skill: 'pending' as const, application: 'pending' as const },
  }
  const statusIcon = current.phase === 'complete'
    ? <CircleCheck size={13} />
    : current.phase === 'error'
      ? <CircleAlert size={13} />
      : <LoaderCircle className="spin" size={13} />

  return (
    <div className={`catalog-analysis-progress ${current.phase}`} role="status" aria-live="polite">
      <div className="catalog-analysis-progress-head">
        {statusIcon}
        <span>{current.message}</span>
        <strong>{current.completed}/{current.total}</strong>
      </div>
      <div className="catalog-analysis-checks">
        {(Object.keys(current.checks) as CatalogAnalysisCheck[]).map(check => {
          const state = current.checks[check]
          return <span className={state} key={check}>
            {state === 'running'
              ? <LoaderCircle className="spin" size={11} />
              : state === 'complete'
                ? <CircleCheck size={11} />
                : state === 'failed'
                  ? <CircleAlert size={11} />
                  : <Clock3 size={11} />}
            {ANALYSIS_CHECK_LABELS[check]}
          </span>
        })}
      </div>
    </div>
  )
}

export function DiscoverView({
  profile,
  analyses,
  installProgress,
  installedRepositories,
  installedSkills,
  installedApplications,
  installedPresets,
  pluginTrials,
  onAnalysis,
  onInstallationState,
  onInstallStarted,
  onInstallFinished,
  onPluginInstalled,
  onSkillInstalled,
  onApplicationInstalled,
  onPresetInstalled,
  onError,
  onOpenRepository,
  onAiInstall,
  onTrialPlugin,
  onAdaptPlugin,
  aiRepository,
  aiSubject,
  aiActive,
}: DiscoverViewProps) {
  const api = useLauncherApi()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'stars' | 'updated'>('stars')
  const [repositories, setRepositories] = useState<CatalogRepositoryResult[]>([])
  const [topicTotals, setTopicTotals] = useState({ plugin: 0, skill: 0, application: 0 })
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [warnings, setWarnings] = useState<string[]>([])
  const [catalogIndex, setCatalogIndex] = useState<CatalogIndexEntry[]>(() => readCatalogIndexCache())
  const [refreshingIndex, setRefreshingIndex] = useState(false)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<InstallingState | null>(null)
  const [checkingRepositories, setCheckingRepositories] = useState<Set<string>>(() => new Set())
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, CatalogAnalysisProgress>>({})
  const [batchScan, setBatchScan] = useState<BatchScanState | null>(null)
  const [dshInstallation, setDshInstallation] = useState<DshInstallationStatus>(EMPTY_DSH_INSTALLATION)
  const [starredRepositories, setStarredRepositories] = useState<Record<string, boolean>>({})
  const [starringRepository, setStarringRepository] = useState<string | null>(null)
  const [targetDialog, setTargetDialog] = useState<{
    repo: CatalogRepositoryResult
    analysis: CatalogRepositoryAnalysis
  } | null>(null)

  const toggleStar = async (repository: CatalogRepositoryResult) => {
    if (starringRepository) return
    setStarringRepository(repository.fullName)
    try {
      const key = repository.fullName.toLowerCase()
      const current = starredRepositories[key] ?? await api.getGitHubStarStatus(repository.fullName)
      const next = await api.setGitHubStar(repository.fullName, !current)
      setStarredRepositories(previous => ({ ...previous, [key]: next }))
      setRepositories(previous => previous.map(item => item.fullName.toLowerCase() === key
        ? { ...item, stars: Math.max(0, item.stars + (next ? 1 : -1)) }
        : item))
    } catch (error) {
      onError(errorText(error))
    } finally {
      setStarringRepository(null)
    }
  }
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  /** 「一键安装全部」整轮进行中（覆盖组件间切换的 busy 空档）。 */
  const [installingAll, setInstallingAll] = useState(false)
  const batchRunRef = useRef(0)

  const search = useCallback(async (searchQuery = query, searchSort = sort, searchPage = page) => {
    // 翻页和重新搜索只替换当前可见仓库，不能取消后台检测。
    // 检测状态按仓库名持有；返回原页时会继续显示进度或最终结果。
    setTargetDialog(null)
    setLoading(true)
    try {
      const result = await api.discoverCatalog(searchQuery, searchSort, searchPage)
      setRepositories(result.repositories)
      setTopicTotals(result.topicTotals)
      setPage(result.page)
      setPageCount(result.pageCount)
      setWarnings(result.warnings)
      setDshInstallation(result.dshInstallation)
      onInstallationState(result.installedRepositories, result.installedSkills, result.installedApplications, result.installedPresets)
      for (const repo of result.repositories) {
        const cached = readCatalogAnalysisCache(repo.fullName, repo.defaultBranch)
        if (cached) onAnalysis(repo.fullName, cached)
      }
    } catch (error) {
      onError(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [api, onAnalysis, onError, onInstallationState, page, query, sort])

  useEffect(() => { void search('', 'stars', 1) }, [])
  useEffect(() => () => { batchRunRef.current += 1 }, [])
  useEffect(() => api.onCatalogAnalysisProgress(progress => {
    setAnalysisProgress(current => ({ ...current, [progress.repository]: progress }))
  }), [api])

  const installedRepos = useMemo(() => {
    const result = new Set(installedRepositories)
    for (const plugin of profile.plugins) {
      if (plugin.repositoryFullName) result.add(plugin.repositoryFullName.toLowerCase())
    }
    return result
  }, [installedRepositories, profile.plugins])
  const installedSkillNames = useMemo(
    () => new Set(installedSkills.map(skill => skill.name)),
    [installedSkills],
  )
  const installedApplicationRepositories = useMemo(
    () => new Set(installedApplications.map(application => application.repository.toLowerCase())),
    [installedApplications],
  )
  const installedPresetNames = useMemo(
    () => new Set(installedPresets.map(preset => preset.name)),
    [installedPresets],
  )
  const batchRunning = batchScan?.phase === 'running'
  const checkingCount = checkingRepositories.size
  const hasActiveChecks = checkingCount > 0
  const restoredInstalling: InstallingState | null = isInstallProgressActive(installProgress)
    ? { repository: installProgress.repository, kind: installProgress.kind }
    : null
  const activeInstalling = installing ?? restoredInstalling
  const resetAnalysisProgress = (repository: string) => setAnalysisProgress(current => {
    const next = { ...current }
    delete next[repository]
    return next
  })
  const setRepositoryChecking = (repository: string, active: boolean) => {
    setCheckingRepositories(current => {
      const next = new Set(current)
      if (active) next.add(repository)
      else next.delete(repository)
      return next
    })
  }

  const inspect = async (repo: CatalogRepositoryResult) => {
    if (repo.kind === 'dsh') return
    const cached = readCatalogAnalysisCache(repo.fullName, repo.defaultBranch)
    resetAnalysisProgress(repo.fullName)
    setRepositoryChecking(repo.fullName, true)
    try {
      const analysis = await api.analyzeCatalogRepository(repo.fullName, repo.defaultBranch, repo.updatedAt)
      writeCatalogAnalysisCache(repo.fullName, repo.defaultBranch, analysis)
      adoptCatalogIndexEntry(repo, analysis)
      onAnalysis(repo.fullName, analysis)
      if (analysis.kind === 'hybrid'
        || pluginTargets(analysis).length + skillTargets(analysis).length + applicationTargets(analysis).length + presetTargets(analysis).length > 1) {
        setTargetDialog({ repo, analysis })
      }
    } catch (error) {
      if (cached) {
        onAnalysis(repo.fullName, cached)
        onError(`GitHub 共享目录和在线检测暂时不可用，已保留本地缓存：${errorText(error)}`)
      } else {
        onError(errorText(error))
      }
    } finally {
      setRepositoryChecking(repo.fullName, false)
    }
  }

  const inspectAll = async () => {
    const candidates = repositories.filter(repo => repo.kind !== 'dsh')
    if (candidates.length === 0 || batchRunning) return

    const runId = batchRunRef.current + 1
    batchRunRef.current = runId
    let completed = 0
    let available = 0
    let failed = 0
    setTargetDialog(null)
    setAnalysisProgress(current => {
      const next = { ...current }
      for (const repo of candidates) delete next[repo.fullName]
      return next
    })
    setCheckingRepositories(new Set(candidates.map(repo => repo.fullName)))
    const sourcePage = page
    setBatchScan({ phase: 'running', sourcePage, total: candidates.length, completed, available, failed })

    await analyzeCatalogPageInParallel(
      candidates,
      async repo => {
        try {
          return await api.analyzeCatalogRepository(repo.fullName, repo.defaultBranch, repo.updatedAt)
        } catch (error) {
          const cached = readCatalogAnalysisCache(repo.fullName, repo.defaultBranch)
          if (!cached) throw error
          return {
            ...cached,
            sync: {
              source: 'local',
              state: 'unavailable',
              message: 'GitHub 共享目录和在线检测不可用，已使用本地缓存。',
            },
          }
        }
      },
      (outcome, settledCount) => {
        if (batchRunRef.current !== runId) return
        completed = settledCount
        if (outcome.status === 'fulfilled') {
          const analysis = outcome.analysis
          writeCatalogAnalysisCache(outcome.repository.fullName, outcome.repository.defaultBranch, analysis)
          adoptCatalogIndexEntry(outcome.repository, analysis)
          onAnalysis(outcome.repository.fullName, analysis)
          if (analysis.kind !== 'invalid') available += 1
        } else {
          failed += 1
        }
        setRepositoryChecking(outcome.repository.fullName, false)
        setBatchScan({ phase: 'running', sourcePage, total: candidates.length, completed, available, failed })
      },
    )
    if (batchRunRef.current !== runId) return
    setCheckingRepositories(current => {
      const next = new Set(current)
      for (const repo of candidates) next.delete(repo.fullName)
      return next
    })
    setBatchScan({
      phase: failed > 0 ? 'partial' : 'complete',
      sourcePage,
      total: candidates.length,
      completed,
      available,
      failed,
    })
  }

  const refreshCatalogIndex = async () => {
    if (refreshingIndex) return
    setRefreshingIndex(true)
    try {
      const entries = await api.refreshCatalogIndex()
      writeCatalogIndexCache(entries)
      setCatalogIndex(entries)
    } catch (error) {
      onError(errorText(error))
    } finally {
      setRefreshingIndex(false)
    }
  }

  const adoptCatalogIndexEntry = (repo: CatalogRepositoryResult, analysis: CatalogRepositoryAnalysis) => {
    const entry = catalogIndexEntryFromAnalysis(repo.fullName, repo.defaultBranch, repo.updatedAt, analysis)
    setCatalogIndex(current => {
      const next = [...current.filter(item => item.repository.toLowerCase() !== repo.fullName.toLowerCase()), entry]
      writeCatalogIndexCache(next)
      return next
    })
  }

  const importFromUrl = async (url: string) => {
    setImportOpen(false)
    setImporting(true)
    try {
      const { repository, analysis } = await api.importCatalogUrl(url)
      if (analysis.warnings.length === 0) {
        writeCatalogAnalysisCache(repository.fullName, repository.defaultBranch, analysis)
      }
      adoptCatalogIndexEntry(repository, analysis)
      onAnalysis(repository.fullName, analysis)
      // 去重（忽略大小写）并移到列表顶部，与搜索结果同生命周期。
      setRepositories(current => {
        const without = current.filter(repo => repo.fullName.toLowerCase() !== repository.fullName.toLowerCase())
        return [repository, ...without]
      })
      if (analysis.kind === 'hybrid'
        || pluginTargets(analysis).length + skillTargets(analysis).length + applicationTargets(analysis).length + presetTargets(analysis).length > 1) {
        setTargetDialog({ repo: repository, analysis })
      }
    } catch (error) {
      onError(errorText(error))
    } finally {
      setImporting(false)
    }
  }

  const installPlugin = async (repo: CatalogRepositoryResult, target?: PluginInstallTarget, keepDialog = false) => {
    const kind = repo.kind === 'dsh' ? 'dsh' : 'plugin'
    // meta-repo 子模块目标指向子模块自身仓库与精确 commit；普通仓库仍是父仓库 + 默认分支。
    const sourceRepository = target?.sourceRepository
    setInstalling({ repository: repo.fullName, kind })
    if (!keepDialog) setTargetDialog(null)
    onInstallStarted({
      repository: repo.fullName,
      kind,
      phase: 'preparing',
      percent: 0,
      message: kind === 'dsh' ? '正在准备本地 DSH' : '正在检查 Plugin 组件',
    })
    let succeeded = false
    let failureMessage = '插件安装失败。'
    try {
      const result = await api.installPlugin(repo.kind === 'dsh'
        ? repo.fullName
        : {
            repository: sourceRepository ?? repo.fullName,
            defaultBranch: sourceRepository && target ? target.commit : repo.defaultBranch,
            targetId: target?.id ?? '',
          })
      setDshInstallation(result.dshInstallation)
      onPluginInstalled(repo.fullName, result)
      succeeded = true
    } catch (error) {
      failureMessage = errorText(error)
      onError(failureMessage)
    } finally {
      setInstalling(null)
      onInstallFinished(repo.fullName, succeeded, failureMessage)
    }
    return succeeded
  }

  const installSkill = async (repo: CatalogRepositoryResult, target: SkillInstallTarget, keepDialog = false) => {
    setInstalling({ repository: repo.fullName, kind: 'skill' })
    if (!keepDialog) setTargetDialog(null)
    onInstallStarted({
      repository: repo.fullName,
      kind: 'skill',
      phase: 'preparing',
      percent: 0,
      message: '正在准备本地 Skill 目录',
    })
    let succeeded = false
    let failureMessage = 'Skill 安装失败。'
    try {
      const result = await api.installSkill({
        repository: target.sourceRepository ?? repo.fullName,
        defaultBranch: target.sourceRepository ? target.revision : repo.defaultBranch,
        targetId: target.id,
      })
      onSkillInstalled(result)
      succeeded = true
    } catch (error) {
      failureMessage = errorText(error)
      onError(failureMessage)
    } finally {
      setInstalling(null)
      onInstallFinished(repo.fullName, succeeded, failureMessage)
    }
    return succeeded
  }

  const installApplication = async (repo: CatalogRepositoryResult, target: ApplicationInstallTarget) => {
    setInstalling({ repository: repo.fullName, kind: 'application' })
    setTargetDialog(null)
    onInstallStarted({
      repository: repo.fullName,
      kind: 'application',
      phase: 'preparing',
      percent: 0,
      message: '正在准备应用加载项运行目录',
    })
    let succeeded = false
    let failureMessage = '应用加载项安装失败。'
    try {
      const result = await api.installApplication({
        repository: repo.fullName,
        defaultBranch: repo.defaultBranch,
        targetId: target.id,
      })
      onApplicationInstalled(result)
      succeeded = true
    } catch (error) {
      failureMessage = errorText(error)
      onError(failureMessage)
    } finally {
      setInstalling(null)
      onInstallFinished(repo.fullName, succeeded, failureMessage)
    }
    return succeeded
  }

  const installPreset = async (repo: CatalogRepositoryResult, target: PresetInstallTarget, keepDialog = false) => {
    setInstalling({ repository: repo.fullName, kind: 'preset' })
    if (!keepDialog) setTargetDialog(null)
    onInstallStarted({
      repository: repo.fullName,
      kind: 'preset',
      phase: 'preparing',
      percent: 0,
      message: '正在准备 Agent 预设目录',
    })
    let succeeded = false
    let failureMessage = 'Agent 预设安装失败。'
    try {
      // 预设来自 meta-repo 子模块，revision 已钉死，直接指向子模块仓库安装。
      const result = await api.installPreset({
        repository: target.sourceRepository,
        targetId: target.id,
        name: target.name,
        sourcePath: target.sourcePath,
        revision: target.revision,
      })
      onPresetInstalled(result)
      succeeded = true
    } catch (error) {
      failureMessage = errorText(error)
      onError(failureMessage)
    } finally {
      setInstalling(null)
      onInstallFinished(repo.fullName, succeeded, failureMessage)
    }
    return succeeded
  }

  /** 「一键安装全部」：按顺序装完未安装的组件，对话框保持打开、逐个刷新状态。
   *  用本地 Set 记录本轮已装组件，避免闭包里的 installedRepos / profile 陈旧。 */
  const installAll = async (repo: CatalogRepositoryResult, analysis: CatalogRepositoryAnalysis) => {
    setInstallingAll(true)
    try {
      const installedPlugins = new Set(profile.plugins.map(plugin => plugin.packageName.toLowerCase()))
      const installedSkillSet = new Set(installedSkills.map(skill => skill.name.toLowerCase()))
      const installedPresetSet = new Set(installedPresets.map(preset => preset.name.toLowerCase()))
      for (const target of pluginTargets(analysis)) {
        if (installedPlugins.has(target.packageName.toLowerCase())) continue
        if (await installPlugin(repo, target, true)) installedPlugins.add(target.packageName.toLowerCase())
      }
      for (const target of skillTargets(analysis)) {
        if (installedSkillSet.has(target.name.toLowerCase())) continue
        if (await installSkill(repo, target, true)) installedSkillSet.add(target.name.toLowerCase())
      }
      for (const target of presetTargets(analysis)) {
        if (installedPresetSet.has(target.name.toLowerCase())) continue
        if (await installPreset(repo, target, true)) installedPresetSet.add(target.name.toLowerCase())
      }
    } finally {
      setInstallingAll(false)
    }
  }

  return (
    <div className="page discover-page catalog-page">
      <PageHeading
        eyebrow="DSH MARKET"
        title="DSH 资源市场"
        description={`统一浏览 GitHub 中 ${topicTotals.plugin.toLocaleString('zh-CN')} 个 Plugin 和 ${topicTotals.application.toLocaleString('zh-CN')} 个应用候选；安装前仍会按仓库内容识别其中的 Skill。`}
      />

      <div className="discovery-controls">
        <form className="search-field large" onSubmit={event => { event.preventDefault(); void search(query, sort, 1) }}>
          <Search size={18} />
          <input
            value={query}
            disabled={loading}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索名称、作者或说明"
            aria-label="搜索 DSH 资源"
          />
          {query && <button type="button" disabled={loading} onClick={() => { setQuery(''); void search('', sort, 1) }} aria-label="清除搜索"><X size={16} /></button>}
          <button type="submit" className="search-submit" disabled={loading}>搜索</button>
        </form>
        <div className="discovery-actions">
          <div className="segmented-control" aria-label="资源排序方式">
            <button type="button" disabled={loading} className={sort === 'stars' ? 'active' : ''} onClick={() => { setSort('stars'); void search(query, 'stars', 1) }}><Star size={15} />热门</button>
            <button type="button" disabled={loading} className={sort === 'updated' ? 'active' : ''} onClick={() => { setSort('updated'); void search(query, 'updated', 1) }}><Clock3 size={15} />最近更新</button>
          </div>
          <button
            type="button"
            className="secondary-button catalog-scan-button"
            disabled={loading || batchRunning || hasActiveChecks || activeInstalling !== null || repositories.every(repo => repo.kind === 'dsh')}
            onClick={() => void inspectAll()}
            title="并行检测当前页中的全部 Plugin、Skill、应用加载项与 Agent 预设候选"
          >
            {batchRunning ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}
            {batchRunning
              ? `${batchScan.sourcePage === page ? '检测' : `后台检测第 ${batchScan.sourcePage} 页`} ${batchScan.completed}/${batchScan.total}`
              : batchScan?.sourcePage === page ? '再次检测当前页' : '检测当前页'}
          </button>
          <button
            type="button"
            className="secondary-button catalog-scan-button"
            disabled={loading || importing || refreshingIndex}
            onClick={() => setImportOpen(true)}
            title="从 GitHub 链接导入仓库，加入市场并复用检测 / 安装流程"
          >
            {importing ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />}
            从链接导入
          </button>
          <button
            type="button"
            className="secondary-button catalog-scan-button"
            disabled={loading || importing || refreshingIndex || batchRunning || hasActiveChecks}
            onClick={() => void refreshCatalogIndex()}
            title="从 GitHub 下载最新共享 index.xml，并更新本地资源标签"
          >
            {refreshingIndex ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            {refreshingIndex ? '更新中' : '更新标签'}
          </button>
        </div>
      </div>

      {batchScan && (
        <div className={`batch-scan-status ${batchScan.phase}`} role="status" aria-live="polite">
          {batchRunning ? <LoaderCircle className="spin" size={15} /> : batchScan.phase === 'complete' ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
          <span>{batchRunning
            ? `正在${batchScan.sourcePage === page ? '并行检测当前页' : `后台检测第 ${batchScan.sourcePage} 页`}：${batchScan.total - batchScan.completed} 个仓库进行中，已完成 ${batchScan.completed}/${batchScan.total}；返回该页可查看各仓库详细步骤`
            : batchScan.phase === 'complete'
              ? `检测完成：${batchScan.total} 个候选中有 ${batchScan.available} 个 DSH 资源${batchScan.failed ? `，${batchScan.failed} 个检测失败` : ''}`
              : `并行检测结束：完成 ${batchScan.completed}/${batchScan.total}，发现 ${batchScan.available} 个资源，${batchScan.failed} 个检测失败`}</span>
          <div className="batch-scan-track" aria-hidden="true"><i style={{ width: `${Math.round(batchScan.completed / batchScan.total * 100)}%` }} /></div>
        </div>
      )}

      <div className="catalog-note"><CircleAlert size={16} /><span>Topic 只表示仓库自我声明；“检测”会同时验证 Cordis Bundle、<code>SKILL.md</code> 与 <code>.dsh-launcher/addon.json</code>，再决定安装方式。每个 topic 受 GitHub 前 1,000 条结果限制。</span></div>
      {warnings.map(warning => <div className="catalog-note catalog-warning" key={warning}><CircleAlert size={16} /><span>{warning}</span></div>)}
      <CatalogPagination
        page={page}
        pageCount={pageCount}
        visibleCount={repositories.length}
        loading={loading}
        disabled={loading}
        onPageChange={nextPage => void search(query, sort, nextPage)}
      />

      <section className="repository-list" aria-busy={loading}>
        <div className="repository-headings" aria-hidden="true"><span>仓库</span><span>语言</span><span>活跃度</span><span /></div>
        {loading ? (
          <div className="list-loading"><LoaderCircle className="spin" size={21} />正在读取 GitHub 资源目录</div>
        ) : repositories.length === 0 ? (
          <div className="list-loading"><Search size={21} />没有找到匹配的仓库</div>
        ) : repositories.map(repo => {
          const analysis = analyses[repo.fullName]
          const remoteIndexEntry = catalogIndex.find(entry => entry.repository.toLowerCase() === repo.fullName.toLowerCase())
          const plugins = pluginTargets(analysis)
          const skills = skillTargets(analysis)
          const applications = applicationTargets(analysis)
          const presets = presetTargets(analysis)
          const totalTargets = plugins.length + skills.length + applications.length + presets.length
          const pluginSourceRepos = plugins
            .map(target => target.sourceRepository)
            .filter((value): value is string => Boolean(value))
          const pluginInstalled = pluginSourceRepos.length > 0
            ? pluginSourceRepos.every(repository => installedRepos.has(repository.toLowerCase()))
            : installedRepos.has(repo.fullName.toLowerCase())
          const installedSkillCount = skills.filter(target => installedSkillNames.has(target.name)).length
          const applicationInstalled = installedApplicationRepositories.has(repo.fullName.toLowerCase())
          const installedPresetCount = presets.filter(target => installedPresetNames.has(target.name)).length
          const anyInstalled = repo.kind === 'dsh'
            ? dshInstallation.installed
            : pluginInstalled || installedSkillCount > 0 || applicationInstalled || installedPresetCount > 0
          const progress = isInstallProgressActive(installProgress)
            && installProgress.repository === repo.fullName
            && activeInstalling?.repository === repo.fullName
            && installProgress.kind === activeInstalling.kind
            ? installProgress
            : null
          const installFailure = installProgress?.repository === repo.fullName && installProgress.phase === 'error'
            ? installProgress
            : null
          const indeterminate = progress?.indeterminate === true && progress.phase !== 'error'
          const isChecking = checkingRepositories.has(repo.fullName)
          const needsDialog = analysis?.kind === 'hybrid' || totalTargets > 1
          const singlePlugin = plugins.length === 1 && skills.length === 0 && applications.length === 0 && presets.length === 0 ? plugins[0] : undefined
          const singleSkill = skills.length === 1 && plugins.length === 0 && applications.length === 0 && presets.length === 0 ? skills[0] : undefined
          const singleApplication = applications.length === 1 && plugins.length === 0 && skills.length === 0 && presets.length === 0 ? applications[0] : undefined
          const singlePreset = presets.length === 1 && plugins.length === 0 && skills.length === 0 && applications.length === 0 ? presets[0] : undefined
          const trialTarget = plugins.length === 1 && anyInstalled ? plugins[0] : undefined
          const trial = trialTarget ? pluginTrials[`${trialTarget.profileName}:${trialTarget.packageName}`] : undefined
          const actionLabel = repo.kind === 'dsh'
            ? dshInstallation.installed ? '更新 DSH' : '安装 DSH'
            : !analysis
              ? anyInstalled ? '检测更新' : '检测'
              : analysis.kind === 'invalid'
                ? '无效资源'
                : totalTargets === 0
                  ? '暂不支持安装'
                  : singleApplication && !singleApplication.supported
                    ? '平台不支持'
                  : needsDialog
                    ? '选择组件'
                    : anyInstalled ? '更新' : '安装'
          const actionDisabled = isChecking
            || (Boolean(analysis) && (
              activeInstalling !== null
              || aiActive
              || analysis.kind === 'invalid'
              || totalTargets === 0
              || Boolean(singleApplication && !singleApplication.supported)
            ))
          // 非标准形态（plugin 的 dynamic/application/invalid，或整体 invalid）——普通安装装不了，转「AI 尝试」。
          const aiTryable = AI_INSTALL_ENABLED
            && !!analysis
            && (analysis.kind === 'invalid'
              || (analysis.kind === 'plugin'
                && analysis.pluginAnalysis?.installability != null
                && !['ready', 'choice'].includes(analysis.pluginAnalysis.installability)))
          const runAction = () => {
            if (repo.kind === 'dsh') return void installPlugin(repo)
            if (!analysis) return void inspect(repo)
            if (needsDialog) return setTargetDialog({ repo, analysis })
            if (singlePlugin) return void installPlugin(repo, singlePlugin)
            if (singleSkill) return void installSkill(repo, singleSkill)
            if (singleApplication) void installApplication(repo, singleApplication)
            if (singlePreset) void installPreset(repo, singlePreset)
          }
          const badge = remoteIndexEntry ? catalogIndexBadge(remoteIndexEntry) : analysis ? analysisBadge(analysis) : null
          const iconKind = analysis?.kind === 'skill'
            ? 'skill'
            : analysis?.kind === 'application'
              ? 'application'
            : analysis?.kind === 'preset'
              ? 'preset'
              : analysis?.kind === 'hybrid'
                ? 'hybrid'
                : repo.kind === 'dsh' ? 'dsh' : 'plugin'
          const installedLabel = repo.kind === 'dsh'
            ? `${dshInstallation.source === 'system' ? '系统 DSH' : '本地 DSH'} ${dshInstallation.version ?? ''}`
            : analysis?.kind === 'hybrid'
              ? `${pluginInstalled ? 'Plugin 已安装' : 'Plugin 未安装'} · Skills ${installedSkillCount}/${skills.length} · ${applicationInstalled ? '应用已安装' : '应用未安装'} · 预设 ${installedPresetCount}/${presets.length}`
              : analysis?.kind === 'application'
                ? applicationInstalled ? '应用加载项已安装' : '应用加载项未安装'
              : analysis?.kind === 'preset'
                ? `预设 ${installedPresetCount}/${presets.length} 已安装`
                : pluginInstalled
                  ? 'Plugin 已安装'
                  : skills.length > 0 ? `Skills ${installedSkillCount}/${skills.length} 已安装` : '已安装'

          return (
            <article className={`repository-row ${repo.kind === 'dsh' ? 'dsh-core-row' : ''}`} key={repo.id}>
              <div className="repo-main">
                <div className={`repo-icon ${iconKind === 'dsh' ? 'dsh-core-icon' : iconKind === 'skill' ? 'skill-icon' : iconKind === 'application' ? 'application-icon' : iconKind === 'preset' ? 'preset-icon' : iconKind === 'hybrid' ? 'hybrid-icon' : ''}`}>
                  {iconKind === 'dsh' ? <Layers3 size={18} /> : iconKind === 'skill' ? <BookOpenCheck size={18} /> : iconKind === 'application' ? <AppWindow size={18} /> : iconKind === 'preset' ? <Bot size={18} /> : iconKind === 'hybrid' ? <Layers3 size={18} /> : <FolderGit2 size={18} />}
                </div>
                <div>
                  <div className="repo-title-line">
                    <button type="button" className="repo-title" onClick={() => onOpenRepository(repo.url)}><span>{repo.owner}/</span><strong>{repo.name}</strong><ExternalLink size={13} /></button>
                    {repo.kind === 'dsh'
                      ? <span className="dsh-core-badge">DSH 本体</span>
                      : badge
                        ? <span className={`repository-analysis-badge ${badge.className}`}>{badge.label}</span>
                        : <span className="repository-analysis-badge pending">待检测</span>}
                    {repo.featured && <span className="featured-badge">内置</span>}
                  </div>
                  <p>{repo.description}</p>
                  {isChecking && <CatalogAnalysisSteps progress={analysisProgress[repo.fullName]} />}
                  {analysis && <div className={`repository-analysis-note ${analysis.kind}`}>
                    {analysis.summary}
                    <ReleaseExecutableNotice
                      releaseAnalysis={analysis.pluginAnalysis?.releaseAnalysis}
                      onOpenRepository={onOpenRepository}
                    />
                    {analysis.warnings.map(warning => <span className="analysis-warning" key={warning}>{warning}</span>)}
                    {analysis.sync && (
                      <span className={`analysis-sync ${analysis.sync.state}`}>
                        {analysis.sync.message}
                        {analysis.sync.pullRequestUrl && (
                          <button type="button" onClick={() => onOpenRepository(analysis.sync!.pullRequestUrl!)}>查看 PR</button>
                        )}
                      </span>
                    )}
                  </div>}
                  {installFailure && (
                    <div className="catalog-install-error" role="alert" title={installFailure.message}>
                      <CircleAlert size={13} />
                      <span>{installFailure.message}</span>
                    </div>
                  )}
                  <div className="topic-list">
                    {repo.candidateTypes.map(type => <span className="candidate-topic" key={type}>{type === 'plugin' ? 'dsh-plugin 候选' : type === 'skill' ? 'dsh-skill 候选' : 'dsh-app 候选'}</span>)}
                    {repo.topics.filter(topic => !['dsh-plugin', 'dsh-skill', 'dsh-app'].includes(topic.toLowerCase())).slice(0, 2).map(topic => <span key={topic}>{topic}</span>)}
                  </div>
                </div>
              </div>
              <div className="language-cell"><i className={`language-dot lang-${(repo.language ?? 'other').toLowerCase()}`} />{repo.language ?? '其他'}</div>
              <div className="activity-cell">
                <button
                  type="button"
                  className={`repo-star-button ${starredRepositories[repo.fullName.toLowerCase()] ? 'starred' : ''}`}
                  disabled={starringRepository === repo.fullName}
                  title={starredRepositories[repo.fullName.toLowerCase()] ? '取消 GitHub 星标' : '添加 GitHub 星标'}
                  aria-label={starredRepositories[repo.fullName.toLowerCase()] ? `取消 ${repo.fullName} 的 GitHub 星标` : `给 ${repo.fullName} 添加 GitHub 星标`}
                  onClick={() => void toggleStar(repo)}
                >
                  {starringRepository === repo.fullName ? <LoaderCircle className="spin" size={15} /> : <Star size={15} fill={starredRepositories[repo.fullName.toLowerCase()] ? 'currentColor' : 'none'} />}
                  {formatStars(repo.stars)}
                </button>
                <small>更新于 {formatRelativeTime(repo.updatedAt)}</small>
                {repo.sizeKb != null && repo.sizeKb > 0 && <small>仓库大小 {formatBytes(repo.sizeKb * 1024)}</small>}
              </div>
              <div className="install-cell">
                {progress ? (
                  <div className={`install-progress ${progress.phase === 'error' ? 'error' : ''} ${indeterminate ? 'indeterminate' : ''}`}>
                    <div>{progress.phase === 'error' ? <CircleAlert size={14} /> : <LoaderCircle className="spin" size={14} />}<span>{progress.message}</span><strong>{progress.phase === 'error' ? '失败' : indeterminate ? '进行中' : `${progress.percent}%`}</strong></div>
                    {progress.downloadedBytes != null && (
                      <small className="install-progress-size">
                        已下载 {formatBytes(progress.downloadedBytes)}
                        {progress.totalBytes != null && ` / ${formatBytes(progress.totalBytes)}`}
                      </small>
                    )}
                    <div className="progress-track" role="progressbar" aria-label={progress.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : progress.percent} aria-valuetext={indeterminate ? '正在进行' : undefined}><span style={indeterminate ? undefined : { width: `${progress.percent}%` }} /></div>
                  </div>
                ) : anyInstalled ? (
                  <div className="installed-actions">
                    <span className="installed-label"><Check size={16} />{installedLabel}</span>
                    <div className="installed-command-row">
                      {trialTarget && (
                        <PluginTrialActions
                          target={trialTarget}
                          result={trial}
                          disabled={actionDisabled}
                          adapting={aiActive && aiSubject === trialTarget.packageName}
                          onTrial={onTrialPlugin}
                          onAdapt={onAdaptPlugin}
                        />
                      )}
                      <button type="button" className="install-button update-button" disabled={actionDisabled || trial?.phase === 'running'} onClick={runAction} title={`管理 ${repo.name}`}>
                        {isChecking ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{actionLabel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ai-ready-actions">
                    {aiTryable && (
                      <button
                        type="button"
                        className="secondary-button accent ai-try-button"
                        disabled={aiActive || activeInstalling !== null}
                        onClick={() => onAiInstall(repo)}
                        title="让 DSH 的 AI 研究仓库并尝试安装（实验性，只读自动放行、写操作需批准、可一键还原快照）"
                      >
                        {aiRepository === repo.fullName ? <LoaderCircle className="spin" size={15} /> : <Bot size={15} />}
                        AI 尝试
                      </button>
                    )}
                    <button type="button" className="install-button" disabled={actionDisabled} onClick={runAction}>
                      {isChecking || activeInstalling?.repository === repo.fullName
                        ? <LoaderCircle className="spin" size={16} />
                        : analysis?.kind === 'invalid' || (analysis && totalTargets === 0)
                          ? <CircleAlert size={16} />
                          : <Download size={16} />}
                      {isChecking ? '检测中' : actionLabel}
                    </button>
                  </div>
                )}
              </div>
            </article>
          )
        })}
      </section>

      <div className="catalog-pagination-bottom">
        <CatalogPagination
          page={page}
          pageCount={pageCount}
          visibleCount={repositories.length}
          loading={loading}
          disabled={loading}
          onPageChange={nextPage => void search(query, sort, nextPage)}
        />
      </div>

      {targetDialog && (
        <CatalogTargetDialog
          repo={targetDialog.repo}
          analysis={targetDialog.analysis}
          profile={profile}
          installedRepositories={installedRepos}
          installedSkillNames={installedSkillNames}
          installedApplicationRepositories={installedApplicationRepositories}
          installedPresetNames={installedPresetNames}
          pluginTrials={pluginTrials}
          busy={activeInstalling !== null || installingAll}
          installingAll={installingAll}
          aiActive={aiActive}
          aiSubject={aiSubject}
          onClose={() => setTargetDialog(null)}
          onInstallPlugin={target => void installPlugin(targetDialog.repo, target)}
          onInstallSkill={target => void installSkill(targetDialog.repo, target)}
          onInstallApplication={target => void installApplication(targetDialog.repo, target)}
          onInstallPreset={target => void installPreset(targetDialog.repo, target)}
          onInstallAll={() => void installAll(targetDialog.repo, targetDialog.analysis)}
          onTrialPlugin={onTrialPlugin}
          onAdaptPlugin={onAdaptPlugin}
        />
      )}

      {importOpen && (
        <ImportUrlDialog
          busy={importing}
          onImport={url => void importFromUrl(url)}
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  )
}

function ImportUrlDialog({
  busy,
  onImport,
  onClose,
}: {
  busy: boolean
  onImport: (url: string) => void
  onClose: () => void
}) {
  const [url, setUrl] = useState('')
  const trimmed = url.trim()
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onClose() }}>
      <section className="modal import-url-dialog" role="dialog" aria-modal="true" aria-labelledby="import-url-title">
        <header>
          <div><Link2 size={18} /><h2 id="import-url-title">从 GitHub 链接导入</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="modal-content">
          <p className="target-dialog-summary">
            粘贴 GitHub 仓库链接，例如 <code>https://github.com/owner/repo</code> 或 <code>git@github.com:owner/repo.git</code>。
            导入后会加入市场列表，并复用同一套「检测 / 安装 / 选择组件」流程。
          </p>
          <form className="import-url-form" onSubmit={event => { event.preventDefault(); if (trimmed) onImport(trimmed) }}>
            <input
              value={url}
              autoFocus
              disabled={busy}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repo"
              aria-label="GitHub 仓库链接"
            />
            <button type="submit" className="primary-command" disabled={busy || !trimmed}>
              <ScanSearch size={15} />导入并检测
            </button>
          </form>
        </div>
        <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button></footer>
      </section>
      <style>{importUrlDialogStyle}</style>
    </div>
  )
}

const importUrlDialogStyle = `
.import-url-dialog { width: min(520px, calc(100vw - 32px)); }
.import-url-form { display: flex; gap: 8px; margin-top: 4px; align-items: center; }
.import-url-form input {
  flex: 1; min-width: 0; height: 34px; padding: 0 9px;
  border: 1px solid var(--line-strong); border-radius: 5px;
  color: var(--ink); background: #fff;
  font-family: Consolas, "Segoe UI", sans-serif; font-size: 11px;
}
`

function PluginTrialActions({
  target,
  result,
  disabled,
  adapting,
  onTrial,
  onAdapt,
}: {
  target: PluginInstallTarget
  result?: PluginTrialResult
  disabled: boolean
  adapting: boolean
  onTrial: (packageName: string, profileName: string) => void
  onAdapt: (packageName: string, profileName: string) => void
}) {
  const running = result?.phase === 'running'
  const trialLabel = running
    ? '试运行中'
    : result?.phase === 'passed'
      ? '再次试运行'
      : result?.phase === 'failed'
        ? '重新试运行'
        : '试运行'
  return (
    <div className="plugin-trial-actions">
      <button
        type="button"
        className={`secondary-button compact trial-button ${result?.phase ?? ''}`}
        disabled={disabled || running || adapting}
        onClick={() => onTrial(target.packageName, target.profileName)}
        title={result?.message ?? `只加载 DSH Web 核心与 ${target.packageName} 进行隔离试运行`}
      >
        {running ? <LoaderCircle className="spin" size={14} /> : result?.phase === 'passed' ? <CircleCheck size={14} /> : result?.phase === 'failed' ? <CircleAlert size={14} /> : <Play size={14} />}
        {trialLabel}
      </button>
      {result?.phase === 'failed' && (
        <button
          type="button"
          className="secondary-button compact accent adapt-button"
          disabled={disabled || adapting}
          onClick={() => onAdapt(target.packageName, target.profileName)}
          title="调用 DSH Flash 模型分析失败诊断并尝试做最小安全适配"
        >
          {adapting ? <LoaderCircle className="spin" size={14} /> : <Wrench size={14} />}
          DSH 安装适配
        </button>
      )}
    </div>
  )
}

function CatalogTargetDialog({
  repo,
  analysis,
  profile,
  installedRepositories,
  installedSkillNames,
  installedApplicationRepositories,
  installedPresetNames,
  pluginTrials,
  busy,
  installingAll,
  aiActive,
  aiSubject,
  onClose,
  onInstallPlugin,
  onInstallSkill,
  onInstallApplication,
  onInstallPreset,
  onInstallAll,
  onTrialPlugin,
  onAdaptPlugin,
}: {
  repo: CatalogRepositoryResult
  analysis: CatalogRepositoryAnalysis
  profile: ProfileState
  installedRepositories: Set<string>
  installedSkillNames: Set<string>
  installedApplicationRepositories: Set<string>
  installedPresetNames: Set<string>
  pluginTrials: Record<string, PluginTrialResult>
  busy: boolean
  installingAll: boolean
  aiActive: boolean
  aiSubject: string | null
  onClose: () => void
  onInstallPlugin: (target: PluginInstallTarget) => void
  onInstallSkill: (target: SkillInstallTarget) => void
  onInstallApplication: (target: ApplicationInstallTarget) => void
  onInstallPreset: (target: PresetInstallTarget) => void
  onInstallAll: () => void
  onTrialPlugin: (packageName: string, profileName: string) => void
  onAdaptPlugin: (packageName: string, profileName: string) => void
}) {
  const plugins = pluginTargets(analysis)
  const skills = skillTargets(analysis)
  const applications = applicationTargets(analysis)
  const presets = presetTargets(analysis)
  const repoInstalled = installedRepositories.has(repo.fullName.toLowerCase())
  const isPluginInstalled = (target: PluginInstallTarget) =>
    profile.plugins.some(plugin => plugin.packageName === target.packageName)
    || (plugins.length === 1 && repoInstalled)
  const uninstalledCount = plugins.filter(target => !isPluginInstalled(target)).length
    + skills.filter(target => !installedSkillNames.has(target.name)).length
    + presets.filter(target => !installedPresetNames.has(target.name)).length
  const allInstalled = uninstalledCount === 0
  const applicationInstalled = installedApplicationRepositories.has(repo.fullName.toLowerCase())

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onClose() }}>
      <section className="modal plugin-target-dialog catalog-target-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-target-title">
        <header>
          <div><Layers3 size={18} /><h2 id="catalog-target-title">选择要安装的组件</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="modal-content">
          <p className="target-dialog-summary">{repo.fullName} 的 Plugin、Skill、应用加载项与 Agent 预设会分别安装；应用加载项需要单独确认。</p>

          {(plugins.length > 0 || analysis.pluginAnalysis?.installability === 'dynamic') && (
            <section className="catalog-target-section">
              <h3><Box size={15} />Plugin</h3>
              {analysis.pluginAnalysis?.installability === 'dynamic' && plugins.length === 0
                ? <div className="catalog-target-unavailable"><CircleAlert size={15} />这是动态会话 Plugin，当前不能作为持久 Bundle 安装。</div>
                : <div className="plugin-target-list">
                    {plugins.map(target => {
                      const installed = isPluginInstalled(target)
                      const trial = pluginTrials[`${target.profileName}:${target.packageName}`]
                      return (
                        <div className="plugin-target-row" key={`plugin:${target.id}`}>
                          <div className="plugin-target-icon">{target.platform === 'terminal' ? <SquareTerminal size={17} /> : <Box size={17} />}</div>
                          <div className="plugin-target-copy">
                            <strong>{target.packageName}</strong>
                            <span>{target.source === 'npm' ? `npm ${target.version ?? ''}` : target.source === 'github' ? 'GitHub 仓库根目录' : `仓库子目录：${target.subdirectory}`}</span>
                            <small>{target.profileName} Profile{target.nodeRange ? ` · Node ${target.nodeRange}` : ''}{target.requiresBuild ? ` · 构建脚本：${target.buildScripts.join(', ')}` : ''}</small>
                          </div>
                          <div className="plugin-target-actions">
                            {installed && (
                              <PluginTrialActions
                                target={target}
                                result={trial}
                                disabled={busy || aiActive}
                                adapting={aiActive && aiSubject === target.packageName}
                                onTrial={onTrialPlugin}
                                onAdapt={onAdaptPlugin}
                              />
                            )}
                            <button type="button" className="install-button" disabled={busy || aiActive || trial?.phase === 'running'} onClick={() => onInstallPlugin(target)}>{installed ? <RefreshCw size={15} /> : <Download size={15} />}{installed ? '更新' : '安装'}</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>}
            </section>
          )}

          {skills.length > 0 && (
            <section className="catalog-target-section">
              <h3><BookOpenCheck size={15} />Skill</h3>
              <div className="plugin-target-list">
                {skills.map(target => {
                  const installed = installedSkillNames.has(target.name)
                  return (
                    <div className="plugin-target-row" key={`skill:${target.id}`}>
                      <div className="plugin-target-icon skill-icon"><BookOpenCheck size={17} /></div>
                      <div className="plugin-target-copy">
                        <strong>{target.name}</strong>
                        <span>{target.description}</span>
                        <small>{target.format === 'bundle' ? '目录 Skill' : '单文件 Skill'} · {target.sourcePath}{target.modelInvocable ? '' : ' · 不对模型开放'}</small>
                      </div>
                      <button type="button" className="install-button" disabled={busy} onClick={() => onInstallSkill(target)}>{installed ? <RefreshCw size={15} /> : <Download size={15} />}{installed ? '更新' : '安装'}</button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {applications.length > 0 && (
            <section className="catalog-target-section">
              <h3><AppWindow size={15} />应用加载项</h3>
              <div className="plugin-target-list">
                {applications.map(target => (
                  <div className="plugin-target-row" key={`application:${target.id}`}>
                    <div className="plugin-target-icon application-icon"><AppWindow size={17} /></div>
                    <div className="plugin-target-copy">
                      <strong>{target.name}</strong>
                      <span>{target.description}</span>
                      <small>{applicationLaunchModeLabel(target.launchMode)} · npm {target.packageName}{target.version ? `@${target.version}` : ''}{target.verified ? ' · 作者清单已识别' : ''}</small>
                      {!target.supported && <small className="warning">当前操作系统不受支持</small>}
                    </div>
                    <button type="button" className="install-button" disabled={busy || !target.supported} onClick={() => onInstallApplication(target)}>
                      {applicationInstalled ? <RefreshCw size={15} /> : <Download size={15} />}
                      {applicationInstalled ? '更新' : '安装'}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {presets.length > 0 && (
            <section className="catalog-target-section">
              <h3><Bot size={15} />Agent 预设</h3>
              <div className="plugin-target-list">
                {presets.map(target => {
                  const installed = installedPresetNames.has(target.name)
                  return (
                    <div className="plugin-target-row" key={`preset:${target.id}`}>
                      <div className="plugin-target-icon preset-icon"><Bot size={17} /></div>
                      <div className="plugin-target-copy">
                        <strong>{target.name}</strong>
                        <span>{target.description}</span>
                        <small>复制到 DSH 预设目录 · {target.sourcePath}@{target.revision.slice(0, 12)}</small>
                      </div>
                      <button type="button" className="install-button" disabled={busy} onClick={() => onInstallPreset(target)}>{installed ? <RefreshCw size={15} /> : <Download size={15} />}{installed ? '更新' : '安装'}</button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
        <footer>
          <button
            type="button"
            className="primary-command"
            disabled={busy || allInstalled}
            onClick={onInstallAll}
            title="按顺序安装全部未安装的组件（不会重复安装已装的）"
          >
            {installingAll ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            {allInstalled ? '已全部安装' : `一键安装全部（${uninstalledCount}）`}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        </footer>
      </section>
    </div>
  )
}

function applicationLaunchModeLabel(mode: ApplicationInstallTarget['launchMode']): string {
  if (mode === 'runtime-replacement') return '替代普通 DSH Web 启动'
  if (mode === 'after-runtime') return 'DSH 启动后伴随运行'
  return '独立应用'
}
