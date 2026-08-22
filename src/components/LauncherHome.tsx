import { AppWindow, Box, CircleStop, Download, ExternalLink, GitFork, KeyRound, LoaderCircle, Maximize2, Minus, Play, RefreshCw, Settings, X } from 'lucide-react'
import packageMetadata from '../../package.json'
import type { AppSettings, DshInstallationStatus, DshUpdateStatus, GitHubAuthStatus, InstallProgress, InstalledApplicationAddon, PackStatus, ProfileState, ProfileSummary, RuntimeState } from '../types'

/** 启动页：无边框小窗口，只暴露最少的几个动作。 */

interface LauncherHomeProps {
  settings: AppSettings
  profile: ProfileState
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  dshUpdate: DshUpdateStatus | null
  installProgress: InstallProgress | null
  busy: boolean
  packs: PackStatus[]
  profiles: ProfileSummary[]
  activePackId: string | null | undefined
  profileSwitcherDisabled: boolean
  installingDsh: boolean
  githubAuthStatus: GitHubAuthStatus
  activeRuntimeReplacement: InstalledApplicationAddon | null
  onCredential: () => void
  onGitHubAccount: () => void
  onManage: () => void
  onPackChange: (packId: string) => void
  onProfileChange: (profileName: string) => void
  onToggleRuntime: () => void
  onUpdateDsh: () => void
  onOpenHarness: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

export function LauncherHome({
  settings,
  profile,
  runtime,
  dshInstallation,
  dshUpdate,
  installProgress,
  busy,
  packs,
  profiles,
  activePackId,
  profileSwitcherDisabled,
  installingDsh,
  githubAuthStatus,
  activeRuntimeReplacement,
  onCredential,
  onGitHubAccount,
  onManage,
  onPackChange,
  onProfileChange,
  onToggleRuntime,
  onUpdateDsh,
  onOpenHarness,
  onMinimize,
  onToggleMaximize,
  onClose,
}: LauncherHomeProps) {
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement
  const profileSelection = profiles.length > 0 ? settings.profileName : (activePackId ?? '')
  const runtimeLabel = busy
    ? installingDsh ? '正在安装' : runtime.running ? '正在停止' : '正在启动'
    : runtime.running ? runtime.url ? '已就绪' : '正在启动'
      : needsInstallation ? '尚未安装' : '等待启动'

  return (
    <div className="launcher-home">
      <div className="launcher-drag-region" aria-hidden="true" />
      <button className="launcher-window-button minimize" type="button" title="最小化" aria-label="最小化" onClick={onMinimize}>
        <Minus size={17} />
      </button>
      <button className="launcher-window-button maximize" type="button" title="最大化或还原" aria-label="最大化或还原" onClick={onToggleMaximize}>
        <Maximize2 size={15} />
      </button>
      <button className="launcher-window-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
        <X size={18} />
      </button>

      <main className="launcher-stage">
        <div className="launcher-title-block">
          <span className="launcher-kicker">LOCAL AI WORKSPACE</span>
          <h1>DeepSeek Harness</h1>
          <p>{activeRuntimeReplacement ? `${activeRuntimeReplacement.name} 已激活` : needsInstallation ? '首次部署准备' : `本地 DSH ${dshInstallation.version ?? ''}`} · {profile.activeBundles.length} 个加载层</p>
          {dshUpdate?.state === 'update-available' && (
            <div className="launcher-update-notice" role="status">
              <RefreshCw size={14} />
              <span><strong>发现新版本 {dshUpdate.remoteVersion}</strong><small>本地 {dshUpdate.localVersion}，可以更新</small></span>
              <button type="button" onClick={onUpdateDsh} disabled={busy} title="更新 DSH">更新</button>
            </div>
          )}
        </div>

        <div className="launcher-controls">
          <div className="launcher-runtime-state">
            <span className={`launcher-state-dot ${runtime.running ? 'running' : ''}`} />
            <div><small>运行状态</small><strong>{runtimeLabel}</strong></div>
            <span>{runtime.running && runtime.pid ? `PID ${runtime.pid}${runtime.port ? ` · :${runtime.port}` : ''}` : settings.profileName}</span>
          </div>

          <div className="launcher-action-grid">
            <button
              type="button"
              className={`launcher-start-button ${runtime.running ? 'stop' : ''}`}
              onClick={onToggleRuntime}
              disabled={busy}
            >
              {busy ? <LoaderCircle className="spin" size={24} /> : runtime.running ? <CircleStop size={24} /> : needsInstallation ? <Download size={24} /> : <Play size={25} fill="currentColor" />}
              <span>
                <small>{installingDsh ? installProgress?.message ?? '正在准备本地 DSH' : runtime.running ? '结束本地服务' : needsInstallation ? '首次使用需要完成本地部署' : activeRuntimeReplacement ? '由应用加载项托管 DSH' : '启动本地工作台'}</small>
                <strong>{runtime.running ? `停止 ${runtime.applicationAddonName ?? 'DSH'}` : installingDsh ? installProgress?.indeterminate ? '安装进行中' : `安装 DSH ${installProgress?.percent ?? 0}%` : needsInstallation ? '下载安装 DSH' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : '启动 DSH'}</strong>
              </span>
            </button>
            <button type="button" className="launcher-utility-button" onClick={onManage}><Settings size={17} /><span>管理</span></button>
            <div className="launcher-utility-pair">
              <button type="button" className="launcher-utility-button" onClick={onCredential} title="配置 DeepSeek 与自定义模型 API"><KeyRound size={17} /><span>API 配置</span></button>
              <button type="button" className={`launcher-utility-button ${githubAuthStatus.authenticated ? 'configured' : ''}`} onClick={onGitHubAccount} title={githubAuthStatus.authenticated ? `GitHub：${githubAuthStatus.login}` : '登录 GitHub'}><GitFork size={17} /><span>{githubAuthStatus.authenticated ? githubAuthStatus.login : 'GitHub'}</span></button>
            </div>
          </div>

          <div className="launcher-profile-row">
            <span>启动配置</span>
            <label className="launcher-profile-select">
              {activeRuntimeReplacement ? <AppWindow size={15} /> : <Box size={15} />}
              <select
                aria-label="启动配置"
                value={profileSelection}
                disabled={profileSwitcherDisabled}
                onChange={event => profiles.length > 0 ? onProfileChange(event.target.value) : onPackChange(event.target.value)}
              >
                {profiles.length > 0
                  ? profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)
                  : <option value="">默认配置</option>}
                {profiles.length === 0 && packs.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
              </select>
            </label>
            {runtime.url ? (
              <button type="button" className="launcher-open-button" onClick={onOpenHarness}>打开 Harness<ExternalLink size={13} /></button>
            ) : (
              <span className="launcher-runtime-source">{activeRuntimeReplacement ? '替代 Web 启动' : needsInstallation ? '等待部署' : dshInstallation.source === 'system' ? '系统安装' : '启动器安装'}</span>
            )}
          </div>
        </div>
      </main>

      <footer className="launcher-footer">
        <span>DSH Launcher {packageMetadata.version}</span>
        <span>{profile.initialized ? `${profile.plugins.length} 个插件` : 'Profile 等待初始化'}</span>
      </footer>
    </div>
  )
}
