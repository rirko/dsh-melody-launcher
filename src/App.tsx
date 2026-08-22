import { Layers3, LoaderCircle, PanelRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { LauncherApiProvider, resolveLauncherApi, useLauncherApi } from './api/client'
import { AppHeader } from './components/AppHeader'
import { LauncherHome } from './components/LauncherHome'
import { SideNavigation } from './components/SideNavigation'
import { DSHCopilotPanel } from './components/DSHCopilotPanel'
import { RuntimeDrawer } from './components/RuntimeDrawer'
import { Toast } from './components/Toast'
import { ConfirmDialog } from './components/dialogs/ConfirmDialog'
import { CredentialDialog } from './components/dialogs/CredentialDialog'
import { GitHubAccountDialog } from './components/dialogs/GitHubAccountDialog'
import { CreatePackDialog } from './components/dialogs/CreatePackDialog'
import { PackInstallDialog } from './components/dialogs/PackInstallDialog'
import { ProfileRepositoryImportDialog } from './components/dialogs/ProfileRepositoryImportDialog'
import { SettingsDialog } from './components/dialogs/SettingsDialog'
import { UpdateDialog } from './components/dialogs/UpdateDialog'
import { DSH_REPOSITORY } from './constants'
import { useAiInstall } from './hooks/use-ai-install'
import { useCopilotSessions } from './hooks/use-copilot-sessions'
import { BUSY } from './hooks/use-async-action'
import { useLauncherStore } from './hooks/use-launcher-store'
import { useNavigation } from './hooks/use-navigation'
import { usePackInstall } from './hooks/use-pack-install'
import { isInstallProgressActive } from './lib/install-progress'
import { clampRuntimeDrawerHeight, RUNTIME_DRAWER_AUTO_CLOSE_MS } from './lib/runtime-drawer'
import type { CatalogRepositoryAnalysis, ManagedPlugin, PackPluginEntry, ProfileRepositoryImportMode, ProfileRepositoryImportPreview, RuntimeDrawerMode } from './types'
import { DiscoverView } from './views/DiscoverView'
import { PacksView } from './views/PacksView'
import { PluginsView } from './views/PluginsView'
import { GitHubView } from './views/GitHubView'
import { DshMarketView } from './views/DshMarketView'
import { RuntimeEnvironmentView } from './views/RuntimeEnvironmentView'

/**
 * 应用根。
 * 只做三件事：提供主进程 API、组装状态与视图、挂载对话框。
 * 业务逻辑在 hooks 里，展示逻辑在 components 与 views 里。
 */
export default function App() {
  const api = useMemo(() => resolveLauncherApi(), [])
  return (
    <LauncherApiProvider value={api}>
      <LauncherShell />
    </LauncherApiProvider>
  )
}

function LauncherShell() {
  const api = useLauncherApi()
  const store = useLauncherStore()
  const navigation = useNavigation(message => store.showToast({ kind: 'error', message }))
  // AI 可能改 profile（安装组件），任务结束时刷新一次；toast 复用 store 的唯一实例。
  const ai = useAiInstall(() => { void store.refreshProfile() }, store.showToast)
  const copilot = useCopilotSessions()
  // 整合包创建/导入是流式任务；结算后刷新包列表与快照状态。
  const packInstall = usePackInstall(() => {
    void store.refreshPacks()
    void store.refreshPackSnapshots()
  }, store.showToast)

  // 对话框开关是纯展示状态，不进 store。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [credentialOpen, setCredentialOpen] = useState(false)
  const [githubAccountOpen, setGitHubAccountOpen] = useState(false)
  const [createPackOpen, setCreatePackOpen] = useState(false)
  const [repositoryImportOpen, setRepositoryImportOpen] = useState(false)
  const [repositoryImportUrl, setRepositoryImportUrl] = useState('')
  const [repositoryImportPreview, setRepositoryImportPreview] = useState<ProfileRepositoryImportPreview | null>(null)
  const [repositoryImportBusy, setRepositoryImportBusy] = useState(false)
  const [repositoryImportError, setRepositoryImportError] = useState<string | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [copilotOpen, setCopilotOpen] = useState(false)
  const [runtimeDrawerMode, setRuntimeDrawerMode] = useState<RuntimeDrawerMode>('hidden')
  const [runtimeDrawerAutoOpened, setRuntimeDrawerAutoOpened] = useState(false)
  const [runtimeDrawerHeight, setRuntimeDrawerHeight] = useState(() => {
    try {
      const value = Number(localStorage.getItem('dsh-launcher:runtime-drawer-height'))
      return Number.isFinite(value) && value >= 180 && value <= 760 ? clampRuntimeDrawerHeight(value) : 260
    } catch {
      return 260
    }
  })
  const [copilotResizing, setCopilotResizing] = useState(false)
  const [copilotWidth, setCopilotWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem('dsh-launcher:copilot-width'))
      return Number.isFinite(value) && value >= 320 && value <= 720 ? value : 420
    } catch {
      return 420
    }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('dsh-launcher:sidebar-collapsed') === 'true'
    } catch {
      return false
    }
  })
  const [confirmingRemoval, setConfirmingRemoval] = useState<ManagedPlugin | null>(null)
  const managerVisited = useRef(false)
  const discoverVisited = useRef(false)
  const previousManagerViewRef = useRef(navigation.view)
  // 仓库结构检测结果由各视图发起，App 统一持有，避免切页后丢失。
  const [repositoryAnalyses, setRepositoryAnalyses] = useState<Record<string, CatalogRepositoryAnalysis>>({})

  useEffect(() => {
    document.documentElement.dataset.theme = store.settings?.uiTheme ?? 'forest'
  }, [store.settings?.uiTheme])

  const installingResource = isInstallProgressActive(store.installProgress)
  const installingDsh = store.busy === BUSY.dshInstall
    || (installingResource && store.installProgress?.kind === 'dsh')
  const installingApplication = installingResource && store.installProgress?.kind === 'application'
  // 安装会写入 Profile、Skill 或应用注册表；跨页时仍需阻止这些写操作。
  const profileMutationLocked = installingResource
  // The selector itself must not be latched by a stale install-progress event.
  // The main-process mutation guard remains authoritative while a real
  // installer is still active; only an in-flight Profile switch disables it.
  const profileSwitcherLocked = store.busy?.startsWith('profile-switch:') === true
  const runtimeBusy = store.busy === BUSY.runtime || installingResource || installingApplication || Boolean(store.busy?.startsWith('application'))
  const runtimeActivity = Boolean(store.runtime.running || isInstallProgressActive(store.installProgress))
  const latestRuntimeLog = store.logs.at(-1)
  const runtimeUpdateKey = [
    store.busy ?? '',
    store.runtime.running,
    store.runtime.pid ?? '',
    store.runtime.startedAt ?? '',
    store.runtime.url ?? '',
    store.runtime.port ?? '',
    store.runtime.applicationAddonName ?? '',
    store.runtime.launchMode ?? '',
    store.runtime.lastFailure?.failedAt ?? '',
    store.installProgress?.repository ?? '',
    store.installProgress?.phase ?? '',
    store.installProgress?.percent ?? '',
    store.installProgress?.message ?? '',
    store.installProgress?.downloadedBytes ?? '',
    store.installProgress?.totalBytes ?? '',
    store.logs.length,
    latestRuntimeLog?.timestamp ?? '',
  ].join('|')
  const runtimeActivityRef = useRef(false)
  const runtimeActivityInitializedRef = useRef(false)
  const runtimeLogRef = useRef<string | null>(null)
  const runtimeLogInitializedRef = useRef(false)

  const revealRuntimeDrawer = () => {
    if (runtimeDrawerMode === 'expanded') return
    if (runtimeDrawerMode === 'hidden') setRuntimeDrawerAutoOpened(true)
    setRuntimeDrawerMode(current => current === 'expanded' ? current : 'half')
  }

  const changeRuntimeDrawerMode = (mode: RuntimeDrawerMode) => {
    setRuntimeDrawerAutoOpened(false)
    setRuntimeDrawerMode(mode)
  }

  const cancelRuntimeDrawerAutoClose = () => {
    setRuntimeDrawerAutoOpened(false)
  }

  useEffect(() => {
    const previousView = previousManagerViewRef.current
    if (previousView !== navigation.view && runtimeDrawerMode === 'expanded') {
      setRuntimeDrawerMode('half')
      setRuntimeDrawerAutoOpened(false)
    }
    previousManagerViewRef.current = navigation.view
  }, [navigation.view, runtimeDrawerMode])

  useEffect(() => {
    if (store.loading) return
    if (!runtimeActivityInitializedRef.current) {
      runtimeActivityRef.current = runtimeActivity
      runtimeActivityInitializedRef.current = true
      return
    }
    if (runtimeActivity && !runtimeActivityRef.current) revealRuntimeDrawer()
    runtimeActivityRef.current = runtimeActivity
  }, [runtimeActivity, store.loading])

  // Some plugin operations stream directly to the terminal without creating an
  // InstallProgress record. Treat a new runtime log entry as activity as well.
  useEffect(() => {
    if (store.loading) return
    const timestamp = latestRuntimeLog?.timestamp ?? null
    if (!runtimeLogInitializedRef.current) {
      runtimeLogInitializedRef.current = true
      runtimeLogRef.current = timestamp
      return
    }
    if (timestamp && timestamp !== runtimeLogRef.current) revealRuntimeDrawer()
    runtimeLogRef.current = timestamp
  }, [latestRuntimeLog?.timestamp, store.loading])

  useEffect(() => {
    if (!runtimeDrawerAutoOpened || runtimeDrawerMode !== 'half') return
    const timer = window.setTimeout(() => {
      setRuntimeDrawerMode(current => current === 'half' ? 'hidden' : current)
      setRuntimeDrawerAutoOpened(false)
    }, RUNTIME_DRAWER_AUTO_CLOSE_MS)
    return () => window.clearTimeout(timer)
  }, [runtimeDrawerAutoOpened, runtimeDrawerMode, runtimeUpdateKey])

  const updateRuntimeDrawerHeight = (height: number) => {
    const next = clampRuntimeDrawerHeight(height)
    setRuntimeDrawerHeight(next)
    try {
      localStorage.setItem('dsh-launcher:runtime-drawer-height', String(next))
    } catch {
      // 高度只在本地可用时持久化。
    }
  }

  const toggleRuntime = async () => {
    if (await store.toggleRuntime() === 'started') revealRuntimeDrawer()
  }

  const openHarness = () => {
    if (store.runtime.url) void api.openExternal(store.runtime.url)
  }

  const closeWindow = () => void api.closeWindow()
  const minimizeWindow = () => void api.minimizeWindow()
  const toggleMaximizeWindow = () => void api.toggleMaximizeWindow()

  const openApiConfig = () => {
    setCredentialOpen(true)
    void store.refreshCustomApiProviders()
  }

  /** 「导入整合包」：选文件 → analyze 拿预览 → PackInstallDialog 展示 preview 态。 */
  const handlePackImport = async () => {
    const path = await api.pickPackFile()
    if (!path) return
    await packInstall.startImport(path)
  }

  const openRepositoryImport = () => {
    setRepositoryImportOpen(true)
    setRepositoryImportUrl('')
    setRepositoryImportPreview(null)
    setRepositoryImportError(null)
  }

  const analyzeRepositoryImport = async () => {
    setRepositoryImportBusy(true)
    setRepositoryImportError(null)
    try {
      setRepositoryImportPreview(await api.analyzeProfileRepository(repositoryImportUrl))
    } catch (error) {
      setRepositoryImportError(error instanceof Error ? error.message : String(error))
    } finally {
      setRepositoryImportBusy(false)
    }
  }

  const confirmRepositoryImport = async (mode: ProfileRepositoryImportMode, name?: string, overwrite?: boolean, resolutions?: Record<string, PackPluginEntry>) => {
    setRepositoryImportBusy(true)
    setRepositoryImportError(null)
    try {
      await api.importProfileRepository(repositoryImportUrl, { mode, name, overwrite, resolutions })
      await Promise.all([store.refreshProfiles(), store.refreshPacks(), store.refreshProfile()])
      setRepositoryImportOpen(false)
      store.showToast({ kind: 'success', message: '已创建新的 Profile，当前 Profile 未自动切换。' })
    } catch (error) {
      setRepositoryImportError(error instanceof Error ? error.message : String(error))
    } finally {
      setRepositoryImportBusy(false)
    }
  }

  if (store.loading || !store.settings || !store.profile) {
    return (
      <div className="app-loading">
        <div className="brand-mark"><Layers3 size={22} /></div>
        <LoaderCircle className="spin" size={22} />
        <span>正在读取 DSH 配置</span>
      </div>
    )
  }

  const { settings, profile } = store
  if (navigation.surface === 'manager') managerVisited.current = true
  if (navigation.surface === 'manager' && navigation.view === 'discover') discoverVisited.current = true

  return (
    <>
      <div
        className={`surface-stage surface-${navigation.surface}${navigation.transitionPhase === 'idle' ? '' : ` is-${navigation.transitionPhase}`}`}
        aria-busy={navigation.transitionPhase !== 'idle'}
      >
        <div className={`surface-host launcher-surface-host ${navigation.surface === 'launcher' ? '' : 'view-hidden'}`}>
          <LauncherHome
            settings={settings}
            profile={profile}
            runtime={store.runtime}
            dshInstallation={store.dshInstallation}
            dshUpdate={store.dshUpdate}
            installProgress={store.installProgress?.repository === DSH_REPOSITORY ? store.installProgress : null}
            busy={runtimeBusy}
            packs={store.packs}
            profiles={store.profiles}
            activePackId={settings.activePackId}
            profileSwitcherDisabled={profileSwitcherLocked}
            installingDsh={installingDsh}
            onCredential={openApiConfig}
            githubAuthStatus={store.githubAuthStatus}
            activeRuntimeReplacement={store.activeRuntimeReplacement}
            onGitHubAccount={() => setGitHubAccountOpen(true)}
            onManage={navigation.showManager}
            onPackChange={packId => {
              void (packId ? store.activatePack(packId) : store.deactivatePack())
            }}
            onProfileChange={profileName => { void store.switchProfile(profileName) }}
            onToggleRuntime={toggleRuntime}
            onUpdateDsh={() => { void store.updateDsh() }}
            onOpenHarness={openHarness}
            onMinimize={minimizeWindow}
            onToggleMaximize={toggleMaximizeWindow}
            onClose={closeWindow}
          />
        </div>
        {managerVisited.current && (
          <div className={`surface-host manager-surface-host ${navigation.surface === 'manager' ? '' : 'view-hidden'}`}>
          <div className="app-shell">
          <AppHeader
            runtime={store.runtime}
            busy={runtimeBusy}
            dshInstalled={store.dshInstallation.installed || store.activeRuntimeReplacement !== null}
            installingDsh={installingDsh}
            profileName={settings.profileName}
            credentialStatus={store.credentialStatus}
            customApiCount={store.customApiProviders.length}
            githubAuthStatus={store.githubAuthStatus}
            activeRuntimeReplacement={store.activeRuntimeReplacement}
            launcherUpdate={store.launcherUpdate}
            // 启动项管理的顶栏作为所有管理标签页的统一工作区壳层。
            showPackSwitcher={true}
            packs={store.packs}
            profiles={store.profiles}
            activePackId={settings.activePackId}
            packSwitcherDisabled={profileSwitcherLocked}
            profileActiveCount={profile.activeBundles.length}
            profileDisabledCount={profile.disabledCount}
            installedSkillCount={store.installedSkills.length}
            profileDirectory={profile.profileDir}
            onCredential={openApiConfig}
            onGitHubAccount={() => setGitHubAccountOpen(true)}
            onToggleRuntime={toggleRuntime}
            onUpdate={() => setUpdateOpen(true)}
            onPackChange={packId => {
              void (packId ? store.activatePack(packId) : store.deactivatePack())
            }}
            onProfileChange={profileName => { void store.switchProfile(profileName) }}
            onOpenProfileDirectory={() => { void api.openPath(profile.profileDir) }}
            onMinimize={minimizeWindow}
            onToggleMaximize={toggleMaximizeWindow}
            onClose={closeWindow}
          />
          <div className={`app-body ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${copilotOpen ? 'copilot-open' : ''} ${copilotResizing ? 'copilot-resizing' : ''}`} style={{ '--copilot-width': `${copilotWidth}px` } as CSSProperties}>
            <SideNavigation
              view={navigation.view}
              profile={profile}
              runtime={store.runtime}
              profileName={settings.profileName}
            packs={store.packs}
            profiles={store.profiles}
            activePackId={settings.activePackId}
              collapsed={sidebarCollapsed}
              profileMutationLocked={profileSwitcherLocked}
            onPackChange={packId => {
              void (packId ? store.activatePack(packId) : store.deactivatePack())
            }}
            onProfileChange={profileName => { void store.switchProfile(profileName) }}
              onToggleCollapsed={() => {
                setSidebarCollapsed(current => {
                  const next = !current
                  try {
                    localStorage.setItem('dsh-launcher:sidebar-collapsed', String(next))
                  } catch {
                    // The UI state can remain session-only when storage is unavailable.
                  }
                  return next
                })
              }}
              onSettings={() => setSettingsOpen(true)}
              onChange={navigation.setView}
            />
            <main className="workspace">
              <div className="workspace-content">
              {navigation.view === 'plugins' && (
                <PluginsView
                  profile={profile}
                  profileName={settings.profileName}
                  installedSkills={store.installedSkills}
                  installedApplications={store.installedApplications}
                  installedPresets={store.installedPresets}
                  pluginTrials={store.pluginTrials}
                  selected={store.selected}
                  busy={store.busy}
                  profileLocked={profileMutationLocked}
                  settings={settings}
                  runtime={store.runtime}
                  activeRuntimeReplacement={store.activeRuntimeReplacement}
                  runtimeBusy={runtimeBusy}
                  onSelect={plugin => store.selectPlugin(plugin.packageName)}
                  onToggle={store.togglePlugin}
                  onToggleSkill={store.toggleSkill}
                  onToggleApplication={store.toggleApplication}
                  onUninstallApplication={store.uninstallApplication}
                  onTogglePreset={store.togglePreset}
                  onReorder={store.reorderPlugins}
                  onRefresh={store.refreshProfile}
                  onBrowse={() => navigation.setView('discover')}
                  onOpenRepository={url => void api.openExternal(url)}
                  onToggleRuntime={toggleRuntime}
                  onOpenHarness={openHarness}
                  onOpenRuntimeSettings={() => changeRuntimeDrawerMode('expanded')}
                  onUninstall={setConfirmingRemoval}
                  onTrialPlugin={(packageName, profileName) => { void store.trialPlugin(packageName, profileName) }}
                  onAdaptPlugin={(packageName, profileName) => { setCopilotOpen(true); void ai.adaptPlugin(packageName, profileName) }}
                  aiActive={ai.active}
                  aiSubject={ai.status.subject}
                />
              )}
              {discoverVisited.current && <div className={navigation.view === 'discover' ? undefined : 'view-hidden'}>
                <DiscoverView
                  profile={profile}
                  analyses={repositoryAnalyses}
                  installProgress={store.installProgress}
                  installedRepositories={store.installedRepositories}
                  installedSkills={store.installedSkills}
                  installedApplications={store.installedApplications}
                  installedPresets={store.installedPresets}
                  pluginTrials={store.pluginTrials}
                  onAnalysis={(repository, analysis) => {
                    setRepositoryAnalyses(current => ({ ...current, [repository]: analysis }))
                  }}
                  onInstallationState={store.adoptCatalogInstallationState}
                  onInstallStarted={store.beginInstall}
                  onInstallFinished={store.finishInstall}
                  onPluginInstalled={(repository, result) => {
                    store.applyCatalogPluginInstall(repository, result)
                    store.showToast({
                      kind: 'success',
                      message: result.kind === 'dsh'
                        ? `本地 DSH ${result.dshInstallation.version ?? ''} 已安装。`
                        : `${result.packageName ?? '插件'} 已安装到 ${result.installedProfileName ?? settings.profileName} Profile。`,
                    })
                  }}
                  onSkillInstalled={result => {
                    store.applyCatalogSkillInstall(result)
                    store.showToast({ kind: 'success', message: `${result.installedSkill.name} 已安装到本地 Skill 目录。` })
                  }}
                  onApplicationInstalled={result => {
                    store.applyCatalogApplicationInstall(result)
                    store.showToast({
                      kind: 'success',
                      message: `${result.installedAddon.name} 已作为应用加载项安装${result.installedAddon.enabled ? '并激活' : ''}。`,
                    })
                  }}
                  onPresetInstalled={result => {
                    store.applyCatalogPresetInstall(result)
                    store.showToast({ kind: 'success', message: `Agent 预设 ${result.installedPreset.name} 已安装到 DSH 预设目录。` })
                  }}
                  onError={message => store.showToast({ kind: 'error', message })}
                  onOpenRepository={url => void api.openExternal(url)}
                  onAiInstall={repo => { setCopilotOpen(true); void ai.start(repo.fullName, repo.defaultBranch) }}
                  onTrialPlugin={(packageName, profileName) => { void store.trialPlugin(packageName, profileName) }}
                  onAdaptPlugin={(packageName, profileName) => { setCopilotOpen(true); void ai.adaptPlugin(packageName, profileName) }}
                  aiRepository={ai.active ? ai.status.repository : null}
                  aiSubject={ai.active ? ai.status.subject : null}
                  aiActive={ai.active}
                />
              </div>}
              {navigation.view === 'dsh-market' && <DshMarketView onProfileChanged={store.refreshProfile} />}
              {navigation.view === 'environment' && (
                <RuntimeEnvironmentView
                  state={store.runtimeEnvironment}
                  busy={profileMutationLocked || Boolean(store.busy)}
                  onRefresh={() => { void store.refreshRuntimeEnvironment(true) }}
                  onInstallDsh={store.installDshVersion}
                  onSelectDsh={store.selectDshVersion}
                  onRemoveDsh={store.removeDshVersion}
                  onInstallNode={store.installNodeVersion}
                  onSelectNode={store.selectNodeVersion}
                  onRemoveNode={store.removeNodeVersion}
                  onOpenDshFolder={() => { void api.openDshFolder() }}
                  onOpenNodeFolder={() => { void api.openNodeFolder() }}
                />
              )}
              {navigation.view === 'packs' && (
                <PacksView
                  packs={store.packs}
                  profiles={store.profiles}
                  profile={profile}
                  busy={profileMutationLocked ? 'profile-write-lock' : store.busy}
                  onRefresh={() => { void store.refreshPacks(); void store.refreshPackSnapshots() }}
                  onCreate={() => setCreatePackOpen(true)}
                  onImport={() => void handlePackImport()}
                  onImportRepository={openRepositoryImport}
                  onActivate={packId => void store.activatePack(packId)}
                  onDeactivate={() => void store.deactivatePack()}
                  onSwitchProfile={profileName => { void store.switchProfile(profileName) }}
                  onCreateProfile={(name, cloneFrom) => { void (cloneFrom ? store.cloneProfile(cloneFrom, name) : store.createProfile({ name })) }}
                  onDeleteProfile={profileName => { if (window.confirm(`确定删除 Profile「${profileName}」吗？`)) void store.deleteProfile(profileName) }}
                  onExport={packId => void store.exportPack(packId)}
                  onExportProfile={(profileName, mode) => { void store.exportProfile(profileName, mode) }}
                  onRemove={packId => void store.removePack(packId)}
                  onAddPlugin={(packId, packageName) => void store.addPackPlugin(packId, packageName)}
                  onAddPreset={(packId, presetName) => void store.addPackPreset(packId, presetName)}
                  onAddSkill={(packId, skillName) => void store.addPackSkill(packId, skillName)}
                  onAddApplication={(packId, addonId) => void store.addPackApplication(packId, addonId)}
                  onToggleItem={(packId, packageName, enabled) => void store.togglePackItem(packId, packageName, enabled)}
                  onTogglePreset={(packId, presetName, enabled) => void store.togglePackPreset(packId, presetName, enabled)}
                  onToggleSkill={(packId, skillName, enabled) => void store.togglePackSkill(packId, skillName, enabled)}
                  onToggleApplication={(packId, addonId, enabled) => void store.togglePackApplication(packId, addonId, enabled)}
                  onRemoveItem={(packId, packageName) => void store.removePackItem(packId, packageName)}
                  onRemovePreset={(packId, presetName) => void store.removePackPreset(packId, presetName)}
                  onRemoveSkill={(packId, skillName) => void store.removePackSkill(packId, skillName)}
                  onRemoveApplication={(packId, addonId) => void store.removePackApplication(packId, addonId)}
                  installedPresets={store.installedPresets}
                  installedSkills={store.installedSkills}
                  installedApplications={store.installedApplications}
                />
              )}
              {navigation.view === 'github' && (
                <GitHubView
                  authStatus={store.githubAuthStatus}
                  onLogin={() => setGitHubAccountOpen(true)}
                  onOpen={url => void api.openExternal(url)}
                  onError={message => store.showToast({ kind: 'error', message })}
                />
              )}
              </div>
              <RuntimeDrawer
                mode={runtimeDrawerMode}
                height={runtimeDrawerHeight}
                onModeChange={changeRuntimeDrawerMode}
                onHeightChange={updateRuntimeDrawerHeight}
                onUserInteraction={cancelRuntimeDrawerAutoClose}
                runtime={store.runtime}
                settings={settings}
                logs={store.logs}
                installProgress={store.installProgress}
                busy={runtimeBusy}
                onToggleRuntime={toggleRuntime}
                onPauseDownload={() => { void store.cancelRuntimeDownload() }}
                onOpenHarness={openHarness}
                onClearLogs={store.clearLogs}
                onRepairRuntime={() => { setCopilotOpen(true); void ai.repairRuntime(settings.profileName) }}
                aiActive={ai.active}
                activeRuntimeReplacement={store.activeRuntimeReplacement}
              />
            </main>
            <DSHCopilotPanel
              state={copilot}
              legacyAi={ai}
              onLegacyApprove={ai.approve}
              onLegacyCancel={ai.cancel}
              onLegacyRollback={() => { void ai.rollback() }}
              open={copilotOpen}
              width={copilotWidth}
              onResizeStateChange={setCopilotResizing}
              onWidthChange={width => {
                const next = Math.max(320, Math.min(720, width))
                setCopilotWidth(next)
                try { localStorage.setItem('dsh-launcher:copilot-width', String(next)) } catch { /* storage is optional */ }
              }}
            />
            <div className="manager-edge-actions" aria-label="管理界面快捷操作">
              <button className={`icon-button copilot-toggle ${copilotOpen ? 'active' : ''} ${ai.active || copilot.sessions.some(session => ['queued', 'preparing', 'running'].includes(session.phase)) ? 'busy' : ''}`} type="button" title={copilotOpen ? '收起 DSH Copilot' : '打开 DSH Copilot'} aria-label={copilotOpen ? '收起 DSH Copilot' : '打开 DSH Copilot'} onClick={() => setCopilotOpen(current => !current)}>
                <PanelRight size={19} />
                {(ai.active || copilot.sessions.some(session => ['queued', 'preparing', 'running'].includes(session.phase))) && <span className="copilot-toggle-dot" />}
              </button>
            </div>
          </div>
          </div>
          <button className="icon-button manager-back" type="button" title="返回启动页" aria-label="返回启动页" onClick={navigation.showLauncher}>
            <svg className="manager-corner-mark" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
              <path d="M36 0V29.5A6.5 6.5 0 0 1 29.5 36H0Z" />
            </svg>
          </button>
          </div>
        )}
      </div>

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          busy={store.busy === BUSY.settings || profileMutationLocked}
          onClose={() => setSettingsOpen(false)}
          onSave={async next => { if (await store.saveSettings(next)) setSettingsOpen(false) }}
        />
      )}
      {credentialOpen && (
        <CredentialDialog
          status={store.credentialStatus}
          providers={store.customApiProviders}
          loading={store.customApiLoading}
          busy={store.busy === BUSY.credential}
          onClose={() => setCredentialOpen(false)}
          onSaveDeepSeek={store.saveApiKey}
          onClearDeepSeek={store.clearApiKey}
          onSaveCustom={store.saveCustomApi}
          onRemoveCustom={store.removeCustomApi}
        />
      )}
      {githubAccountOpen && (
        <GitHubAccountDialog
          status={store.githubAuthStatus}
          onStatus={store.setGitHubAuthStatus}
          onClose={() => setGitHubAccountOpen(false)}
          onMessage={(kind, message) => store.showToast({ kind, message })}
        />
      )}
      {confirmingRemoval && (
        <ConfirmDialog
          plugin={confirmingRemoval}
          onCancel={() => setConfirmingRemoval(null)}
          onConfirm={() => {
            const plugin = confirmingRemoval
            setConfirmingRemoval(null)
            void store.uninstallPlugin(plugin)
          }}
        />
      )}
      {createPackOpen && packInstall.phase === 'idle' && (
        <CreatePackDialog
          plugins={profile.plugins}
          presets={store.installedPresets}
          skills={store.installedSkills}
          applications={store.installedApplications}
          onClose={() => setCreatePackOpen(false)}
          onConfirm={request => {
            setCreatePackOpen(false)
            void packInstall.startCreate(
              request.name,
              request.description,
              request.packageNames,
              request.presetNames,
              request.skillNames,
              request.applicationIds,
            )
          }}
        />
      )}
      {packInstall.phase !== 'idle' && (
        <PackInstallDialog
          phase={packInstall.phase}
          events={packInstall.events}
          result={packInstall.result}
          error={packInstall.error}
          analysis={packInstall.analysis}
          itemProgress={packInstall.itemProgress}
          hasSnapshot={packInstall.hasSnapshot}
          packSnapshotsAvailable={store.packSnapshotsAvailable}
          busy={store.busy !== null || packInstall.busy !== null}
          onConfirmImport={(items, name) => void packInstall.confirmImport(packInstall.importPath ?? '', items, name)}
          onRollback={() => void packInstall.rollback()}
          onActivate={packId => {
            void (async () => {
              if (await store.activatePack(packId)) packInstall.reset()
            })()
          }}
          onClose={packInstall.reset}
        />
      )}
      <ProfileRepositoryImportDialog
        open={repositoryImportOpen}
        url={repositoryImportUrl}
        preview={repositoryImportPreview}
        busy={repositoryImportBusy}
        error={repositoryImportError}
        onUrlChange={value => { setRepositoryImportUrl(value); setRepositoryImportPreview(null); setRepositoryImportError(null) }}
        onAnalyze={() => void analyzeRepositoryImport()}
        onConfirm={(mode, name, overwrite) => void confirmRepositoryImport(mode, name, overwrite)}
        onClose={() => { if (!repositoryImportBusy) setRepositoryImportOpen(false) }}
      />
      {updateOpen && store.launcherUpdate && (
        <UpdateDialog
          status={store.launcherUpdate}
          progress={store.launcherUpdateProgress}
          busy={store.busy === 'launcher-update-download' || store.busy === 'launcher-update-apply'}
          onDownload={() => { void store.downloadLauncherUpdate() }}
          onApply={() => { void store.applyLauncherUpdate() }}
          onClose={() => setUpdateOpen(false)}
        />
      )}
      {store.toast && <Toast toast={store.toast} onClose={store.dismissToast} />}
    </>
  )
}
