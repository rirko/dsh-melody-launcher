import {
  ArrowLeft,
  BookOpen,
  Check,
  Cpu,
  Download,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Maximize2,
  Minus,
  Package,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  DshInstallationStatus,
  InstalledPreset,
  InstalledSkill,
  ManagedPlugin,
  PackStatus,
  ProfileState,
  RuntimeEnvironmentState,
} from '../types'

/**
 * C 端「设置」页：启动页齿轮入口进来的全屏简洁管理页。
 * 只暴露 版本 / 插件 / 技能与预设 / 整合包 四块，各有开关与「打开文件夹」；
 * 左下角低调链接进开发者模式（旧设置面板与完整管理界面）。
 * 视觉沿用现有主题体系，不另造设计语言。
 */

interface SettingsViewProps {
  settings: AppSettings
  profile: ProfileState
  dshInstallation: DshInstallationStatus
  runtimeEnvironment: RuntimeEnvironmentState | null
  installedSkills: InstalledSkill[]
  installedPresets: InstalledPreset[]
  packs: PackStatus[]
  busy: string | null
  profileMutationLocked: boolean
  onBack: () => void
  onOpenDeveloperSettings: () => void
  onOpenManager: () => void
  onRefresh: () => void
  onImportPack: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
  onInstallDshVersion: (version: string) => Promise<boolean>
  onSelectDshVersion: (version: string) => Promise<boolean>
  onRemoveDshVersion: (version: string) => Promise<boolean>
  onTogglePlugin: (plugin: ManagedPlugin, enabled: boolean) => Promise<boolean>
  onToggleSkill: (skill: InstalledSkill, enabled: boolean) => void
  onTogglePreset: (preset: InstalledPreset, enabled: boolean) => void
  onActivatePack: (packId: string) => Promise<boolean>
  onDeactivatePack: () => Promise<boolean>
  onRemovePack: (packId: string) => Promise<boolean>
  onExportPack: (packId: string) => Promise<string | null>
  onOpenDshFolder: () => void
  onOpenPluginFolder: (packageName: string) => void
  onOpenPath: (targetPath: string) => void
}

type SettingsTab = 'versions' | 'plugins' | 'skills' | 'packs'

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Cpu }> = [
  { id: 'versions', label: 'DSH 版本', icon: Cpu },
  { id: 'plugins', label: '插件', icon: Layers3 },
  { id: 'skills', label: '技能与预设', icon: BookOpen },
  { id: 'packs', label: '整合包', icon: Package },
]

