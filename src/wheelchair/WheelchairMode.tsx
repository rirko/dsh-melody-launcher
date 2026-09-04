import { useCallback, useEffect, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { WheelchairHome } from './WheelchairHome'
import { SettingsPanels } from '../views/SettingsView'
import { SettingsDialog } from '../components/dialogs/SettingsDialog'
import { useLauncherApi } from '../api/client'
import { BUSY } from '../hooks/use-async-action'
import { isInstallProgressActive } from '../lib/install-progress'
import { DSH_REPOSITORY } from '../constants'
import type { AppSettings, HomeTab } from '../types'
import type { useLauncherStore } from '../hooks/use-launcher-store'
// PR 的整套主题样式以 ?inline 取文本，仅在轮椅模式挂载期间注入 <style>，
// 退出时移除——原版界面的视觉永远使用原版 styles.css，互不渗透。
import wheelchairCss from './wheelchair.css?inline'

/**
 * 轮椅模式（PR #94 完整新 UI）：TopBar 一级导航 + 新首页 + C 端面板，
 * 全屏覆盖在原版界面之上，原版 UI 保持挂载与状态。
 *
 * UI 用 PR 的；底下全部是原版逻辑——安装走原版下载队列，面板动作直接
 * 绑定原版 store，齿轮打开的是未经改动的原版设置对话框。
 */

export interface WheelchairModeProps {
  store: ReturnType<typeof useLauncherStore>
  /** 翻页转场方向（进行中才有值）：根节点据此播放卡牌翻转。 */
  flip: 'enter' | 'exit' | null
  /** 原版整合包导入流程（App 作用域的 handlePackImport）。 */
  onImportPack: () => void
  onOpenLauncherUpdate: () => void
  onOpenHarness: () => void
  onOpenDeveloper: () => void
  onExit: () => void
}

const STYLE_ELEMENT_ID = 'wheelchair-mode-styles'
/** PR 首页视觉期望的主题变量（PR 主题体系未并入原版，进入模式时临时覆写，退出还原）。 */
const WHEELCHAIR_THEME = 'deepseek'

export function WheelchairMode({ store, flip, onImportPack, onOpenLauncherUpdate, onOpenHarness, onOpenDeveloper, onExit }: WheelchairModeProps) {
  const api = useLauncherApi()
  const settings = store.settings as AppSettings
  const profile = store.profile as NonNullable<ReturnType<typeof useLauncherStore>['profile']>
  const [activeTab, setActiveTab] = useState<HomeTab>('start')
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    // PR 样式之后追加壳覆盖规则：复刻原版 .surface-stage 的圆角/阴影/裁剪，
    // 并强制 html/body 透明不滚——轮椅模式的可见边缘与原版窗口完全一致。
    style.textContent = wheelchairCss + `
html, body { background: transparent !important; overflow: hidden !important; }
.wheelchair-mode-overlay {
  height: 100%;
  border-radius: 12px;
  box-shadow: 0 0 18px rgba(30, 45, 36, 0.2), inset 0 0 22px rgba(30, 45, 36, 0.08);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #dfe7ec;
}
.wheelchair-mode-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.wheelchair-mode-body > * { flex: 1; min-height: 0; }
`
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  // 主菜单下滚轮向上 = 从下到上翻转回原版主菜单（翻页转场由 App 统一驱动）。
  useEffect(() => {
    if (activeTab !== 'start' || flip !== null) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < -40) onExit()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [activeTab, flip, onExit])
  const installProgressForHome = store.installProgress?.repository === DSH_REPOSITORY ? store.installProgress : null
  const runtimeBusy = store.busy === BUSY.runtime || isInstallProgressActive(store.installProgress)
  const installingDsh = store.busy === BUSY.dshInstall
    || (isInstallProgressActive(store.installProgress) && store.installProgress?.kind === 'dsh')
  const profileMutationLocked = isInstallProgressActive(store.installProgress)

  const onSelectTab = useCallback((tab: HomeTab) => {
    setActiveTab(tab)
  }, [])

  return (
    <div className={`wheelchair-mode-overlay${flip === 'enter' ? ' app-flip-anim app-flip-in' : flip === 'exit' ? ' app-flip-anim app-flip-out' : ''}`} role="dialog" aria-label="轮椅模式">
      <TopBar
        activeTab={activeTab}
        developerActive={false}
        openWebVisible={store.runtime.running && Boolean(store.runtime.url)}
        onSelectTab={onSelectTab}
        onOpenHarness={onOpenHarness}
        onOpenDeveloper={onOpenDeveloper}
        onMinimize={() => { void api.minimizeWindow() }}
        onClose={() => { void api.closeWindow() }}
      />
      <div className="wheelchair-mode-body">
        {activeTab === 'start' ? (
          <WheelchairHome
            runtime={store.runtime}
            dshInstallation={store.dshInstallation}
            dshUpdate={store.dshUpdate}
            launcherUpdate={store.launcherUpdate}
            installProgress={installProgressForHome}
            busy={runtimeBusy}
            installingDsh={installingDsh}
            activeRuntimeReplacement={store.activeRuntimeReplacement}
            bundleCount={profile.activeBundles.length}
            pluginCount={profile.dependencyCount}
            skillCount={store.installedSkills.length}
            presetCount={store.installedPresets.length}
            onToggleRuntime={() => { void store.toggleRuntime() }}
            onVersionSelect={() => setActiveTab('packs')}
            onUpdateDsh={() => { void store.updateDsh() }}
            onOpenLauncherUpdate={onOpenLauncherUpdate}
            onNavigateTab={onSelectTab}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <SettingsPanels
            tab={activeTab}
            settings={settings}
            profile={profile}
            dshInstallation={store.dshInstallation}
            runtimeEnvironment={store.runtimeEnvironment}
            installedSkills={store.installedSkills}
            installedPresets={store.installedPresets}
            packs={store.packs}
            busy={store.busy}
            profileMutationLocked={profileMutationLocked}
            installProgress={store.installProgress}
            onRefresh={() => {
              void store.refreshProfile()
              void store.refreshSecondaryResources()
              void store.refreshPacks()
              void store.refreshRuntimeEnvironment(true)
            }}
            onImportPack={onImportPack}
            onInstallDshVersion={store.installDshVersion}
            onSelectDshVersion={store.selectDshVersion}
            onRemoveDshVersion={store.removeDshVersion}
            onTogglePlugin={store.togglePlugin}
            onToggleSkill={store.toggleSkill}
            onTogglePreset={store.togglePreset}
            onSkillInstalled={store.applyCatalogSkillInstall}
            onProfileChanged={() => { void store.refreshProfile() }}
            onActivatePack={store.activatePack}
            onDeactivatePack={store.deactivatePack}
            onRemovePack={store.removePack}
            onExportPack={store.exportPack}
            onOpenDshFolder={() => { void api.openDshFolder() }}
            onOpenPluginFolder={packageName => { void api.openProfilePluginFolder(packageName) }}
            onOpenPath={targetPath => { void api.openPath(targetPath) }}
          />
        )}
      </div>
      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          busy={store.busy === BUSY.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={next => { void store.saveSettings(next); setSettingsOpen(false) }}
          onDownloadRecommendedWebUi={() => { void store.installRecommendedWebUi({ suspendOthers: false }) }}
        />
      )}
    </div>
  )
}

