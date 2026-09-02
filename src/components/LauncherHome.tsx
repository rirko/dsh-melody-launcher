import { AppWindow, Box, CircleStop, Download, ExternalLink, LoaderCircle, Minus, Play, Settings, Wrench, X } from 'lucide-react'
import packageMetadata from '../../package.json'
import type { DshInstallationStatus, InstallProgress, InstalledApplicationAddon, PackStatus, ProfileState, ProfileSummary, RuntimeState } from '../types'

/** 启动页：无边框小窗口，只暴露最少的几个动作。 */

interface LauncherHomeProps {
  profile: ProfileState
  profileName: string
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  installProgress: InstallProgress | null
  busy: boolean
  packs: PackStatus[]
  profiles: ProfileSummary[]
  activePackId: string | null | undefined
  profileSwitcherDisabled: boolean
  installingDsh: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  onManage: () => void
  onOpenSettings: () => void
  onPackChange: (packId: string) => void
  onProfileChange: (profileName: string) => void
  onToggleRuntime: () => void
  onOpenHarness: () => void
  onMinimize: () => void
  onClose: () => void
}

export function LauncherHome({
  profile,
  profileName,
  runtime,
  dshInstallation,
  installProgress,
  busy,
  packs,
  profiles,
  activePackId,
  profileSwitcherDisabled,
  installingDsh,
  activeRuntimeReplacement,
  onManage,
  onOpenSettings,
  onPackChange,
  onProfileChange,
  onToggleRuntime,
  onOpenHarness,
  onMinimize,
  onClose,
}: LauncherHomeProps) {
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement
  const profileSelection = profiles.length > 0 ? profileName : (activePackId ?? '')
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
      <button className="launcher-window-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
        <X size={18} />
      </button>

      <main className="launcher-stage">
        <section className="launcher-brand">
          <img className="launcher-logo" src="/launcher-logo.png" alt="" width={56} height={56} draggable={false} />
          <div className="launcher-brand-copy">
            <h1>DeepSeek Harness Launcher</h1>
            <p className="launcher-brand-summary">{activeRuntimeReplacement ? `${activeRuntimeReplacement.name} 已激活` : needsInstallation ? '首次部署准备' : `本地 DSH ${dshInstallation.version ?? ''}`} · {profile.activeBundles.length} 个加载层</p>
          </div>
        </section>

        <div className="launcher-controls">
          <div className="launcher-runtime-state">
            <span className={`launcher-state-dot ${runtime.running ? 'running' : ''}`} />
            <div><small>运行状态</small><strong>{runtimeLabel}</strong></div>
            {runtime.url && (
              <button type="button" className="launcher-open-button" onClick={onOpenHarness}>打开网页<ExternalLink size={13} /></button>
            )}
          </div>

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

          <div className="launcher-utility-row">
            <button type="button" className="launcher-utility-button" onClick={onOpenSettings} title="版本、插件、技能与整合包"><Settings size={16} /><span>启动设置</span></button>
            <button type="button" className="launcher-utility-button" onClick={onManage} title="资源市场 / GitHub / 运行环境"><Wrench size={16} /><span>开发人员选项</span></button>
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
          </div>
        </div>
      </main>

      <footer className="launcher-footer">
        <span>DSH Launcher {packageMetadata.version}</span>
        <span>官方用户QQ群：625155044</span>
      </footer>
    </div>
  )
}