export function SettingsView({
  settings,
  profile,
  dshInstallation,
  runtimeEnvironment,
  installedSkills,
  installedPresets,
  packs,
  busy,
  profileMutationLocked,
  onBack,
  onOpenDeveloperSettings,
  onOpenManager,
  onRefresh,
  onImportPack,
  onMinimize,
  onToggleMaximize,
  onClose,
  onInstallDshVersion,
  onSelectDshVersion,
  onRemoveDshVersion,
  onTogglePlugin,
  onToggleSkill,
  onTogglePreset,
  onActivatePack,
  onDeactivatePack,
  onRemovePack,
  onExportPack,
  onOpenDshFolder,
  onOpenPluginFolder,
  onOpenPath,
}: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>('versions')
  const [versionInput, setVersionInput] = useState('')

  const activePack = useMemo(() => {
    const direct = packs.find(pack => pack.id === settings.profileName)
    if (direct) return direct
    return packs.find(pack => pack.id === settings.activePackId) ?? null
  }, [packs, settings.activePackId, settings.profileName])

  const locked = busy !== null || profileMutationLocked

  return (
    <div className="settings-page">
      <header className="settings-header">
        <div className="settings-title">
          <span className="management-eyebrow">DSH LAUNCHER · 简易模式</span>
          <h1>设置</h1>
          <p>管理要启动的 DSH 版本、插件、技能与整合包；每一步都可以打开对应的文件夹。</p>
        </div>
        <div className="settings-header-actions">
          <button type="button" className="settings-window-button" title="最小化" aria-label="最小化" onClick={onMinimize}><Minus size={16} /></button>
          <button type="button" className="settings-window-button" title="最大化或还原" aria-label="最大化或还原" onClick={onToggleMaximize}><Maximize2 size={14} /></button>
          <button type="button" className="settings-window-button close" title="关闭" aria-label="关闭" onClick={onClose}><X size={17} /></button>
          <button type="button" className="secondary-button" onClick={onRefresh} disabled={locked}><RefreshCw size={16} />刷新</button>
          <button type="button" className="management-back-button" onClick={onBack} title="返回启动页" aria-label="返回启动页"><ArrowLeft size={17} /><span>返回启动页</span></button>
        </div>
      </header>

      <nav className="settings-tabbar" aria-label="设置分类">
        {TABS.map(entry => {
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? 'active' : ''}
              onClick={() => setTab(entry.id)}
            >
              <Icon size={17} />
              <span>{entry.label}</span>
            </button>
          )
        })}
      </nav>

      <main className="settings-body">
        {tab === 'versions' && (
          <SettingsVersions
            environment={runtimeEnvironment}
            installed={Boolean(dshInstallation.installed)}
            input={versionInput}
            busy={locked}
            onInput={setVersionInput}
            onInstall={async version => {
              if (await onInstallDshVersion(version)) setVersionInput('')
            }}
            onSelect={onSelectDshVersion}
            onRemove={onRemoveDshVersion}
            onOpenFolder={onOpenDshFolder}
          />
        )}
        {tab === 'plugins' && (
          <SettingsPlugins pluginCount={profile.plugins.length}>
            {profile.plugins.map(plugin => (
              <ResourceRow
                key={plugin.packageName}
                title={plugin.displayName}
                subtitle={plugin.builtin ? 'DSH 核心组合层' : plugin.version}
                locked={plugin.locked}
                enabled={plugin.enabled}
                busy={locked}
                onToggle={enabled => { void onTogglePlugin(plugin, enabled) }}
                onOpenFolder={plugin.builtin ? undefined : () => onOpenPluginFolder(plugin.packageName)}
              />
            ))}
          </SettingsPlugins>
        )}
        {tab === 'skills' && (
          <div className="settings-stack">
            <SettingsSection
              title="技能"
              empty={installedSkills.length === 0}
              emptyText="本机还没有安装技能；可到「开发者模式 → 资源市场」获取。"
              onOpenFolder={() => onOpenPath(settings.dshHome)}
            >
              {installedSkills.map(skill => (
                <ResourceRow
                  key={skill.name}
                  title={skill.name}
                  subtitle={skill.description || skill.path}
                  enabled={skill.enabled}
                  busy={locked}
                  onToggle={enabled => onToggleSkill(skill, enabled)}
                  onOpenFolder={() => onOpenPath(skill.path)}
                />
              ))}
            </SettingsSection>
            <SettingsSection
              title="Agent 预设"
              empty={installedPresets.length === 0}
              emptyText="本机还没有预设；可到「开发者模式 → 资源市场」获取。"
              onOpenFolder={() => onOpenPath(settings.dshHome)}
            >
              {installedPresets.map(preset => (
                <ResourceRow
                  key={preset.name}
                  title={preset.name}
                  subtitle={preset.enabled ? preset.path : `已停用（${preset.path}）`}
                  enabled={preset.enabled}
                  busy={locked}
                  onToggle={enabled => onTogglePreset(preset, enabled)}
                  onOpenFolder={() => onOpenPath(preset.path)}
                />
              ))}
            </SettingsSection>
          </div>
        )}
        {tab === 'packs' && (
          <SettingsPacks
            packs={packs}
            activePack={activePack}
            busy={locked}
            onImport={onImportPack}
            onActivate={id => { void onActivatePack(id) }}
            onDeactivate={() => { void onDeactivatePack() }}
            onExport={id => { void onExportPack(id) }}
            onRemove={id => {
              if (window.confirm('确定删除这个整合包吗？已导入的独立环境会一并移除。')) void onRemovePack(id)
            }}
          />
        )}
      </main>

      <footer className="settings-footer">
        <button type="button" className="settings-developer-link" onClick={onOpenDeveloperSettings} title="完整开发者设置">
          <Settings size={14} />开发者模式 →
        </button>
        <button type="button" className="settings-developer-link" onClick={onOpenManager}>
          完整管理界面（资源市场 / GitHub / 运行环境）
        </button>
      </footer>
    </div>
  )
}

