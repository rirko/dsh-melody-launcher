import { useCallback, useEffect, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { WheelchairHome } from './WheelchairHome'
import { SettingsPanels } from '../views/SettingsView'
import { useLauncherApi } from '../api/client'
import { BUSY } from '../hooks/use-async-action'
import { isInstallProgressActive } from '../lib/install-progress'
import { DSH_REPOSITORY } from '../constants'
import type { AppSettings, HomeTab } from '../types'
import type { useLauncherStore } from '../hooks/use-launcher-store'
import './wheelchair.css'

/**
 * 轮椅模式（PR #94 完整新 UI）：TopBar 一级导航 + 新首页 + C 端面板，
 * 内容挂载在经典 surface-stage 内，窗口裁剪由共享壳负责。
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
  onOpenSettings: () => void
  onExit: () => void
}

export function WheelchairMode({ store, flip, onImportPack, onOpenLauncherUpdate, onOpenHarness, onOpenDeveloper, onOpenSettings, onExit }: WheelchairModeProps) {
  const api = useLauncherApi()
  const settings = store.settings as AppSettings
  const profile = store.profile as NonNullable<ReturnType<typeof useLauncherStore>['profile']>
  const [activeTab, setActiveTab] = useState<HomeTab>('start')
  // 主菜单下滚轮向上 = 从下到上翻转回原版主菜单（翻页转场由 App 统一驱动）。
  useEffect(() => {
    if (activeTab !== 'start' || flip !== null) return
    const onWheel = (event: WheelEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return
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
    <div className="wheelchair-mode" aria-label="轮椅模式">
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
            onOpenSettings={onOpenSettings}
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
            officialVersions={store.officialVersions}
            officialVersionsBusy={store.officialVersionsBusy}
            officialVersionsError={store.officialVersionsError}
            onLoadOfficialVersions={force => { void store.loadOfficialVersions(force) }}
            officialPackProgress={store.officialPackProgress}
            installingOfficialVersion={store.installingOfficialVersion}
            onInstallOfficialPackVersion={version => store.installOfficialPackVersion(version)}
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
    </div>
  )
}
