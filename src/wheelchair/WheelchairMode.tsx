import { useCallback, useEffect, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { WheelchairHome } from './WheelchairHome'
import { useLauncherApi } from '../api/client'
import type { DshInstallationStatus, DshUpdateStatus, HomeTab, InstallProgress, InstalledApplicationAddon, LauncherUpdateStatus, RuntimeState, ViewName } from '../types'
// PR 的整套主题样式以 ?inline 取文本，仅在轮椅模式挂载期间注入 <style>，
// 退出时移除——原版界面的视觉永远使用原版 styles.css，互不渗透。
import wheelchairCss from './wheelchair.css?inline'

/**
 * 轮椅模式（PR #94 新首页）的覆盖层：全屏挂载在原版界面之上，
 * 原版 UI 保持挂载与状态，只是被完全遮盖。顶栏 tab 语义映射回原版视图——
 * PR 的管理/设置实现不接线，一律用原版实现接管。
 */

export interface WheelchairModeProps {
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
  onUpdateDsh: () => void
  onOpenLauncherUpdate: () => void
  onOpenVersionPicker: () => void
  onOpenSettings: () => void
  /** 顶栏 tab 映射到原版视图并退出轮椅模式（PR 的对应实现由原版接管）。 */
  onNavigateOriginal: (view: ViewName) => void
  onOpenHarness: () => void
  onOpenDeveloper: () => void
  onExit: () => void
}

const STYLE_ELEMENT_ID = 'wheelchair-mode-styles'
/** PR 首页视觉期望的主题变量（PR 主题体系未并入原版，进入模式时临时覆写，退出还原）。 */
const WHEELCHAIR_THEME = 'deepseek'

export function WheelchairMode(props: WheelchairModeProps) {
  const api = useLauncherApi()
  const [activeTab] = useState<HomeTab | null>('start')

  useEffect(() => {
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.textContent = wheelchairCss
    document.head.appendChild(style)
    const root = document.documentElement
    const previous = root.dataset.wheelchairTheme
    root.dataset.wheelchairTheme = WHEELCHAIR_THEME
    return () => {
      style.remove()
      if (previous === undefined) delete root.dataset.wheelchairTheme
      else root.dataset.wheelchairTheme = previous
    }
  }, [])

  const navigate = useCallback((tab: HomeTab) => {
    if (tab === 'start') return
    const mapped: ViewName = tab === 'packs' ? 'packs' : tab === 'versions' ? 'environment' : 'plugins'
    props.onNavigateOriginal(mapped)
  }, [props])

  return (
    <div className="wheelchair-mode-overlay" role="dialog" aria-label="轮椅模式">
      <TopBar
        activeTab={activeTab}
        developerActive={false}
        openWebVisible={props.runtime.running && Boolean(props.runtime.url)}
        onSelectTab={navigate}
        onOpenHarness={props.onOpenHarness}
        onOpenDeveloper={props.onOpenDeveloper}
        onMinimize={() => { void api.minimizeWindow() }}
        onClose={() => { void api.closeWindow() }}
      />
      <div className="wheelchair-mode-body">
        <WheelchairHome
          runtime={props.runtime}
          dshInstallation={props.dshInstallation}
          dshUpdate={props.dshUpdate}
          launcherUpdate={props.launcherUpdate}
          installProgress={props.installProgress}
          busy={props.busy}
          installingDsh={props.installingDsh}
          activeRuntimeReplacement={props.activeRuntimeReplacement}
          bundleCount={props.bundleCount}
          pluginCount={props.pluginCount}
          skillCount={props.skillCount}
          presetCount={props.presetCount}
          onToggleRuntime={props.onToggleRuntime}
          onVersionSelect={props.onOpenVersionPicker}
          onUpdateDsh={props.onUpdateDsh}
          onOpenLauncherUpdate={props.onOpenLauncherUpdate}
          onNavigateTab={navigate}
          onOpenSettings={props.onOpenSettings}
        />
      </div>
      <button type="button" className="wheelchair-exit-button" title="退出轮椅模式，返回原版界面" onClick={props.onExit}>
        退出轮椅模式
      </button>
    </div>
  )
}