function SettingsVersions({
  environment,
  installed,
  input,
  busy,
  onInput,
  onInstall,
  onSelect,
  onRemove,
  onOpenFolder,
}: {
  environment: RuntimeEnvironmentState | null
  installed: boolean
  input: string
  busy: boolean
  onInput: (value: string) => void
  onInstall: (version: string) => void
  onSelect: (version: string) => Promise<boolean>
  onRemove: (version: string) => Promise<boolean>
  onOpenFolder: () => void
}) {
  if (!environment) {
    return <div className="settings-empty"><LoaderCircle className="spin" size={20} />正在读取 DSH 版本</div>
  }
  const candidates = environment.dshAvailable
  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Cpu size={17} /><span>DSH 版本管理</span></div>
        <button type="button" className="icon-button" onClick={onOpenFolder} title="打开 DSH 版本文件夹" aria-label="打开 DSH 版本文件夹"><FolderOpen size={16} /></button>
      </div>
      <div className="settings-current">
        <span>当前使用</span>
        <strong>{environment.dshSelectedVersion ?? '未选择'}</strong>
      </div>
      <div className="settings-install-row">
        <input list="settings-dsh-candidates" value={input} disabled={busy} placeholder="输入或选择要下载的 DSH 精确版本" onChange={event => onInput(event.target.value)} />
        <datalist id="settings-dsh-candidates">
          {candidates.map(candidate => <option key={candidate.version} value={candidate.version}>{candidate.label ?? ''}</option>)}
        </datalist>
        <button type="button" className="primary-command" disabled={busy || !input.trim()} onClick={() => onInstall(input.trim())}><Download size={15} />下载</button>
      </div>
      <div className="settings-list">
        {environment.dshInstalled.map(item => (
          <ResourceRow
            key={item.version}
            title={item.version}
            subtitle={item.source === 'legacy' ? '旧目录' : undefined}
            enabled={item.selected}
            selected
            busy={busy}
            onToggle={undefined}
            onSelect={item.selected ? undefined : () => { void onSelect(item.version) }}
            onRemove={item.removable ? () => { void onRemove(item.version) } : undefined}
            onOpenFolder={undefined}
          />
        ))}
        {environment.dshInstalled.length === 0 && (
          <div className="settings-empty">{installed ? '该版本未出现在列表中，刷新后再试。' : '尚未安装任何版本；输入版本号下载后即可启动。'}</div>
        )}
      </div>
    </div>
  )
}

function SettingsPlugins({ pluginCount, children }: { pluginCount: number; children: React.ReactNode }) {
  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Layers3 size={17} /><span>已安装插件</span>{pluginCount > 0 && <span className="settings-count">{pluginCount}</span>}</div>
      </div>
      <div className="settings-hint">开关决定插件在下次启动时是否加载；停用不会删除本体。</div>
      <div className="settings-list">{children}</div>
    </div>
  )
}

function SettingsSection({
  title,
  empty,
  emptyText,
  onOpenFolder,
  children,
}: {
  title: string
  empty: boolean
  emptyText: string
  onOpenFolder: () => void
  children: React.ReactNode
}) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><BookOpen size={17} /><span>{title}</span></div>
        <button type="button" className="icon-button" onClick={onOpenFolder} title={`打开${title}文件夹`} aria-label={`打开${title}文件夹`}><FolderOpen size={16} /></button>
      </div>
      {empty ? <div className="settings-empty">{emptyText}</div> : <div className="settings-list">{children}</div>}
    </section>
  )
}

