import { CircleStop, Download, ExternalLink, LoaderCircle, Package, Play } from 'lucide-react'
import packageMetadata from '../../package.json'
import type { DshInstallationStatus, InstallProgress, InstalledApplicationAddon, RuntimeState } from '../types'

/**
 * 「启动」tab：PCL2 式首页。左列品牌（logo/名称/版本/QQ群），
 * 右列上方留白、底部动作区——启动大按钮（描边）+ 运行时才出现的「打开网页」小方块，
 * 其下「版本选择（整合包）」跳到整合包 tab。运行状态直接写进启动按钮文案。
 */

interface LauncherHomeProps {
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  installProgress: InstallProgress | null
  busy: boolean
  installingDsh: boolean
  activeRuntimeReplacement: InstalledApplicationAddon | null
  onToggleRuntime: () => void
  onOpenHarness: () => void
  onVersionSelect: () => void
}

export function LauncherHome({
  runtime,
  dshInstallation,
  installProgress,
  busy,
  installingDsh,
  activeRuntimeReplacement,
  onToggleRuntime,
  onOpenHarness,
  onVersionSelect,
}: LauncherHomeProps) {
  const needsInstallation = !dshInstallation.installed && !activeRuntimeReplacement

  return (
    <div className="launcher-home">
      <section className="home-brand">
        <div className="home-brand-head">
          <img className="home-brand-logo" src="/launcher-logo.png" alt="" width={96} height={96} draggable={false} />
          <h1>DSH-Melody-Launcher</h1>
        </div>
        <div className="home-brand-meta">
          <span className="home-brand-version">v{packageMetadata.version}</span>
          <span className="home-brand-qq">官方用户QQ群：625155044</span>
        </div>
      </section>

      <section className="home-actions">
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
        <button type="button" className="launcher-utility-button home-version-button" onClick={onVersionSelect} title="选择要使用的整合包"><Package size={16} /><span>整合包选择</span></button>
      </section>
    </div>
  )
}
