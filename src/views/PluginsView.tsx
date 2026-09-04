import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  Boxes,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  GripVertical,
  Link2,
  LoaderCircle,
  PackageCheck,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { activeOrderFromDisplay, movePackage, movePackageTo } from '../lib/profile-order'
import type { AppSettings, InstalledApplicationAddon, InstalledPreset, InstalledSkill, ManagedPlugin, PluginTrialResult, ProfileState, RuntimeState } from '../types'

/** 官方推荐整合包：固定显示在 web-app 下方的一行。 */
const RECOMMENDED_WEB_UI_PACKAGE = '@linxin666/dsh-web-ui-all'
const RECOMMENDED_WEB_UI_ANCHOR = '@deepseek-ai/dsh-web-app'

/** 插件加载顺序页：列表、排序、启停与详情。 */

type ResourceSelection =
  | { kind: 'plugin'; id: string }
  | { kind: 'skill'; id: string }

type SecondaryResourceTab = 'skill' | 'applications' | 'presets'

interface PluginsViewProps {
  profile: ProfileState
  profileName: string
  installedSkills: InstalledSkill[]
  installedApplications: InstalledApplicationAddon[]
  installedPresets: InstalledPreset[]
  pluginTrials: Record<string, PluginTrialResult>
  selected: ManagedPlugin | null
  busy: string | null
  settings: AppSettings
  runtime: RuntimeState
  activeRuntimeReplacement: InstalledApplicationAddon | null
  runtimeBusy: boolean
  /** 资源安装会写入 Profile 或本地资源目录；只锁定这些写操作。 */
  profileLocked: boolean
  onSelect: (plugin: ManagedPlugin) => void
  onToggle: (plugin: ManagedPlugin, enabled: boolean) => Promise<boolean>
  onToggleSkill: (skill: InstalledSkill, enabled: boolean) => void
  onToggleApplication: (application: InstalledApplicationAddon, enabled: boolean) => void
  onUninstallApplication: (application: InstalledApplicationAddon) => void
  onTogglePreset: (preset: InstalledPreset, enabled: boolean) => void
  onUninstallPreset: (preset: InstalledPreset) => void
  onReorder: (names: string[]) => Promise<void> | void
  onRefresh: () => void
  onBrowse: () => void
  onOpenRepository: (url: string) => void
  /** 打开某个插件在 Profile 里的安装目录。 */
  onOpenPluginFolder?: (packageName: string) => void
  /** 未安装官方推荐整合包时的“下载”操作。 */
  onInstallRecommendedWebUi?: () => void
  onToggleRuntime: () => void
  onOpenHarness: () => void
  onOpenRuntimeSettings: () => void
  onUninstall: (plugin: ManagedPlugin) => void
  onTrialPlugin: (packageName: string, profileName: string) => void
  onAdaptPlugin: (packageName: string, profileName: string) => void
  aiActive: boolean
  aiSubject: string | null
}