function SettingsPacks({
  packs,
  activePack,
  busy,
  onImport,
  onActivate,
  onDeactivate,
  onExport,
  onRemove,
}: {
  packs: PackStatus[]
  activePack: PackStatus | null
  busy: boolean
  onImport: () => void
  onActivate: (packId: string) => void
  onDeactivate: () => void
  onExport: (packId: string) => void
  onRemove: (packId: string) => void
}) {
  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Package size={17} /><span>整合包</span>{packs.length > 0 && <span className="settings-count">{packs.length}</span>}</div>
        <button type="button" className="primary-command" onClick={onImport} disabled={busy}><Download size={15} />导入整合包</button>
      </div>
      <div className="settings-hint">整合包是一整套「DSH 版本 + 插件 + 技能 + 预设 + 配置」；导入时若机器上没有配套的 DSH 版本会自动下载，并与其它环境隔离。</div>
      {packs.length === 0 && <div className="settings-empty">还没有任何整合包；可导入他人分享的 .zip，或到「开发者模式」里创建一个。</div>}
      <div className="settings-list">
        {packs.map(pack => {
          const isActive = activePack?.id === pack.id
          const itemCount = pack.plugins.length
            + (pack.skills?.length ?? 0)
            + (pack.presets?.length ?? 0)
            + (pack.applications?.length ?? 0)
          return (
            <div key={pack.id} className={`settings-pack-row ${isActive ? 'active' : ''}`}>
              <div className="settings-pack-copy">
                <strong>{pack.name}</strong>
                <span>{pack.description || pack.id}{pack.dshVersion ? ` · DSH ${pack.dshVersion}` : ''} · {itemCount} 项内容</span>
              </div>
              <div className="settings-pack-actions">
                {isActive
                  ? <span className="settings-pack-active"><Check size={13} />当前使用</span>
                  : pack.state === 'complete'
                    ? <button type="button" className="secondary-button" disabled={busy} onClick={() => onActivate(pack.id)}>切换</button>
                    : <span className="settings-pack-state">未完成安装</span>}
                <button type="button" className="secondary-button" disabled={busy} onClick={() => onExport(pack.id)} title="导出为压缩包">导出</button>
                <button type="button" className="icon-button" disabled={busy} onClick={() => onRemove(pack.id)} title="删除整合包" aria-label="删除整合包"><Trash2 size={15} /></button>
              </div>
            </div>
          )
        })}
      </div>
      {activePack && (
        <div className="settings-pack-footer">
          <button type="button" className="secondary-button" disabled={busy} onClick={onDeactivate}>停用当前整合包</button>
        </div>
      )}
    </div>
  )
}

function ResourceRow({
  title,
  subtitle,
  enabled,
  selected = false,
  locked = false,
  busy,
  onToggle,
  onSelect,
  onRemove,
  onOpenFolder,
}: {
  title: string
  subtitle?: string
  enabled: boolean
  /** 版本行：勾选态显示「当前」，不参与开关语义。 */
  selected?: boolean
  locked?: boolean
  busy: boolean
  onToggle?: (enabled: boolean) => void
  onSelect?: () => void
  onRemove?: () => void
  onOpenFolder?: () => void
}) {
  return (
    <div className={`settings-row ${enabled && !selected ? 'enabled' : ''}`}>
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="settings-row-actions">
        {selected && <span className="settings-row-badge"><Check size={12} />当前</span>}
        {onToggle && (
          <label className="switch" title={enabled ? '停用' : '启用'}>
            <input type="checkbox" checked={enabled} disabled={busy} onChange={event => onToggle(event.target.checked)} />
            <span />
          </label>
        )}
        {!onToggle && onSelect && !selected && (
          <button type="button" className="secondary-button" disabled={busy || locked} onClick={onSelect}>使用</button>
        )}
        {onRemove && (
          <button type="button" className="icon-button" disabled={busy} onClick={onRemove} title="删除" aria-label={`删除 ${title}`}><Trash2 size={14} /></button>
        )}
        {onOpenFolder && (
          <button type="button" className="icon-button" onClick={onOpenFolder} title="打开文件夹" aria-label={`打开 ${title} 文件夹`}><FolderOpen size={15} /></button>
        )}
      </div>
    </div>
  )
}