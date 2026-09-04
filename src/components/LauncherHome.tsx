import { CircleStop, Download, ExternalLink, LoaderCircle, Package, Play, Settings } from 'lucide-react'
import packageMetadata from '../../package.json'
import { WidgetZone } from './WidgetZone'
import type { DshInstallationStatus, DshUpdateStatus, HomeTab, InstallProgress, InstalledApplicationAddon, LauncherUpdateStatus, RuntimeState } from '../types'

/**
 * 「启动」tab：PCL2 式首页。左列品牌（logo/名称/版本/QQ群），
 * 右列 = 小部件轮播区（更新/环境/余额/AI日报）+ 底部动作区
 * （启动大按钮 + 运行时「打开网页」小方块 + 切换整合包）。
 */

interface LauncherHomeProps {
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  dshUpdate: DshUpdateStatus | null
  launcherUpdate: LauncherUpdateStatus | null
  installProgress: InstallProgress | null
  busy: boolean
  installingDsh: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  bundleCount: number
  pluginCount: number
  skillCount: number
  presetCount: number
  onToggleRuntime: () => void
  onOpenHarness: () => void
  onVersionSelect: () => void
  onUpdateDsh: () => void
  onOpenLauncherUpdate: () => void
  onNavigateTab: (tab: HomeTab) => void
  onOpenSettings: () => void
}

export function LauncherHome({
  runtime,
  dshInstallation,
  dshUpdate,
  launcherUpdate,
  installProgress,
  busy,
  installingDsh,
  activeRuntimeReplacement,
  bundleCount,
  pluginCount,
  skillCount,
  presetCount,
  onToggleRuntime,
  onOpenHarness,
  onVersionSelect,
  onUpdateDsh,
  onOpenLauncherUpdate,
  onNavigateTab,
  onOpenSettings,
}: LauncherHomeProps) {
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement

  return (
    <div className="launcher-home">
      <section className="home-brand">
        <div className="home-brand-head">
          <img className="home-brand-logo" src="/launcher-logo.png" alt="" width={112} height={112} draggable={false} />
          <h1 className="home-brand-name">
            <strong>DSH</strong>
            <span>Melody Launcher</span>
          </h1>
          <p className="home-brand-tagline">DeepSeek Harness 启动器</p>
        </div>
        <div className="home-brand-meta">
          <span className="home-brand-version">v{packageMetadata.version}</span>
          <span className="home-brand-qq">官方用户QQ群：625155044</span>
          <button type="button" className="home-brand-settings" onClick={onOpenSettings} title="启动器设置">
            <Settings size={13} /><span>设置</span>
          </button>
        </div>
      </section>

      <section className="home-side">
        <WidgetZone
          dshUpdate={dshUpdate}
          launcherUpdate={launcherUpdate}
          busy={busy}
          dshVersion={dshInstallation.version ?? null}
          bundleCount={bundleCount}
          pluginCount={pluginCount}
          skillCount={skillCount}
          presetCount={presetCount}
          onUpdateDsh={onUpdateDsh}
          onOpenLauncherUpdate={onOpenLauncherUpdate}
          onNavigateTab={onNavigateTab}
        />
        <div className="home-actions">
        <div className="home-start-row">
          <button
            type="button"
            className={`launcher-start-button ${runtime.running ? 'stop' : ''}`}
            onClick={onToggleRuntime}
            disabled={busy}
          >
            {busy ? <LoaderCircle className="spin" size={24} /> : runtime.running ? <CircleStop size={24} /> : needsInstallation ? <Download size={24} /> : <Play size={25} fill="currentColor" />}
            <span>
              <small>{busy ? (installingDsh ? installProgress?.message ?? '正在准备本地 DSH' : runtime.running ? '正在停止本地服务' : '正在启动本地工作台') : runtime.running ? '结束本地服务' : needsInstallation ? '首次使用需要完成本地部署' : activeRuntimeReplacement ? '由应用加载项托管 DSH' : '启动本地工作台'}</small>
              <strong>{runtime.running ? `停止 ${runtime.applicationAddonName ?? 'DSH'}` : installingDsh ? installProgress?.indeterminate ? '安装进行中' : `安装 DSH ${installProgress?.percent ?? 0}%` : needsInstallation ? '下载安装 DSH' : busy ? '请稍候…' : activeRuntimeReplacement ? `启动 ${activeRuntimeReplacement.name}` : '启动 DSH'}</strong>
            </span>
          </button>
          {runtime.running && runtime.url && (
            <button type="button" className="home-open-square" onClick={onOpenHarness} title="打开 DSH 网页工作台" aria-label="打开网页">
              <ExternalLink size={18} />
            </button>
          )}
        </div>
        <button type="button" className="launcher-utility-button home-version-button" onClick={onVersionSelect} title="切换到其它整合包"><Package size={16} /><span>切换整合包</span></button>
        </div>
      </section>
    </div>
  )
}
