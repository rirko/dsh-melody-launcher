import { AppWindow, ChevronRight, CircleStop, Download, Folder, KeyRound, Layers3, LoaderCircle, Maximize2, Minus, Package, Play, X } from 'lucide-react'
import type { CredentialStatus, GitHubAuthStatus, InstalledApplicationAddon, LauncherUpdateStatus, PackStatus, ProfileSummary, RuntimeState } from '../types'

/** 管理界面顶栏：品牌、当前配置与运行状态、全局动作。 */

interface AppHeaderProps {
  runtime: RuntimeState
  busy: boolean
  dshInstalled: boolean
  installingDsh: boolean
  profileName: string
  credentialStatus: CredentialStatus
  customApiCount: number
  githubAuthStatus: GitHubAuthStatus
  activeRuntimeReplacement: InstalledApplicationAddon | null
  launcherUpdate: LauncherUpdateStatus | null
  showPackSwitcher: boolean
  packs: PackStatus[]
  profiles?: ProfileSummary[]
  activePackId: string | null | undefined
  packSwitcherDisabled: boolean
  profileActiveCount: number
  profileDisabledCount: number
  installedSkillCount: number
  profileDirectory: string
  onCredential: () => void
  onGitHubAccount: () => void
  onToggleRuntime: () => void
  onUpdate: () => void
  onPackChange: (packId: string) => void
  onProfileChange?: (profileName: string) => void
  onOpenProfileDirectory: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

export function AppHeader({
  runtime,
  busy,
  dshInstalled,
  installingDsh,
  profileName,
  credentialStatus,
  customApiCount,
  githubAuthStatus,
  activeRuntimeReplacement,
  launcherUpdate,
  showPackSwitcher,
  packs,
  profiles = [],
  activePackId,
  packSwitcherDisabled,
  profileActiveCount,
  profileDisabledCount,
  installedSkillCount,
  profileDirectory,
  onCredential,
  onGitHubAccount,
  onToggleRuntime,
  onUpdate,
  onPackChange,
  onProfileChange,
  onOpenProfileDirectory,
  onMinimize,
  onToggleMaximize,
  onClose,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand-block">
        {githubAuthStatus.authenticated && githubAuthStatus.avatarUrl
          ? <img className="brand-avatar" src={githubAuthStatus.avatarUrl} alt="" />
          : <div className="brand-mark"><Layers3 size={21} strokeWidth={2.2} /></div>}
        <div>
          <button
            className={`brand-github-link ${githubAuthStatus.authenticated ? 'configured' : ''}`}
            type="button"
            title={githubAuthStatus.authenticated ? `GitHub：${githubAuthStatus.login ?? ''}` : '登录 GitHub'}
            onClick={onGitHubAccount}
          >
            {githubAuthStatus.authenticated ? githubAuthStatus.login : '点击登录 GitHub'}
          </button>
          <div className="brand-subtitle">DeepSeek Harness 管理器</div>
        </div>
      </div>
      <div className="header-center">
        {showPackSwitcher ? (
          <div className="header-management-context">
            <button
              className={`credential-button header-api-button ${credentialStatus.configured || customApiCount > 0 ? 'configured' : ''}`}
              type="button"
              title="配置 DeepSeek 与自定义模型 API"
              onClick={onCredential}
            >
              <KeyRound size={17} />
              <span>API 配置</span>
              <span className="credential-state">{customApiCount > 0 ? `${customApiCount} 个自定义` : credentialStatus.configured ? '已配置' : '未配置'}</span>
            </button>
            <label className="header-pack-switcher">
              <Package size={16} />
              <span>Profile / 整合包</span>
              <select
                aria-label="切换 Profile"
                value={profiles.length > 0 ? profileName : (activePackId ?? '')}
                disabled={packSwitcherDisabled}
                onChange={event => profiles.length > 0 && onProfileChange ? onProfileChange(event.target.value) : onPackChange(event.target.value)}
              >
                {profiles.length > 0
                  ? profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)
                  : <option value="">默认配置</option>}
                {profiles.length === 0 && packs.map(pack => <option key={pack.id} value={pack.id}>{pack.name}</option>)}
              </select>
            </label>
            <div className="header-management-stats" aria-label="配置概况">
              <span><strong>{profileActiveCount}</strong> 激活</span>
              <span><strong>{profileDisabledCount}</strong> 停用</span>
              <span><strong>{installedSkillCount}</strong> Skill</span>
              <button type="button" onClick={onOpenProfileDirectory} title={profileDirectory} aria-label="打开配置目录"><Folder size={15} /></button>
            </div>
            {runtime.running && <div className="header-runtime-status" title={`${runtime.applicationAddonName ?? 'DSH'} 运行中 · PID ${runtime.pid}`}>
              <span className={`status-dot ${runtime.running ? 'running' : ''}`} />
              <span>运行中</span>
            </div>}
          </div>
        ) : (
          <div className="header-context">
            <span className="context-label">配置</span>
            <strong>{profileName}</strong>
            {runtime.running && <>
              <ChevronRight size={14} />
              <span className="status-dot running" />
              <span>{`${runtime.applicationAddonName ?? 'DSH'} 运行中 · PID ${runtime.pid}`}</span>
            </>}
          </div>
        )}
      </div>
      <div className="header-actions">
        {!showPackSwitcher && <button
          className={`credential-button ${credentialStatus.configured || customApiCount > 0 ? 'configured' : ''}`}
          type="button"
          title="配置 DeepSeek 与自定义模型 API"
          onClick={onCredential}
        >
          <KeyRound size={17} />
          <span>API 配置</span>
          <span className="credential-state">{customApiCount > 0 ? `${customApiCount} 个自定义` : credentialStatus.configured ? '已配置' : '未配置'}</span>
        </button>}
        {launcherUpdate && (launcherUpdate.state === 'update-available' || launcherUpdate.state === 'downloading' || launcherUpdate.state === 'downloaded') && (
          <button
            className={`launcher-update-button ${launcherUpdate.state === 'downloaded' ? 'ready' : ''}`}
            type="button"
            title={`发现新版本 ${launcherUpdate.remoteVersion ?? ''}`}
            onClick={onUpdate}
          >
            {launcherUpdate.state === 'downloading'
              ? <LoaderCircle className="spin" size={17} />
              : <Download size={17} />}
            <span>{launcherUpdate.state === 'downloaded' ? '立即更新' : `更新 v${launcherUpdate.remoteVersion ?? ''}`}</span>
          </button>
        )}
        <button className={`primary-command ${runtime.running ? 'stop' : ''}`} type="button" onClick={onToggleRuntime} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={18} /> : runtime.running ? <CircleStop size={18} /> : activeRuntimeReplacement ? <AppWindow size={18} /> : dshInstalled ? <Play size={18} fill="currentColor" /> : <Download size={18} />}
          <span>{runtime.running ? `停止 ${runtime.applicationAddonName ?? 'DSH'}` : installingDsh ? '安装中' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : dshInstalled ? '启动 DSH' : '安装 DSH'}</span>
        </button>
        <button className="manager-window-button" type="button" title="最小化" aria-label="最小化" onClick={onMinimize}>
          <Minus size={17} />
        </button>
        <button className="manager-window-button" type="button" title="最大化或还原" aria-label="最大化或还原" onClick={onToggleMaximize}>
          <Maximize2 size={15} />
        </button>
        <button className="manager-window-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
    </header>
  )
}
