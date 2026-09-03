import {
  ArrowLeft,
  BookOpen,
  Check,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Maximize2,
  Minus,
  Package,
  RefreshCw,
  Search,
  Settings,
  Store,
  Trash2,
  TrendingUp,
  Wand2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { SkeletonStrip } from '../components/Skeleton'
import { DshMarketView } from './DshMarketView'
import {
  SKILL_CATEGORIES,
  SKILL_MARKET_SOURCES,
  collectSkillMarketEntries,
  collectSkillsShEntries,
  filterSkillMarketEntries,
  formatInstalls,
  partitionDshVersions,
  type SkillCategory,
  type SkillMarketEntry,
  type SkillMarketSource,
  type SkillMarketSourceKind,
} from '../lib/skill-market'
import type {
  AppSettings,
  BuiltinAgentPreset,
  HomeTab,
  DshInstallationStatus,
  InstalledPreset,
  InstalledSkill,
  InstallProgress,
  ManagedPlugin,
  PackStatus,
  ProfileState,
  RuntimeEnvironmentState,
  RuntimeVersionCandidate,
  SkillInstallResult,
  SkillRepositoryAnalysis,
  SkillsShSkill,
} from '../types'

/**
 * C 端「设置」页：启动页齿轮入口进来的全屏简洁管理页。
 * 顶栏=返回（左上）+ 窗口键（最右）；左竖栏=四个分类 + 刷新/开发者模式；
 * 右内容=当前分类面板。版本直接点列表下载；插件内嵌 DSH Market；技能内嵌双源技能市场。
 * 视觉沿用现有主题体系。
 */

interface SettingsPanelsProps {
  settings: AppSettings
  /** 一级导航当前 tab（start 由 LauncherHome 承担，不进这里）。 */
  tab: Exclude<HomeTab, 'start'>
  profile: ProfileState
  dshInstallation: DshInstallationStatus
  runtimeEnvironment: RuntimeEnvironmentState | null
  installedSkills: InstalledSkill[]
  installedPresets: InstalledPreset[]
  packs: PackStatus[]
  busy: string | null
  profileMutationLocked: boolean
  installProgress: InstallProgress | null
  onRefresh: () => void
  onImportPack: () => void
  onInstallDshVersion: (version: string) => Promise<boolean>
  onSelectDshVersion: (version: string) => Promise<boolean>
  onRemoveDshVersion: (version: string) => Promise<boolean>
  onTogglePlugin: (plugin: ManagedPlugin, enabled: boolean) => Promise<boolean>
  onToggleSkill: (skill: InstalledSkill, enabled: boolean) => void
  onTogglePreset: (preset: InstalledPreset, enabled: boolean) => void
  onSkillInstalled: (result: SkillInstallResult) => void
  onProfileChanged: () => void
  onActivatePack: (packId: string) => Promise<boolean>
  onDeactivatePack: () => Promise<boolean>
  onRemovePack: (packId: string) => Promise<boolean>
  onExportPack: (packId: string) => Promise<string | null>
  onOpenDshFolder: () => void
  onOpenPluginFolder: (packageName: string) => void
  onOpenPath: (targetPath: string) => void
}

export function SettingsPanels({
  settings,
  tab,
  profile,
  dshInstallation,
  runtimeEnvironment,
  installedSkills,
  installedPresets,
  packs,
  busy,
  profileMutationLocked,
  installProgress,
  onRefresh,
  onImportPack,
  onInstallDshVersion,
  onSelectDshVersion,
  onRemoveDshVersion,
  onTogglePlugin,
  onToggleSkill,
  onTogglePreset,
  onSkillInstalled,
  onProfileChanged,
  onActivatePack,
  onDeactivatePack,
  onRemovePack,
  onExportPack,
  onOpenDshFolder,
  onOpenPluginFolder,
  onOpenPath,
}: SettingsPanelsProps) {
  const activePack = useMemo(() => {
    const direct = packs.find(pack => pack.id === settings.profileName)
    if (direct) return direct
    return packs.find(pack => pack.id === settings.activePackId) ?? null
  }, [packs, settings.activePackId, settings.profileName])

  const locked = busy !== null || profileMutationLocked

  return (
    <div className="home-tab-page">
      <main className="settings-content">
          {tab === 'versions' && (
            <SettingsVersions
              environment={runtimeEnvironment}
              installed={Boolean(dshInstallation.installed)}
              busy={locked}
              installProgress={installProgress}
              onInstall={onInstallDshVersion}
              onSelect={onSelectDshVersion}
              onRemove={onRemoveDshVersion}
              onOpenFolder={onOpenDshFolder}
              onRefresh={onRefresh}
              refreshLocked={locked}
            />
          )}
          {tab === 'plugins' && (
            <SettingsPluginsTab
              profile={profile}
              busy={locked}
              onTogglePlugin={onTogglePlugin}
              onOpenPluginFolder={onOpenPluginFolder}
              onProfileChanged={onProfileChanged}
              onRefresh={onRefresh}
              refreshLocked={locked}
            />
          )}
          {tab === 'skills' && (
            <SettingsSkillsTab
              installedSkills={installedSkills}
              busy={locked}
              dshHome={settings.dshHome}
              onToggleSkill={onToggleSkill}
              onSkillInstalled={onSkillInstalled}
              onRefresh={onRefresh}
              refreshLocked={locked}
              onOpenPath={onOpenPath}
            />
          )}
          {tab === 'presets' && (
            <SettingsPresetsTab
              installedPresets={installedPresets}
              busy={locked}
              dshHome={settings.dshHome}
              onTogglePreset={onTogglePreset}
              onOpenPath={onOpenPath}
              onRefresh={onRefresh}
              refreshLocked={locked}
            />
          )}
          {tab === 'packs' && (
            <SettingsPacks
              packs={packs}
              activePack={activePack}
              busy={locked}
              onRefresh={onRefresh}
              onImport={onImportPack}
              onActivate={id => { void onActivatePack(id) }}
              onDeactivate={() => { void onDeactivatePack() }}
              onExport={id => { void onExportPack(id) }}
              onRemove={id => {
                if (window.confirm('确定删除这个整合包吗？已导入的独立环境会一并移除。')) void onRemovePack(id)
              }}
            />
          )}
      </main>
    </div>
  )
}

/** 面板标题行右侧的轻量刷新钮（取代悬浮在页面角上的孤立按钮）。 */
function PanelRefresh({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" className="settings-panel-refresh" onClick={onClick} disabled={disabled}>
      <RefreshCw size={13} className={disabled ? 'spin' : undefined} /><span>刷新</span>
    </button>
  )
}

function SettingsVersions({
  environment,
  installed,
  busy,
  installProgress,
  onInstall,
  onSelect,
  onRemove,
  onOpenFolder,
  onRefresh,
  refreshLocked,
}: {
  environment: RuntimeEnvironmentState | null
  installed: boolean
  busy: boolean
  installProgress: InstallProgress | null
  onInstall: (version: string) => Promise<boolean>
  onSelect: (version: string) => Promise<boolean>
  onRemove: (version: string) => Promise<boolean>
  onOpenFolder: () => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const [expandedGroup, setExpandedGroup] = useState<'stable' | 'prerelease' | null>(null)
  const dshProgress = installProgress && installProgress.kind === 'dsh'
    && installProgress.phase !== 'complete' && installProgress.phase !== 'error'
    ? installProgress : null

  if (!environment) {
    return <div className="settings-empty"><LoaderCircle className="spin" size={20} />正在读取 DSH 版本</div>
  }

  const installedVersions = new Set(environment.dshInstalled.map(item => item.version))
  const { stable, prerelease } = partitionDshVersions(environment.dshAvailable, installedVersions)

  return (
    <div className="settings-stack">
      <section className="settings-panel">
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><Cpu size={17} /><span>已安装版本</span></div>
          <div className="settings-market-heading-actions">
            <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
            <button type="button" className="icon-button" onClick={onOpenFolder} title="打开 DSH 版本文件夹" aria-label="打开 DSH 版本文件夹"><FolderOpen size={16} /></button>
          </div>
        </div>
        <div className="settings-current">
          <span>当前使用</span>
          <strong>{environment.dshSelectedVersion ?? '未选择'}</strong>
        </div>
        <div className="settings-list">
          {environment.dshInstalled.map(item => (
            <ResourceRow
              key={item.version}
              title={item.version}
              subtitle={item.source === 'legacy' ? '旧目录' : undefined}
              enabled={item.selected}
              selected
              busy={busy}
              onSelect={item.selected ? undefined : () => { void onSelect(item.version) }}
              onRemove={item.removable ? () => { void onRemove(item.version) } : undefined}
            />
          ))}
          {environment.dshInstalled.length === 0 && (
            <div className="settings-empty">{installed ? '该版本未出现在列表中，刷新后再试。' : '尚未安装任何版本；在下方「可下载版本」里点一个即可。'}</div>
          )}
        </div>
      </section>

      <section className="settings-panel">
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><Download size={17} /><span>可下载版本</span></div>
        </div>
        {dshProgress && (
          <div className="settings-progress">
            <LoaderCircle size={14} className="spin" />
            <span>{dshProgress.message}</span>
            <div className={`settings-progress-track ${dshProgress.indeterminate || dshProgress.percent === 0 ? 'indeterminate' : 'determinate'}`}>
              {!dshProgress.indeterminate && dshProgress.percent > 0 && <span style={{ width: `${dshProgress.percent}%` }} />}
            </div>
            {!dshProgress.indeterminate && dshProgress.percent > 0 && <strong>{dshProgress.percent}%</strong>}
          </div>
        )}
        <div className="settings-hint">点「下载」直接安装该版本；完成后会自动设为当前使用。</div>
        {stable.length === 0 && prerelease.length === 0 && <div className="settings-empty">registry 里没有更多可下载的版本。</div>}
        <VersionGroup
          title="稳定版"
          candidates={stable}
          expanded={expandedGroup === 'stable'}
          onToggle={() => setExpandedGroup(value => value === 'stable' ? null : 'stable')}
          busy={busy || dshProgress !== null}
          onInstall={onInstall}
        />
        <VersionGroup
          title="预发布版"
          candidates={prerelease}
          expanded={expandedGroup === 'prerelease'}
          onToggle={() => setExpandedGroup(value => value === 'prerelease' ? null : 'prerelease')}
          busy={busy || dshProgress !== null}
          onInstall={onInstall}
        />
      </section>
    </div>
  )
}

/** 可下载版本分组：默认只露 5 条，组内可展开，避免长列表堆在一起。 */
function VersionGroup({
  title,
  candidates,
  expanded,
  onToggle,
  busy,
  onInstall,
}: {
  title: string
  candidates: RuntimeVersionCandidate[]
  expanded: boolean
  onToggle: () => void
  busy: boolean
  onInstall: (version: string) => Promise<boolean>
}) {
  if (candidates.length === 0) return null
  const shown = expanded ? candidates : candidates.slice(0, 5)
  return (
    <div className="settings-version-group">
      <div className="settings-version-group-head">
        <span className="settings-version-group-title">{title}<em>{candidates.length}</em></span>
        {candidates.length > 5 && (
          <button type="button" className="settings-nav-link" onClick={onToggle}>{expanded ? '收起' : `展开全部 ${candidates.length} 个`}</button>
        )}
      </div>
      <div className="settings-list">
        {shown.map(candidate => (
          <div key={candidate.version} className="settings-row">
            <div className="settings-row-copy">
              <strong>{candidate.version}</strong>
              <span>{[candidate.label, candidate.date ? candidate.date.slice(0, 10) : null, candidate.prerelease ? '预发布' : null].filter(Boolean).join(' · ') || 'npm registry'}</span>
            </div>
            <div className="settings-row-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { void onInstall(candidate.version) }}>
                {busy ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}下载
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsPluginsTab({
  profile,
  busy,
  onTogglePlugin,
  onOpenPluginFolder,
  onProfileChanged,
  onRefresh,
  refreshLocked,
}: {
  profile: ProfileState
  busy: boolean
  onTogglePlugin: (plugin: ManagedPlugin, enabled: boolean) => Promise<boolean>
  onOpenPluginFolder: (packageName: string) => void
  onProfileChanged: () => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const [subView, setSubView] = useState<'installed' | 'market'>('installed')
  return (
    <div className="settings-stack">
      <div className="settings-segmented" role="tablist" aria-label="插件视图">
        <button type="button" role="tab" aria-selected={subView === 'installed'} className={subView === 'installed' ? 'active' : ''} onClick={() => setSubView('installed')}>已安装</button>
        <button type="button" role="tab" aria-selected={subView === 'market'} className={subView === 'market' ? 'active' : ''} onClick={() => setSubView('market')}>DSH Market</button>
      </div>
      {/* 两个子视图都保持挂载，切换只切可见性：DSH Market 不再每次重建+重拉目录 */}
      <div className={subView === 'installed' ? undefined : 'view-hidden'}>
        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div className="settings-panel-title"><Layers3 size={17} /><span>已安装插件</span>{profile.plugins.length > 0 && <span className="settings-count">{profile.plugins.length}</span>}</div>
            <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
          </div>
          <div className="settings-hint">开关决定插件在下次启动时是否加载；停用不会删除本体。</div>
          <div className="settings-list">
            {profile.plugins.map(plugin => (
              <ResourceRow
                key={plugin.packageName}
                title={plugin.displayName}
                subtitle={plugin.builtin ? 'DSH 核心组合层' : plugin.version}
                locked={plugin.locked}
                enabled={plugin.enabled}
                busy={busy}
                onToggle={enabled => { void onTogglePlugin(plugin, enabled) }}
                onOpenFolder={plugin.builtin ? undefined : () => onOpenPluginFolder(plugin.packageName)}
              />
            ))}
            {profile.plugins.length === 0 && <div className="settings-empty">当前环境还没有插件；切到「DSH Market」点安装。</div>}
          </div>
        </section>
      </div>
      <div className={subView === 'market' ? undefined : 'view-hidden'}>
        <section className="settings-panel">
          <DshMarketView embedded onProfileChanged={onProfileChanged} />
        </section>
      </div>
    </div>
  )
}

function SettingsSkillsTab({
  installedSkills,
  busy,
  dshHome,
  onToggleSkill,
  onSkillInstalled,
  onRefresh,
  refreshLocked,
  onOpenPath,
}: {
  installedSkills: InstalledSkill[]
  busy: boolean
  dshHome: string
  onToggleSkill: (skill: InstalledSkill, enabled: boolean) => void
  onSkillInstalled: (result: SkillInstallResult) => void
  onRefresh: () => void
  refreshLocked: boolean
  onOpenPath: (targetPath: string) => void
}) {
  const [subView, setSubView] = useState<'installed' | 'market'>('installed')
  return (
    <div className="settings-stack">
      <div className="settings-segmented" role="tablist" aria-label="技能视图">
        <button type="button" role="tab" aria-selected={subView === 'installed'} className={subView === 'installed' ? 'active' : ''} onClick={() => setSubView('installed')}>已安装</button>
        <button type="button" role="tab" aria-selected={subView === 'market'} className={subView === 'market' ? 'active' : ''} onClick={() => setSubView('market')}>技能市场</button>
      </div>
      <div className={subView === 'installed' ? undefined : 'view-hidden'}>
        <SettingsSection
          title="已安装技能"
          empty={installedSkills.length === 0}
          emptyText="还没有安装技能——切到「技能市场」点一下就能装。"
          onOpenFolder={() => onOpenPath(dshHome)}
          actions={<PanelRefresh onClick={onRefresh} disabled={refreshLocked} />}
        >
          {installedSkills.map(skill => (
            <ResourceRow
              key={skill.name}
              title={skill.name}
              subtitle={skill.description || skill.path}
              enabled={skill.enabled}
              busy={busy}
              onToggle={enabled => onToggleSkill(skill, enabled)}
              onOpenFolder={() => onOpenPath(skill.path)}
            />
          ))}
        </SettingsSection>
      </div>
      <div className={subView === 'market' ? undefined : 'view-hidden'}>
        <SkillMarketPanel
          installedSkills={installedSkills}
          busy={busy}
          onInstalled={onSkillInstalled}
          onRefresh={onRefresh}
          refreshLocked={refreshLocked}
        />
      </div>
    </div>
  )
}

function SettingsPresetsTab({
  installedPresets,
  busy,
  dshHome,
  onTogglePreset,
  onOpenPath,
  onRefresh,
  refreshLocked,
}: {
  installedPresets: InstalledPreset[]
  busy: boolean
  dshHome: string
  onTogglePreset: (preset: InstalledPreset, enabled: boolean) => void
  onOpenPath: (targetPath: string) => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const api = useLauncherApi()
  const [builtin, setBuiltin] = useState<BuiltinAgentPreset[] | null>(null)
  useEffect(() => {
    let alive = true
    void api.presetsBuiltin()
      .then(list => { if (alive) setBuiltin(list) })
      .catch(() => { if (alive) setBuiltin([]) })
    return () => { alive = false }
  }, [api])
  return (
    <div className="settings-stack">
      <section className="settings-panel">
        <div className="settings-panel-heading">
          <div className="settings-panel-title"><Wand2 size={17} /><span>内置预设</span>{builtin !== null && builtin.length > 0 && <span className="settings-count">{builtin.length}</span>}</div>
          <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
        </div>
        <div className="settings-hint">随 DSH 一起发布，在 DSH 界面里切换工作模式；启动器只读展示。</div>
        {builtin === null && <div className="settings-empty"><LoaderCircle size={18} className="spin" />正在读取内置预设…</div>}
        {builtin !== null && builtin.length === 0 && <div className="settings-empty">当前 DSH 版本没有发现内置预设。</div>}
        <div className="settings-list">
          {(builtin ?? []).map(preset => (
            <div key={preset.name} className="settings-row">
              <div className="settings-row-copy">
                <strong>{preset.displayName}</strong>
                <span>{preset.description || preset.name}</span>
              </div>
              <div className="settings-row-actions">
                <span className="settings-row-badge">内置</span>
              </div>
            </div>
          ))}
        </div>
      </section>
      <SettingsSection
        title="已安装预设"
        empty={installedPresets.length === 0}
        emptyText="本机还没有安装预设。"
        onOpenFolder={() => onOpenPath(`${dshHome}\.agent-presets`)}
      >
        {installedPresets.map(preset => (
          <ResourceRow
            key={preset.name}
            title={preset.name}
            subtitle={preset.enabled ? preset.path : `已停用（${preset.path}）`}
            enabled={preset.enabled}
            busy={busy}
            onToggle={enabled => onTogglePreset(preset, enabled)}
            onOpenFolder={() => onOpenPath(preset.path)}
          />
        ))}
      </SettingsSection>
    </div>
  )
}

interface SkillSourceState {
  status: 'loading' | 'ready' | 'failed'
  analysis: SkillRepositoryAnalysis | null
  error: string | null
}

function SkillMarketPanel({
  installedSkills,
  busy,
  onInstalled,
  onRefresh,
  refreshLocked,
}: {
  installedSkills: InstalledSkill[]
  busy: boolean
  onInstalled: (result: SkillInstallResult) => void
  onRefresh: () => void
  refreshLocked: boolean
}) {
  const api = useLauncherApi()
  const [catalog, setCatalog] = useState<{ status: 'loading' | 'ready' | 'failed'; skills: SkillsShSkill[]; error: string | null }>({ status: 'loading', skills: [], error: null })
  const [sources, setSources] = useState<Record<string, SkillSourceState>>({})
  const [query, setQuery] = useState('')
  const [sourceKind, setSourceKind] = useState<'all' | SkillMarketSourceKind>('all')
  const [category, setCategory] = useState<'all' | SkillCategory>('all')
  const [busyName, setBusyName] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  // 通用技能 = skills.sh 目录索引（主进程聚合+缓存）；DSH 社区 = 精选仓库归档分析。
  const loadCatalog = useCallback(() => {
    setCatalog(current => ({ status: 'loading', skills: current.skills, error: null }))
    api.skillMarketCatalog()
      .then(skills => setCatalog({ status: 'ready', skills, error: null }))
      .catch((cause: unknown) => {
        console.error('[skill-market] skills.sh catalog', cause)
        setCatalog(current => ({ status: 'failed', skills: current.skills, error: cause instanceof Error ? cause.message : 'skills.sh 目录读取失败' }))
      })
  }, [api])

  const loadSource = useCallback((source: SkillMarketSource) => {
    setSources(current => ({ ...current, [source.repository]: { status: 'loading', analysis: current[source.repository]?.analysis ?? null, error: null } }))
    api.skillMarketAnalyze(source.repository, source.defaultBranch)
      .then(analysis => setSources(current => ({ ...current, [source.repository]: { status: 'ready', analysis, error: null } })))
      .catch((cause: unknown) => {
        console.error(`[skill-market] ${source.repository}`, cause)
        setSources(current => ({ ...current, [source.repository]: { status: 'failed', analysis: current[source.repository]?.analysis ?? null, error: cause instanceof Error ? cause.message : '读取失败' } }))
      })
  }, [api])

  useEffect(() => {
    loadCatalog()
  }, [loadCatalog])

  useEffect(() => {
    SKILL_MARKET_SOURCES.forEach(loadSource)
  }, [loadSource])

  const analyses = useMemo(() => {
    const map: Record<string, SkillRepositoryAnalysis | null> = {}
    for (const source of SKILL_MARKET_SOURCES) map[source.repository] = sources[source.repository]?.analysis ?? null
    return map
  }, [sources])
  const entries = useMemo(() => [
    ...collectSkillsShEntries(catalog.skills, installedSkills),
    ...collectSkillMarketEntries(analyses, installedSkills),
  ], [catalog.skills, analyses, installedSkills])
  const visible = useMemo(() => filterSkillMarketEntries(entries, query, sourceKind, category), [entries, query, sourceKind, category])
  const loading = catalog.status === 'loading' || SKILL_MARKET_SOURCES.some(source => (sources[source.repository]?.status ?? 'loading') === 'loading')
  const allFailed = catalog.status === 'failed' && SKILL_MARKET_SOURCES.every(source => sources[source.repository]?.status === 'failed')

  const install = async (entry: SkillMarketEntry) => {
    setBusyName(entry.name)
    setInstallError(null)
    try {
      const result = entry.origin === 'index'
        ? await api.skillMarketInstallByName({ sourceRepository: entry.source.repository, skillId: entry.name })
        : await api.skillMarketInstall({
          repository: entry.target?.sourceRepository ?? entry.source.repository,
          target: entry.target!,
        })
      onInstalled(result)
    } catch (cause) {
      console.error(`[skill-market] install ${entry.name}`, cause)
      setInstallError(`安装「${entry.name}」失败：${cause instanceof Error ? cause.message : '未知错误'}`)
    } finally {
      setBusyName(null)
    }
  }

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Store size={17} /><span>技能市场</span>{entries.length > 0 && <span className="settings-count">{entries.length}</span>}</div>
        <div className="settings-market-heading-actions">
          <PanelRefresh onClick={onRefresh} disabled={refreshLocked} />
          <button type="button" className="settings-nav-link" onClick={() => void api.openExternal('https://skills.sh')} title="skills.sh 开放目录（浏览）"><ExternalLink size={13} />在 skills.sh 浏览更多</button>
        </div>
      </div>
      <div className="settings-market-toolbar">
        <label className="settings-market-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索技能名称或描述" /></label>
        <div className="settings-market-chips">
          {([['all', '全部'], ['general', '通用技能'], ['dsh', 'DSH 社区']] as const).map(([id, label]) => (
            <button key={id} type="button" className={sourceKind === id ? 'active' : ''} onClick={() => setSourceKind(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="settings-market-chips settings-market-categories">
        <button type="button" className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>全部分类</button>
        {SKILL_CATEGORIES.map(item => (
          <button key={item} type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>
        ))}
      </div>
      {catalog.status === 'loading' && <SkeletonStrip label="正在读取 skills.sh 目录（数千个技能，首次稍慢）…" />}
      {catalog.status === 'failed' && (
        <div className="settings-market-source failed">
          <span>skills.sh 目录：{catalog.error}</span>
          <button type="button" className="settings-nav-link" onClick={loadCatalog}>重试</button>
        </div>
      )}
      {SKILL_MARKET_SOURCES.map(source => {
        const state = sources[source.repository]
        if (state?.status === 'ready') return null
        if (state?.status === 'failed') {
          return (
            <div key={source.repository} className="settings-market-source failed">
              <span>{source.label}：{state.error}</span>
              <button type="button" className="settings-nav-link" onClick={() => loadSource(source)}>重试</button>
            </div>
          )
        }
        return <SkeletonStrip key={source.repository} label={`正在读取 ${source.label}…`} />
      })}
      {allFailed && <div className="error-banner"><span>技能目录与社区仓库都读取失败。若你的网络需要代理才能访问外网，请在「开发者模式 → 网络」配置代理或 GitHub 镜像后重试。</span><button type="button" onClick={() => { loadCatalog(); SKILL_MARKET_SOURCES.forEach(loadSource) }}>全部重试</button></div>}
      {installError && <div className="error-banner"><span>{installError}</span><button type="button" onClick={() => setInstallError(null)}>忽略</button></div>}
      {!loading && !allFailed && visible.length === 0 && <div className="settings-empty"><Search size={20} />没有匹配的技能。</div>}
      <div className="skill-market-grid">
        {visible.map(entry => {
          const isBusy = busyName === entry.name
          const repositoryUrl = entry.target?.sourceRepository ?? entry.source.repository
          return (
            <article key={entry.key} className="skill-market-card">
              <div className="skill-market-card-head">
                <div>
                  <h2>{entry.name}</h2>
                  {entry.displayName !== entry.name && <span>{entry.displayName}</span>}
                </div>
                {entry.installed
                  ? <span className="settings-row-badge"><Check size={12} />已装</span>
                  : entry.installs != null && <span className="skill-market-installs"><TrendingUp size={11} />{formatInstalls(entry.installs)}</span>}
              </div>
              <div className="skill-market-meta">
                <span>{entry.category}</span>
                {entry.origin === 'repo' && <span>{entry.format === 'bundle' ? '技能包' : '单文件'}</span>}
                <span>{entry.origin === 'index' ? entry.source.repository : entry.source.label}</span>
              </div>
              <p>{entry.displayDescription || '暂无描述'}</p>
              {/* 卡脚与 DSH Market 对齐：仓库链接在左，安装/开关在右 */}
              <div className="skill-market-card-foot">
                <button type="button" className="dsh-market-link" onClick={() => void api.openExternal(`https://github.com/${repositoryUrl}`)}><ExternalLink size={12} />仓库</button>
                <span className="dsh-market-grow" />
                {entry.installed ? (
                  <label className="switch" title={entry.enabled ? '停用技能' : '启用技能'}>
                    <input type="checkbox" checked={entry.enabled} disabled={busy} onChange={event => { void api.toggleSkill(entry.name, event.target.checked).then(onRefresh) }} />
                    <span />
                  </label>
                ) : (
                  <button type="button" className="primary-command" disabled={busy || isBusy} onClick={() => { void install(entry) }}>
                    {isBusy ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}安装
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function SettingsSection({
  title,
  empty,
  emptyText,
  onOpenFolder,
  actions,
  children,
}: {
  title: string
  empty: boolean
  emptyText: string
  onOpenFolder: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><BookOpen size={17} /><span>{title}</span></div>
        <div className="settings-market-heading-actions">
          {actions}
          <button type="button" className="icon-button" onClick={onOpenFolder} title={`打开${title}文件夹`} aria-label={`打开${title}文件夹`}><FolderOpen size={16} /></button>
        </div>
      </div>
      {empty ? <div className="settings-empty">{emptyText}</div> : <div className="settings-list">{children}</div>}
    </section>
  )
}

function SettingsPacks({
  packs,
  activePack,
  busy,
  onRefresh,
  onImport,
  onActivate,
  onDeactivate,
  onExport,
  onRemove,
}: {
  packs: PackStatus[]
  activePack: PackStatus | null
  busy: boolean
  onRefresh: () => void
  onImport: () => void
  onActivate: (packId: string) => void
  onDeactivate: () => void
  onExport: (packId: string) => void
  onRemove: (packId: string) => void
}) {
  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Package size={17} /><span>整合包</span>{packs.length > 0 && <span className="settings-count">{packs.length}</span>}</div>
        <div className="settings-market-heading-actions">
          <PanelRefresh onClick={onRefresh} disabled={busy} />
          <button type="button" className="primary-command" onClick={onImport} disabled={busy}><Download size={15} />导入整合包</button>
        </div>
      </div>
      <div className="settings-hint">整合包是一整套「DSH 版本 + 插件 + 技能 + 预设 + 配置」；导入时若机器上没有配套的 DSH 版本会自动下载，并与其它环境隔离。</div>
      {packs.length === 0 && <div className="settings-empty">还没有任何整合包；可导入他人分享的 .zip，或到「完整管理界面」里创建一个。</div>}
      <div className="settings-list">
        {packs.map(pack => {
          const isActive = activePack?.id === pack.id
          const itemCount = pack.plugins.length
            + (pack.skills?.length ?? 0)
            + (pack.presets?.length ?? 0)
            + (pack.applications?.length ?? 0)
          return (
            <div key={pack.id} className={`settings-pack-row ${isActive ? 'active' : ''}`}>
              <div className="settings-pack-copy">
                <strong>{pack.name}</strong>
                <span>{pack.description || pack.id}{pack.dshVersion ? ` · DSH ${pack.dshVersion}` : ''} · {itemCount} 项内容</span>
              </div>
              <div className="settings-pack-actions">
                {isActive
                  ? <span className="settings-pack-active"><Check size={13} />当前使用</span>
                  : pack.state === 'complete'
                    ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onActivate(pack.id)}>切换</button>
                    : <span className="settings-pack-state">未完成安装</span>}
                <button type="button" className="secondary-button" disabled={busy} onClick={() => onExport(pack.id)} title="导出为压缩包">导出</button>
                <button type="button" className="icon-button" disabled={busy} onClick={() => onRemove(pack.id)} title="删除整合包" aria-label="删除整合包"><Trash2 size={15} /></button>
              </div>
            </div>
          )
        })}
      </div>
      {activePack && (
        <div className="settings-pack-footer">
          <button type="button" className="secondary-button" disabled={busy} onClick={onDeactivate}>停用当前整合包</button>
        </div>
      )}
    </div>
  )
}

function ResourceRow({
  title,
  subtitle,
  enabled,
  selected = false,
  locked = false,
  busy,
  onToggle,
  onSelect,
  onRemove,
  onOpenFolder,
}: {
  title: string
  subtitle?: string
  enabled: boolean
  /** 版本行：勾选态显示「当前」，不参与开关语义。 */
  selected?: boolean
  locked?: boolean
  busy: boolean
  onToggle?: (enabled: boolean) => void
  onSelect?: () => void
  onRemove?: () => void
  onOpenFolder?: () => void
}) {
  return (
    <div className={`settings-row ${enabled && !selected ? 'enabled' : ''}`}>
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="settings-row-actions">
        {selected && <span className="settings-row-badge"><Check size={12} />当前</span>}
        {onToggle && (
          <label className="switch" title={enabled ? '停用' : '启用'}>
            <input type="checkbox" checked={enabled} disabled={busy} onChange={event => onToggle(event.target.checked)} />
            <span />
          </label>
        )}
        {!onToggle && onSelect && !selected && (
          <button type="button" className="secondary-button" disabled={busy || locked} onClick={onSelect}>使用</button>
        )}
        {onRemove && (
          <button type="button" className="icon-button" disabled={busy} onClick={onRemove} title="删除" aria-label={`删除 ${title}`}><Trash2 size={14} /></button>
        )}
        {onOpenFolder && (
          <button type="button" className="icon-button" onClick={onOpenFolder} title="打开文件夹" aria-label={`打开 ${title} 文件夹`}><FolderOpen size={15} /></button>
        )}
      </div>
    </div>
  )
}