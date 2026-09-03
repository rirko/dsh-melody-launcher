import { Download, ExternalLink, LoaderCircle, Minus, Play, Settings, Wrench, X } from 'lucide-react'
import packageMetadata from '../../package.json'
import type { DshInstallationStatus, InstallProgress, InstalledApplicationAddon, ProfileState, RuntimeState } from '../types'

/** 启动页：左右分栏——左侧品牌栏（像素头像 + 状态胶囊），右侧收窄居中的操作区。 */

interface LauncherHomeProps {
  profile: ProfileState
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  installProgress: InstallProgress | null
  busy: boolean
  installingDsh: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  onManage: () => void
  onOpenSettings: () => void
  onToggleRuntime: () => void
  onOpenHarness: () => void
  onMinimize: () => void
  onClose: () => void
}

/** 从运行地址提取 host:port，用于状态胶囊展示。 */
function formatAddress(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host
  } catch {
    return url
  }
}

export function LauncherHome({
  profile,
  runtime,
  dshInstallation,
  installProgress,
  busy,
  installingDsh,
  activeRuntimeReplacement,
  onManage,
  onOpenSettings,
  onToggleRuntime,
  onOpenHarness,
  onMinimize,
  onClose,
}: LauncherHomeProps) {
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement
  const runtimeLabel = busy
    ? installingDsh ? '正在安装' : runtime.running ? '正在停止' : '正在启动'
    : runtime.running ? runtime.url ? '已就绪' : '正在启动'
      : needsInstallation ? '尚未安装' : '等待启动'
  const summary = `${activeRuntimeReplacement ? `${activeRuntimeReplacement.name} 已激活` : needsInstallation ? '首次部署准备' : `本地 DSH ${dshInstallation.version ?? ''}`} · ${profile.activeBundles.length} 个加载层`
  const capsuleText = runtime.url ? `${runtimeLabel} · ${formatAddress(runtime.url)}` : runtimeLabel
  const splitReady = runtime.running && Boolean(runtime.url) && !busy

  return (
    <div className="launcher-home">
      <header className="launcher-topbar">
        <img className="launcher-topbar-logo" src="/launcher-logo.png" alt="" width={22} height={22} draggable={false} />
        <span className="launcher-topbar-title">DSH 旋律启动器</span>
        <div className="launcher-topbar-actions">
          <button className="launcher-window-button" type="button" title="最小化" aria-label="最小化" onClick={onMinimize}>
            <Minus size={17} />
          </button>
          <button className="launcher-window-close" type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>

      <main className="launcher-stage">
        <aside className="launcher-brand">
          <div className="launcher-brand-dots" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => <span key={i} />)}
          </div>
          <img className="launcher-brand-watermark" src="/launcher-logo.png" alt="" aria-hidden="true" draggable={false} />
          <img className="launcher-brand-avatar" src="/launcher-logo.png" alt="DSH 旋律启动器" draggable={false} />
          <h1 className="launcher-brand-name">DSH 旋律启动器</h1>
          <div className="launcher-status-pill">
            <span className={`launcher-state-dot ${runtime.running ? 'running' : ''}`} />
            <span className="launcher-status-text">{capsuleText}</span>
          </div>
          <p className="launcher-brand-footer">v{packageMetadata.version} · {summary}</p>
          <p className="launcher-brand-footer">官方用户QQ群：625155044</p>
        </aside>

        <section className="launcher-actions">
          {splitReady ? (
            <div className="launcher-start-split">
              <button type="button" className="launcher-split-stop" onClick={onToggleRuntime}>
                <span className="launcher-state-dot running" />
                <span>停止 {runtime.applicationAddonName ?? 'DSH'}</span>
              </button>
              <button type="button" className="launcher-split-open" onClick={onOpenHarness}>
                <span>打开网页</span>
                <ExternalLink size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="launcher-start-button"
              onClick={onToggleRuntime}
              disabled={busy}
            >
              {busy ? <LoaderCircle className="spin" size={22} /> : needsInstallation ? <Download size={22} /> : <Play size={23} fill="currentColor" />}
              <span>
                <small>{installingDsh ? installProgress?.message ?? '正在准备本地 DSH' : needsInstallation ? '首次使用需要完成本地部署' : activeRuntimeReplacement ? '由应用加载项托管 DSH' : runtime.running ? '正在启动本地服务' : '启动本地工作台'}</small>
                <strong>{installingDsh ? installProgress?.indeterminate ? '安装进行中' : `安装 DSH ${installProgress?.percent ?? 0}%` : needsInstallation ? '下载安装 DSH' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : runtime.running ? '正在启动' : '启动 DSH'}</strong>
              </span>
            </button>
          )}

          <div className="launcher-utility-column">
            <button type="button" className="launcher-utility-button" onClick={onOpenSettings} title="版本、插件、技能与整合包"><Settings size={15} /><span>启动设置</span></button>
            <button type="button" className="launcher-utility-button" onClick={onManage} title="资源市场 / GitHub / 运行环境"><Wrench size={15} /><span>开发人员选项</span></button>
          </div>
        </section>
      </main>
    </div>
  )
}