export function PluginsView({
  profile,
  profileName,
  installedSkills,
  installedApplications,
  installedPresets,
  pluginTrials,
  selected,
  busy,
  profileLocked,
  settings,
  runtime,
  activeRuntimeReplacement,
  runtimeBusy,
  onSelect,
  onToggle,
  onToggleSkill,
  onToggleApplication,
  onUninstallApplication,
  onTogglePreset,
  onUninstallPreset,
  onReorder,
  onRefresh,
  onBrowse,
  onOpenRepository,
  onOpenPluginFolder,
  onInstallRecommendedWebUi,
  onToggleRuntime,
  onOpenHarness,
  onOpenRuntimeSettings,
  onUninstall,
  onTrialPlugin,
  onAdaptPlugin,
  aiActive,
  aiSubject,
}: PluginsViewProps) {
  const [filter, setFilter] = useState('')
  const [showActivePlugins, setShowActivePlugins] = useState(true)
  const [showInactivePlugins, setShowInactivePlugins] = useState(true)
  const [pluginDisplayOrder, setPluginDisplayOrder] = useState<string[]>(() => profile.plugins.map(plugin => plugin.packageName))
  const [dragged, setDragged] = useState<string | null>(null)
  const [secondaryTab, setSecondaryTab] = useState<SecondaryResourceTab>('skill')
  const [selection, setSelection] = useState<ResourceSelection | null>(() => (
    selected ? { kind: 'plugin', id: selected.packageName } : null
  ))

  useEffect(() => {
    if (!selection || selection.kind === 'plugin') {
      setSelection(selected ? { kind: 'plugin', id: selected.packageName } : null)
    }
  }, [selected?.packageName])

  // ProfileState.plugins is already sorted from dsh.profile.bundles by the
  // main process. Include the order and enabled state in the key so importing
  // a Profile with the same plugin set but a different sequence also resets
  // the local display state.
  const pluginOrderKey = profile.plugins
    .map(plugin => `${plugin.packageName}:${plugin.enabled ? 'on' : 'off'}:${plugin.order ?? ''}`)
    .join('\n')
  useEffect(() => {
    setPluginDisplayOrder(profile.plugins.map(plugin => plugin.packageName))
  }, [profileName, pluginOrderKey])

  const active = profile.plugins.filter(plugin => plugin.enabled && plugin.packageName !== RECOMMENDED_WEB_UI_PACKAGE)
  const inactive = profile.plugins.filter(plugin => !plugin.enabled && plugin.packageName !== RECOMMENDED_WEB_UI_PACKAGE)
  const activeNames = active.map(plugin => plugin.packageName)
  const pluginsByName = new Map(profile.plugins.map(plugin => [plugin.packageName, plugin]))
  const orderedPlugins = pluginDisplayOrder
    .map(packageName => pluginsByName.get(packageName))
    .filter((plugin): plugin is ManagedPlugin => plugin !== undefined && plugin.packageName !== RECOMMENDED_WEB_UI_PACKAGE)
  const visible = (plugin: ManagedPlugin) =>
    (plugin.enabled ? showActivePlugins : showInactivePlugins)
    && (!filter || `${plugin.displayName} ${plugin.packageName}`.toLowerCase().includes(filter.toLowerCase()))
  const selectedPlugin = selection?.kind === 'plugin'
    ? profile.plugins.find(plugin => plugin.packageName === selection.id) ?? null
    : null
  const selectedSkill = selection?.kind === 'skill'
    ? installedSkills.find(skill => skill.name === selection.id) ?? null
    : null
  const runtimeAddons = installedApplications.filter(application => application.launchMode === 'runtime-replacement')
  const runtimeSelection = activeRuntimeReplacement ? `addon:${activeRuntimeReplacement.id}` : 'web'

  const selectRuntime = (value: string) => {
    if (value === 'web') {
      if (activeRuntimeReplacement) onToggleApplication(activeRuntimeReplacement, false)
      return
    }
    const addon = runtimeAddons.find(application => `addon:${application.id}` === value)
    if (addon && !addon.enabled) onToggleApplication(addon, true)
  }

  const move = (packageName: string, direction: -1 | 1) => {
    const names = movePackage(activeNames, packageName, direction)
    if (names) {
      setPluginDisplayOrder(current => applyActiveOrderToDisplay(current, names))
      onReorder(names)
    }
  }

  const dropAt = (targetName: string) => {
    const names = dragged ? movePackageTo(activeNames, dragged, targetName) : null
    setDragged(null)
    if (names) {
      setPluginDisplayOrder(current => applyActiveOrderToDisplay(current, names))
      onReorder(names)
    }
  }

  const togglePluginAtCurrentPosition = async (plugin: ManagedPlugin, enabled: boolean) => {
    if (!enabled) {
      await onToggle(plugin, false)
      return
    }

    const targetOrder = activeOrderFromDisplay(pluginDisplayOrder, [...activeNames, plugin.packageName])
    const toggled = await onToggle(plugin, true)
    if (toggled) await onReorder(targetOrder)
  }

  /** 官方推荐整合包固定行（web-app 下方），独立于真实插件列表。 */
  const RecommendedRow = () => {
    const recommended = profile.plugins.find(item => item.packageName === RECOMMENDED_WEB_UI_PACKAGE)
    const installed = Boolean(recommended)
    const enabled = recommended?.enabled ?? false
    return (
      <div className="plugin-row plugin-row-recommended">
        <div className="priority-cell"><span className="recommended-badge" title="启动器推荐">荐</span></div>
        <div className="state-cell">
          {installed ? (
            <label className="switch" title={enabled ? '停用整合包' : '启用整合包'} onClick={event => event.stopPropagation()}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={Boolean(busy)}
                onChange={event => { if (recommended) void onToggle(recommended, event.target.checked) }}
                aria-label={`${enabled ? '停用' : '启用'} 官方推荐 DSH Web UI`}
              />
              <span />
            </label>
          ) : (
            <button type="button" className="recommended-download" disabled={Boolean(busy)} title="下载官方推荐整合包" aria-label="下载官方推荐整合包" onClick={event => { event.stopPropagation(); onInstallRecommendedWebUi?.() }}><Download size={14} /></button>
          )}
        </div>
        <div className="plugin-name-cell"><strong>官方推荐 DSH Web UI</strong><span>{RECOMMENDED_WEB_UI_PACKAGE}</span></div>
        <span className="plugin-description-cell">启动器推荐整合包</span>
        <span className="plugin-version">{installed ? recommended?.version ?? '已安装' : '未安装'}</span>
        <div className="row-actions"><span className={`recommended-state ${enabled ? 'on' : ''}`}>{enabled ? '已启用' : installed ? '已停用' : ''}</span></div>
      </div>
    )
  }

  return (
    <div className="page plugins-page">
      <div className="management-titlebar">
        <div>
          <span className="management-eyebrow">WEB PROFILE</span>
          <h1>插件与 Skill 管理</h1>
          <p>调整加载顺序、启停状态，并从下方查看选中资源的简介。</p>
        </div>
        <div className="management-title-actions">
          <button className="secondary-button" type="button" onClick={onRefresh}><RefreshCw size={17} />刷新</button>
          <button className="secondary-button accent" type="button" onClick={onBrowse}><Download size={17} />获取资源</button>
        </div>
      </div>

      {!profile.initialized ? (
        <EmptyProfile onBrowse={onBrowse} />
      ) : (
        <>
          <div className="management-surface">
          <div className="management-primary-panel">
          <section className="plugin-list-panel management-plugin-panel" aria-label="插件管理">
            <div className="plugin-pane-toolbar">
              <div className="management-pane-heading"><span>Plugin</span><small>{profile.plugins.length} 个插件</small></div>
              <div className="plugin-status-filters" aria-label="Plugin 状态筛选">
                <label className={showActivePlugins ? 'selected' : ''}>
                  <input type="checkbox" checked={showActivePlugins} onChange={event => setShowActivePlugins(event.target.checked)} />
                  <span>已激活</span><strong>{active.length}</strong>
                </label>
                <label className={showInactivePlugins ? 'selected' : ''}>
                  <input type="checkbox" checked={showInactivePlugins} onChange={event => setShowInactivePlugins(event.target.checked)} />
                  <span>未激活</span><strong>{inactive.length}</strong>
                </label>
              </div>
            </div>
            <div className="plugin-management-column">
              <div className="column-headings" aria-hidden="true">
              <span>优先级</span><span>状态</span><span>插件</span><span>简介</span><span>版本</span><span />
              </div>
              <div className="plugin-rows">
              {orderedPlugins.filter(visible).map(plugin => {
                const activeIndex = activeNames.indexOf(plugin.packageName)
                return (
                <Fragment key={plugin.packageName}>
                <PluginRow
                  plugin={plugin}
                  selected={selection?.kind === 'plugin' && selection.id === plugin.packageName}
                  busy={isComponentBusy(busy, plugin.repositoryFullName, plugin.packageName)}
                  locked={profileLocked}
                  linked={installedApplications.some(application => sameRepository(application.repository, plugin.repositoryFullName))}
                  dragging={dragged === plugin.packageName}
                  canMoveUp={plugin.enabled && activeIndex > 0}
                  canMoveDown={plugin.enabled && activeIndex >= 0 && activeIndex < active.length - 1}
                  onSelect={() => { onSelect(plugin); setSelection({ kind: 'plugin', id: plugin.packageName }) }}
                  onToggle={enabled => { void togglePluginAtCurrentPosition(plugin, enabled) }}
                  onMove={moveDirection => move(plugin.packageName, moveDirection)}
                  onDragStart={() => setDragged(plugin.packageName)}
                  onDrop={() => dropAt(plugin.packageName)}
                  onOpenFolder={onOpenPluginFolder ? () => onOpenPluginFolder(plugin.packageName) : undefined}
                />
                {plugin.packageName === RECOMMENDED_WEB_UI_ANCHOR && <RecommendedRow />}
                </Fragment>
                )
              })}
              </div>
            </div>
          </section>
          </div>
          <div className="management-secondary-panel">
          <div className="management-runtime-control">
            <div className="management-runtime-label">
              <span className={`management-runtime-dot ${runtime.running ? 'running' : ''}`} />
              <span>运行时管理<small>{activeRuntimeReplacement?.name ?? `${settings.profileName} · Web`}</small></span>
            </div>
            <select
              aria-label="运行时管理"
              value={runtimeSelection}
              disabled={profileLocked || runtimeBusy || runtime.running}
              onChange={event => selectRuntime(event.target.value)}
            >
              <option value="web">DSH Web</option>
              {runtimeAddons.map(addon => <option key={addon.id} value={`addon:${addon.id}`}>{addon.name}</option>)}
            </select>
            <button type="button" className="icon-button" onClick={runtime.url ? onOpenHarness : onOpenRuntimeSettings} title={runtime.url ? '打开 Harness' : '打开运行与日志'} aria-label={runtime.url ? '打开 Harness' : '打开运行与日志'}>
              <ExternalLink size={15} />
            </button>
            <button
              type="button"
              className={`management-runtime-action ${runtime.running ? 'stop' : ''}`}
              onClick={onToggleRuntime}
              disabled={profileLocked || runtimeBusy}
            >
              {runtimeBusy ? <LoaderCircle className="spin" size={15} /> : runtime.running ? <CircleCheck size={15} /> : <Play size={15} fill="currentColor" />}
              {runtime.running ? '停止' : '启动'}
            </button>
          </div>
          <div className="management-search-control">
            <label className="search-field compact">
              <Search size={15} />
              <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选 Plugin、Skill、加载项或预设" aria-label="筛选 Plugin、Skill、加载项或预设" />
              {filter && <button type="button" onClick={() => setFilter('')} aria-label="清除筛选"><X size={14} /></button>}
            </label>
          </div>
          <section className="skill-list-panel" aria-label="Skill、应用加载项与预设管理">
            <div className="resource-tabs" role="tablist" aria-label="资源类型">
              <button type="button" role="tab" aria-selected={secondaryTab === 'skill'} className={secondaryTab === 'skill' ? 'active' : ''} onClick={() => setSecondaryTab('skill')}>
                <BookOpenCheck size={14} />Skill<span>{installedSkills.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={secondaryTab === 'applications'} className={secondaryTab === 'applications' ? 'active' : ''} onClick={() => setSecondaryTab('applications')}>
                <AppWindow size={14} />应用加载项<span>{installedApplications.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={secondaryTab === 'presets'} className={secondaryTab === 'presets' ? 'active' : ''} onClick={() => setSecondaryTab('presets')}>
                <Boxes size={14} />预设<span>{installedPresets.length}</span>
              </button>
            </div>
            {secondaryTab === 'skill' && <div className="resource-tab-panel" role="tabpanel">
              <SkillList skills={installedSkills.filter(skill => visibleSkill(skill, filter))} selectedName={selection?.kind === 'skill' ? selection.id : null} busy={busy} locked={profileLocked} onSelect={skill => setSelection({ kind: 'skill', id: skill.name })} onToggle={onToggleSkill} />
            </div>}
            {secondaryTab === 'applications' && <div className="resource-tab-panel" role="tabpanel">
              <ApplicationList
                applications={installedApplications.filter(application => visibleApplication(application, filter))}
                plugins={profile.plugins}
                busy={busy}
                locked={profileLocked}
                onToggle={onToggleApplication}
                onUninstall={onUninstallApplication}
              />
            </div>}
            {secondaryTab === 'presets' && <div className="resource-tab-panel" role="tabpanel">
              <PresetList presets={installedPresets.filter(preset => visiblePreset(preset, filter))} busy={busy} locked={profileLocked} onToggle={onTogglePreset} onUninstall={onUninstallPreset} />
            </div>}
          </section>
          </div>
          </div>
          <section className="resource-details-panel" aria-label="资源简介">
          {selectedPlugin ? <PluginDetails
            plugin={selectedPlugin}
            profileName={profileName}
            trial={pluginTrials[`${profileName}:${selectedPlugin.packageName}`]}
            busy={busy === `plugin-trial:${selectedPlugin.packageName}`}
            locked={profileLocked}
            aiActive={aiActive}
            adapting={Boolean(aiActive && aiSubject === selectedPlugin.packageName)}
            onOpenRepository={onOpenRepository}
            onUninstall={onUninstall}
            onTrialPlugin={onTrialPlugin}
            onAdaptPlugin={onAdaptPlugin}
          /> : selectedSkill ? <SkillDetails skill={selectedSkill} locked={profileLocked} busy={busy === `skill:${selectedSkill.name}`} onToggle={onToggleSkill} onOpenRepository={onOpenRepository} /> : <div className="resource-details-empty">选择一个 Plugin 或 Skill 查看简介</div>}
          </section>
        </>
      )}

    </div>
  )
}

function applyActiveOrderToDisplay(current: string[], activeOrder: string[]): string[] {
  const active = new Set(activeOrder)
  let activeIndex = 0
  return current.map(packageName => active.has(packageName) ? activeOrder[activeIndex++] : packageName)
}

function visibleSkill(skill: InstalledSkill, filter: string): boolean {
  return !filter || `${skill.name} ${skill.description}`.toLowerCase().includes(filter.toLowerCase())
}

function visibleApplication(application: InstalledApplicationAddon, filter: string): boolean {
  return !filter || `${application.name} ${application.packageName} ${application.description}`.toLowerCase().includes(filter.toLowerCase())
}

function ApplicationList({ applications, plugins, busy, locked, onToggle, onUninstall }: {
  applications: InstalledApplicationAddon[]
  plugins: ManagedPlugin[]
  busy: string | null
  locked: boolean
  onToggle: (application: InstalledApplicationAddon, enabled: boolean) => void
  onUninstall: (application: InstalledApplicationAddon) => void
}) {
  return (
    <div className="application-management-column">
      {applications.length === 0 ? (
        <div className="skill-empty">尚未安装应用加载项</div>
      ) : (
        <div className="application-rows">
          {applications.map(application => {
            const linked = plugins.some(plugin => sameRepository(plugin.repositoryFullName, application.repository))
            const applicationBusy = isComponentBusy(busy, application.repository, `application:${application.id}`)
            return (
              <div className={`application-row ${application.enabled ? '' : 'disabled'}`} key={application.id}>
                <div className="skill-identity">
                  <div className="skill-glyph application-icon"><AppWindow size={15} /></div>
                  <div>
                    <strong>{application.name}{linked && <span className="linked-component-badge"><Link2 size={10} />协同</span>}</strong>
                    <span>{application.launchMode === 'runtime-replacement' ? '替代 Web 启动' : application.launchMode === 'after-runtime' ? '启动后伴随运行' : '独立应用'} · {application.version}</span>
                  </div>
                </div>
                <div className="application-row-actions">
                  <label className="switch" title={application.enabled ? '停用应用加载项' : '启用应用加载项'}>
                    <input
                      type="checkbox"
                      checked={application.enabled}
                      disabled={locked || applicationBusy}
                      onChange={event => onToggle(application, event.target.checked)}
                      aria-label={`${application.enabled ? '停用' : '启用'} ${application.name}`}
                    />
                    <span>{applicationBusy && <LoaderCircle className="spin" size={11} />}</span>
                  </label>
                  <button
                    type="button"
                    className="application-remove-button"
                    disabled={locked || busy === `application-remove:${application.id}`}
                    onClick={() => onUninstall(application)}
                    title={`卸载 ${application.name}`}
                    aria-label={`卸载 ${application.name}`}
                  >
                    {busy === `application-remove:${application.id}` ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function sameRepository(left?: string, right?: string): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}

function isComponentBusy(busy: string | null, repository: string | undefined, fallback: string): boolean {
  return busy === fallback || Boolean(repository && busy === `component:${repository.toLowerCase()}`)
}

function visiblePreset(preset: InstalledPreset, filter: string): boolean {
  return !filter || preset.name.toLowerCase().includes(filter.toLowerCase())
}

/** Agent 预设列：与 Skill 相同的开关机制（目录在 .agent-presets/.disabled 下时停用）。 */
function PresetList({ presets, busy, locked, onToggle, onUninstall }: {
  presets: InstalledPreset[]
  busy: string | null
  locked: boolean
  onToggle: (preset: InstalledPreset, enabled: boolean) => void
  onUninstall: (preset: InstalledPreset) => void
}) {
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const removeBusy = (name: string) => busy === `preset-remove:${name}`
  return (
    <div className="skill-management-column preset-management-column">
      {presets.length === 0 ? (
        <div className="skill-empty">尚未安装预设</div>
      ) : (
        <div className="skill-rows">
          {presets.map(preset => (
            <div className={`skill-row ${preset.enabled ? '' : 'disabled'}`} key={preset.name}>
              <label className="switch" title={preset.enabled ? '停用预设' : '启用预设'}>
                <input
                  type="checkbox"
                  checked={preset.enabled}
                  disabled={locked || busy === `preset:${preset.name}`}
                  onChange={event => onToggle(preset, event.target.checked)}
                  aria-label={`${preset.enabled ? '停用' : '启用'} 预设 ${preset.name}`}
                />
                <span>{busy === `preset:${preset.name}` && <LoaderCircle className="spin" size={11} />}</span>
              </label>
              <div className="skill-name-cell"><strong>{preset.name}</strong></div>
              <span className="skill-description-cell">{preset.enabled ? '已启用' : '已停用'}</span>
              <button
                type="button"
                className={`icon-button preset-remove ${confirmingRemove === preset.name ? 'confirming' : ''}`}
                title={confirmingRemove === preset.name ? '再次点击确认删除' : '删除预设'}
                aria-label={confirmingRemove === preset.name ? `确认删除预设 ${preset.name}` : `删除预设 ${preset.name}`}
                disabled={locked || removeBusy(preset.name)}
                onClick={() => {
                  if (confirmingRemove !== preset.name) {
                    setConfirmingRemove(preset.name)
                    return
                  }
                  setConfirmingRemove(null)
                  onUninstall(preset)
                }}
              >
                {removeBusy(preset.name) ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillList({ skills, selectedName, busy, locked, onSelect, onToggle }: {
  skills: InstalledSkill[]
  selectedName: string | null
  busy: string | null
  locked: boolean
  onSelect: (skill: InstalledSkill) => void
  onToggle: (skill: InstalledSkill, enabled: boolean) => void
}) {
  return (
    <div className="skill-management-column">
      {skills.length === 0 ? (
        <div className="skill-empty">尚未安装 Skill</div>
      ) : (
        <div className="skill-rows">
          {skills.map(skill => (
            <div className={`skill-row ${skill.enabled ? '' : 'disabled'} ${selectedName === skill.name ? 'selected' : ''}`} key={skill.name} onClick={() => onSelect(skill)}>
              <div className="skill-name-cell"><strong>{skill.name}</strong></div>
              <span className="skill-description-cell">{skill.description || '该 Skill 没有提供描述。'}</span>
              <label className="switch" title={skill.enabled ? '停用 Skill' : '启用 Skill'} onClick={event => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  disabled={locked || busy === `skill:${skill.name}`}
                  onChange={event => onToggle(skill, event.target.checked)}
                  aria-label={`${skill.enabled ? '停用' : '启用'} Skill ${skill.name}`}
                />
                <span>{busy === `skill:${skill.name}` && <LoaderCircle className="spin" size={11} />}</span>
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PluginRow({ plugin, selected, busy, locked, linked, dragging, canMoveUp, canMoveDown, onSelect, onToggle, onMove, onDragStart, onDrop, onOpenFolder }: {
  plugin: ManagedPlugin
  selected: boolean
  busy: boolean
  locked: boolean
  linked: boolean
  dragging: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => void
  onMove: (direction: -1 | 1) => void
  onDragStart: () => void
  onDrop: () => void
  onOpenFolder?: () => void
}) {
  return (
    <div
      className={`plugin-row ${selected ? 'selected' : ''} ${plugin.enabled ? '' : 'disabled'} ${dragging ? 'dragging' : ''}`}
      draggable={plugin.enabled && !locked && !busy}
      onDragStart={event => {
        if (locked || busy || !plugin.enabled) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={event => {
        if (!locked && !busy && plugin.enabled) event.preventDefault()
      }}
      onDrop={event => {
        if (locked || busy || !plugin.enabled) return
        event.preventDefault()
        onDrop()
      }}
      onClick={onSelect}
    >
      <div className="priority-cell">
        {plugin.enabled ? <><GripVertical size={15} /><strong>{String(plugin.order).padStart(2, '0')}</strong></> : <span>—</span>}
      </div>
      <div className="state-cell">
        {!plugin.compatible && <span className="compatibility-warning" title="未检测到 dsh.bundle 声明"><CircleAlert size={16} /></span>}
        <label className={`switch ${plugin.locked ? 'locked' : ''}`} title={plugin.locked ? '核心组合层始终启用' : plugin.enabled ? '停用插件' : '启用插件'} onClick={event => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={plugin.enabled}
            disabled={locked || plugin.locked || busy || !plugin.compatible}
            onChange={event => onToggle(event.target.checked)}
            aria-label={`${plugin.enabled ? '停用' : '启用'} ${plugin.displayName}`}
          />
          <span>{busy && <LoaderCircle className="spin" size={11} />}</span>
        </label>
      </div>
      <div className="plugin-name-cell"><strong>{plugin.displayName}{linked && <span className="linked-component-badge"><Link2 size={10} />协同</span>}</strong><span>{plugin.packageName}</span></div>
      <span className="plugin-description-cell">{plugin.description || '该插件没有提供描述。'}</span>
      <span className="plugin-version">{plugin.version}</span>
      <div className="row-actions" onClick={event => event.stopPropagation()}>
        <button type="button" disabled={locked || busy || !canMoveUp} onClick={() => onMove(-1)} title="向上移动" aria-label={`向上移动 ${plugin.displayName}`}><ArrowUp size={15} /></button>
        <button type="button" disabled={locked || busy || !canMoveDown} onClick={() => onMove(1)} title="向下移动" aria-label={`向下移动 ${plugin.displayName}`}><ArrowDown size={15} /></button>
        {onOpenFolder && <button type="button" disabled={busy} onClick={onOpenFolder} title="打开插件文件夹" aria-label={`打开 ${plugin.displayName} 文件夹`}><FolderOpen size={15} /></button>}
      </div>
    </div>
  )
}

function PluginDetails({ plugin, profileName, trial, busy, locked, aiActive, adapting, onOpenRepository, onUninstall, onTrialPlugin, onAdaptPlugin }: {
  plugin: ManagedPlugin | null
  profileName: string
  trial?: PluginTrialResult
  busy: boolean
  locked: boolean
  aiActive: boolean
  adapting: boolean
  onOpenRepository: (url: string) => void
  onUninstall: (plugin: ManagedPlugin) => void
  onTrialPlugin: (packageName: string, profileName: string) => void
  onAdaptPlugin: (packageName: string, profileName: string) => void
}) {
  if (!plugin) return <aside className="plugin-details empty">选择一个插件查看详情</aside>
  return (
    <aside className="plugin-details">
      <h2>{plugin.displayName}</h2>
      <p className="package-name">{plugin.packageName}</p>
      <p className="plugin-description">{plugin.description}</p>
      <dl>
        <div><dt>加载优先级</dt><dd>{plugin.order ? `#${String(plugin.order).padStart(2, '0')}` : '不加载'}</dd></div>
        <div><dt>版本</dt><dd>{plugin.version}</dd></div>
        <div><dt>来源</dt><dd>{plugin.builtin ? 'DSH 内置' : 'Profile 依赖'}</dd></div>
        {!plugin.builtin && plugin.actualSource && <div><dt>实际安装来源</dt><dd>{plugin.actualSource === 'market' ? 'DSH Market' : plugin.actualSource === 'npm' ? 'npm' : plugin.actualSource === 'local' ? '整合包本地源码' : 'GitHub'}</dd></div>}
        {plugin.packOrigin && <div><dt>来源整合包</dt><dd>{plugin.packOrigin.packName}</dd></div>}
        <div><dt>兼容性</dt><dd className={plugin.compatible ? 'good' : 'warning'}>{plugin.compatible ? 'Bundle 已识别' : '未检测到 Bundle'}</dd></div>
      </dl>
      <div className="detail-actions">
        {!plugin.builtin && (
          <div className="detail-trial-actions">
            <button
              type="button"
              className={`secondary-button full trial-button ${trial?.phase ?? ''}`}
              disabled={locked || busy || aiActive || trial?.phase === 'running'}
              onClick={() => onTrialPlugin(plugin.packageName, profileName)}
              title={trial?.message ?? '只加载 DSH Web 核心与当前插件进行隔离试运行'}
            >
              {busy || trial?.phase === 'running'
                ? <LoaderCircle className="spin" size={16} />
                : trial?.phase === 'passed'
                  ? <CircleCheck size={16} />
                  : trial?.phase === 'failed'
                    ? <CircleAlert size={16} />
                    : <Play size={16} />}
              {trial?.phase === 'passed' ? '再次试运行' : trial?.phase === 'failed' ? '重新试运行' : trial?.phase === 'running' ? '试运行中' : '试运行'}
            </button>
            {trial?.phase === 'failed' && (
              <button
                type="button"
                className="secondary-button accent full"
                disabled={locked || aiActive}
                onClick={() => onAdaptPlugin(plugin.packageName, profileName)}
              >
                {adapting ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
                DSH 安装适配
              </button>
            )}
          </div>
        )}
        {plugin.repository && <button type="button" className="secondary-button full" onClick={() => onOpenRepository(plugin.repository!)}><FolderGit2 size={16} />查看仓库<ExternalLink size={14} /></button>}
        {!plugin.builtin && <button type="button" className="danger-button full" disabled={locked} onClick={() => onUninstall(plugin)}><Trash2 size={16} />卸载插件</button>}
      </div>
    </aside>
  )
}

function SkillDetails({ skill, locked, busy, onToggle, onOpenRepository }: {
  skill: InstalledSkill
  locked: boolean
  busy: boolean
  onToggle: (skill: InstalledSkill, enabled: boolean) => void
  onOpenRepository: (url: string) => void
}) {
  return (
    <div className="skill-details">
      <div className="skill-details-copy">
        <div>
          <span className="resource-detail-kind">SKILL</span>
          <h2>{skill.name}</h2>
          <p className="package-name">{skill.format === 'bundle' ? 'Bundle Skill' : 'Flat Skill'} · {skill.path}</p>
        </div>
        <p className="plugin-description">{skill.description || '该 Skill 没有提供描述。'}</p>
      </div>
      <dl>
        <div><dt>模型调用</dt><dd>{skill.modelInvocable ? '支持' : '不支持'}</dd></div>
        <div><dt>用户调用</dt><dd>{skill.userInvocable ? '支持' : '不支持'}</dd></div>
        <div><dt>来源</dt><dd>{skill.repository ?? '本地 Skill'}</dd></div>
      </dl>
      <div className="detail-actions skill-detail-actions">
        <label className="detail-toggle">
          <span>{skill.enabled ? '停用 Skill' : '启用 Skill'}</span>
          <span className="switch" title={skill.enabled ? '停用 Skill' : '启用 Skill'}>
            <input type="checkbox" checked={skill.enabled} disabled={locked || busy} onChange={event => onToggle(skill, event.target.checked)} aria-label={`${skill.enabled ? '停用' : '启用'} Skill ${skill.name}`} />
            <span>{busy && <LoaderCircle className="spin" size={11} />}</span>
          </span>
        </label>
        {skill.repository && <button type="button" className="secondary-button" onClick={() => onOpenRepository(skill.repository!)}><FolderGit2 size={16} />查看来源<ExternalLink size={14} /></button>}
      </div>
    </div>
  )
}

function EmptyProfile({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><PackageCheck size={28} /></div>
      <h2>Web 配置尚未初始化</h2>
      <p>首次启动 DSH 或安装插件时，官方 CLI 会创建 profile。启动器随后会在这里显示真实的组合层。</p>
      <button type="button" className="primary-command" onClick={onBrowse}><Sparkles size={17} />浏览插件</button>
    </div>
  )
}
