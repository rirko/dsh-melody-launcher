import {
  ChevronDown,
  Download,
  LoaderCircle,
  Package,
  PackagePlus,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeading } from '../components/PageHeading'
import { formatRelativeTime } from '../lib/format'
import type { InstalledApplicationAddon, InstalledPreset, InstalledSkill, ManagedPlugin, PackStatus, ProfileExportMode, ProfileState, ProfileSummary } from '../types'

/**
 * Profile / 整合包管理页：Profile 目录是运行环境与可分享清单的唯一实体。
 * 流式创建/导入走 use-pack-install（App 挂载 PackInstallDialog），
 * 这里的一次性动作（启停/导出/删除/包内插件增删改）都委托给 store。
 */

export interface PacksViewProps {
  packs: PackStatus[]
  profiles?: ProfileSummary[]
  profile: ProfileState
  /** 当前正在忙碌的一次性动作标识（useAsyncAction.busy）。 */
  busy: string | null
  onRefresh: () => void
  onCreate: () => void
  onImport: () => void
  onImportRepository?: () => void
  onActivate: (packId: string) => void
  onDeactivate: () => void
  onSwitchProfile?: (profileName: string) => void
  onCreateProfile?: (name: string, cloneFrom?: string) => void
  onDeleteProfile?: (profileName: string) => void
  onExport: (packId: string) => void
  onExportProfile?: (profileName: string, mode: ProfileExportMode) => void
  onRemove: (packId: string) => void
  onAddPlugin: (packId: string, packageName: string) => void
  onAddPreset: (packId: string, presetName: string) => void
  onAddSkill: (packId: string, skillName: string) => void
  onAddApplication: (packId: string, addonId: string) => void
  onToggleItem: (packId: string, packageName: string, enabled: boolean) => void
  onTogglePreset: (packId: string, presetName: string, enabled: boolean) => void
  onToggleSkill: (packId: string, skillName: string, enabled: boolean) => void
  onToggleApplication: (packId: string, addonId: string, enabled: boolean) => void
  onRemoveItem: (packId: string, packageName: string) => void
  onRemovePreset: (packId: string, presetName: string) => void
  onRemoveSkill: (packId: string, skillName: string) => void
  onRemoveApplication: (packId: string, addonId: string) => void
  /** 当前已安装且带来源记录的 Agent 预设，供添加到包内。 */
  installedPresets: InstalledPreset[]
  /** 当前已安装且带来源记录的 Skill，供添加到包内。 */
  installedSkills: InstalledSkill[]
  /** 当前已安装的 Application Addon，供添加到包内。 */
  installedApplications: InstalledApplicationAddon[]
}

const SOURCE_LABEL: Record<PackStatus['source'], string> = {
  created: '自建',
  zip: '离线包',
  manifest: '清单包',
  raw: '扫描导入',
}

const STATE_LABEL: Record<PackStatus['state'], string> = {
  complete: '完整',
  partial: '部分成功',
  failed: '失败',
}

export function PacksView({
  packs,
  profiles = [],
  profile,
  busy,
  onRefresh,
  onCreate,
  onImport,
  onImportRepository,
  onActivate,
  onDeactivate,
  onSwitchProfile,
  onCreateProfile,
  onDeleteProfile,
  onExport,
  onExportProfile,
  onRemove,
  onAddPlugin,
  onAddPreset,
  onAddSkill,
  onAddApplication,
  onToggleItem,
  onTogglePreset,
  onToggleSkill,
  onToggleApplication,
  onRemoveItem,
  onRemovePreset,
  onRemoveSkill,
  onRemoveApplication,
  installedPresets,
  installedSkills,
  installedApplications,
}: PacksViewProps) {
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null)
  const [confirmingRemoval, setConfirmingRemoval] = useState<PackStatus | null>(null)
  const selectedPack = useMemo(() => {
    if (selectedPackId) {
      const found = packs.find(pack => pack.id === selectedPackId)
      if (found) return found
    }
    return packs.find(pack => pack.enabled) ?? packs[0] ?? null
  }, [packs, selectedPackId])

  const activeCount = packs.filter(pack => pack.enabled).length
  const totalPlugins = packs.reduce((sum, pack) => sum + pack.plugins.length, 0)
  const refreshing = busy === 'pack-refresh'

  const toggleSelect = (packId: string) => {
    setSelectedPackId(current => current === packId ? null : packId)
  }

  return (
    <div className="page packs-page">
      <PageHeading
        eyebrow="PROFILES"
        title="Profile / 整合包"
        description="每个 Profile 同时代表一个 DSH 运行环境和可导出的整合包，插件、启用状态与加载顺序彼此独立。"
        actions={(
          <>
            <button type="button" className="secondary-button" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}刷新 Profile
            </button>
            <button type="button" className="secondary-button accent" onClick={onCreate} disabled={busy !== null}><PackagePlus size={17} />创建 Profile</button>
            <button type="button" className="primary-command" onClick={onImport} disabled={busy !== null}><Download size={17} />导入 Profile / 整合包</button>
            {onImportRepository && <button type="button" className="secondary-button" onClick={onImportRepository} disabled={busy !== null}><Download size={17} />从 GitHub 仓库导入</button>}
          </>
        )}
      />

      <div className="stats-strip packs-stats" aria-label="Profile 概况">
        <div><strong>{profiles.length || packs.length}</strong><span>Profile</span></div>
        <div><strong>{profiles.filter(item => item.selected).length || activeCount}</strong><span>当前环境</span></div>
        <div><strong>{profiles.length > 0 ? profiles.reduce((sum, item) => sum + item.pluginCount, 0) : totalPlugins}</strong><span>累计插件</span></div>
      </div>

      {profiles.length > 0 && (
        <section className="profile-environment-panel" aria-label="Profile 环境列表">
          <div className="profile-environment-heading">
            <div><strong>运行 Profile</strong><span>每个目录同时是 DSH 运行环境和可分享整合包，当前选择由 profileName 唯一决定</span></div>
            <button type="button" className="secondary-button accent" disabled={busy !== null} onClick={() => {
              const name = window.prompt('请输入新的 Profile 名称')?.trim()
              if (name) onCreateProfile?.(name)
            }}><Plus size={16} />新建 Profile</button>
          </div>
          <div className="profile-environment-list">
            {profiles.map(item => (
              <article key={item.id} className={`profile-environment-row ${item.selected ? 'selected' : ''}`}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.dshVersion ? `DSH ${item.dshVersion}` : 'DSH 版本未锁定'} · {item.pluginCount} 个插件 · {item.missingDependencies.length > 0 ? `缺少 ${item.missingDependencies.length} 项依赖` : '依赖完整'}</small>
                </div>
                <div className="profile-environment-actions">
                  {item.selected ? <span className="pack-active-badge">当前 Profile</span> : <button type="button" className="install-button" disabled={busy !== null} onClick={() => onSwitchProfile?.(item.id)}>切换</button>}
                  <ProfileExportMenu
                    profileName={item.id}
                    busy={busy}
                    onExportProfile={onExportProfile}
                    onExport={() => onExport(item.id)}
                  />
                  {!item.selected && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => onDeleteProfile?.(item.id)}>删除</button>}
                  {!item.selected && <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => {
                    const name = window.prompt('请输入克隆后的 Profile 名称')?.trim()
                    if (name) onCreateProfile?.(name, item.id)
                  }}>克隆</button>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {profiles.length === 0 && packs.length === 0 ? (
        <EmptyPacks onCreate={onCreate} onImport={onImport} onImportRepository={onImportRepository} disabled={busy !== null} />
      ) : profiles.length === 0 ? (
        <div className="packs-layout">
          <section className="packs-list-panel" aria-label="整合包列表">
            {packs.map(pack => (
              <PackRow
                key={pack.id}
                pack={pack}
                selected={selectedPack?.id === pack.id}
                busy={busy}
                onSelect={() => toggleSelect(pack.id)}
                onActivate={() => onActivate(pack.id)}
                onDeactivate={onDeactivate}
                onExport={() => onExport(pack.id)}
                onRemove={() => setConfirmingRemoval(pack)}
              />
            ))}
          </section>
          <PackDetails
            key={selectedPack?.id ?? 'none'}
            pack={selectedPack}
            profile={profile}
            busy={busy}
            onToggleItem={(packageName, enabled) => onToggleItem(selectedPack!.id, packageName, enabled)}
            onRemoveItem={packageName => onRemoveItem(selectedPack!.id, packageName)}
            onAddPlugins={packageNames => {
              for (const packageName of packageNames) onAddPlugin(selectedPack!.id, packageName)
            }}
            installedPresets={installedPresets}
            onAddPresets={presetNames => {
              for (const presetName of presetNames) onAddPreset(selectedPack!.id, presetName)
            }}
            onTogglePreset={(presetName, enabled) => onTogglePreset(selectedPack!.id, presetName, enabled)}
            onRemovePreset={presetName => onRemovePreset(selectedPack!.id, presetName)}
            installedSkills={installedSkills}
            onAddSkills={skillNames => {
              for (const skillName of skillNames) onAddSkill(selectedPack!.id, skillName)
            }}
            onToggleSkill={(skillName, enabled) => onToggleSkill(selectedPack!.id, skillName, enabled)}
            onRemoveSkill={skillName => onRemoveSkill(selectedPack!.id, skillName)}
            installedApplications={installedApplications}
            onAddApplications={addonIds => {
              for (const addonId of addonIds) onAddApplication(selectedPack!.id, addonId)
            }}
            onToggleApplication={(addonId, enabled) => onToggleApplication(selectedPack!.id, addonId, enabled)}
            onRemoveApplication={addonId => onRemoveApplication(selectedPack!.id, addonId)}
          />
        </div>
      ) : null}

      {confirmingRemoval && (
        <RemovePackDialog
          pack={confirmingRemoval}
          busy={busy === `pack-remove:${confirmingRemoval.id}`}
          onCancel={() => setConfirmingRemoval(null)}
          onConfirm={() => {
            const pack = confirmingRemoval
            setConfirmingRemoval(null)
            onRemove(pack.id)
          }}
        />
      )}

      <style>{packsStyle}</style>
    </div>
  )
}

function EmptyPacks({ onCreate, onImport, onImportRepository, disabled }: { onCreate: () => void; onImport: () => void; onImportRepository?: () => void; disabled: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Package size={28} /></div>
      <h2>还没有整合包</h2>
      <p>整合包只保存插件清单、启用状态和加载顺序；插件统一安装在当前 Profile，可从这里或左侧菜单快速切换。</p>
      <div className="empty-state-actions">
      <button type="button" className="primary-command" onClick={onCreate} disabled={disabled}><PackagePlus size={17} />创建整合包</button>
      <button type="button" className="secondary-button accent" onClick={onImport} disabled={disabled}><Download size={17} />导入整合包</button>
      {onImportRepository && <button type="button" className="secondary-button" onClick={onImportRepository} disabled={disabled}><Download size={17} />从 GitHub 仓库导入</button>}
      </div>
    </div>
  )
}

function PackRow({ pack, selected, busy, onSelect, onActivate, onDeactivate, onExport, onRemove }: {
  pack: PackStatus
  selected: boolean
  busy: string | null
  onSelect: () => void
  onActivate: () => void
  onDeactivate: () => void
  onExport: () => void
  onRemove: () => void
}) {
  const activating = busy === `pack-activate:${pack.id}`
  const deactivating = busy === 'pack-deactivate'
  const removing = busy === `pack-remove:${pack.id}`
  const exporting = busy === `pack-export:${pack.id}`
  const rowDisabled = busy !== null

  return (
    <article className={`pack-row ${selected ? 'selected' : ''} ${pack.enabled ? 'active' : ''}`}>
      <div className="pack-row-main" onClick={onSelect}>
        <div className={`pack-glyph ${pack.source}`}>{pack.name.slice(0, 2).toUpperCase()}</div>
        <div className="pack-row-copy">
          <div className="pack-title-line">
            <strong>{pack.name}</strong>
            <span className="pack-source-badge">{SOURCE_LABEL[pack.source]}</span>
            <span className={`pack-state-badge ${pack.state}`}>{STATE_LABEL[pack.state]}</span>
            {pack.enabled && <span className="pack-active-badge">使用中</span>}
          </div>
          <p>{pack.description || '（无描述）'}</p>
          <small>v{pack.version} · DSH {pack.dshVersion ?? '未记录'} · {pack.plugins.length} 个插件{pack.presets?.length ? ` · ${pack.presets.length} 个预设` : ''} · 更新于 {formatRelativeTime(pack.updatedAt)}</small>
        </div>
      </div>
      <div className="pack-row-actions" onClick={event => event.stopPropagation()}>
        {pack.enabled ? (
          <button type="button" className="secondary-button" disabled={rowDisabled || deactivating} onClick={onDeactivate}>
            {deactivating ? <LoaderCircle className="spin" size={15} /> : null}停用
          </button>
        ) : (
          <button type="button" className="install-button" disabled={rowDisabled} onClick={onActivate}>
            {activating ? <LoaderCircle className="spin" size={15} /> : null}启用
          </button>
        )}
        <button type="button" className="secondary-button" disabled={rowDisabled} onClick={onExport}>
          {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}导出
        </button>
        <button type="button" className={`secondary-button ${selected ? 'accent' : ''}`} disabled={rowDisabled} onClick={onSelect}>
          详情
        </button>
        <button type="button" className="danger-button" disabled={rowDisabled} onClick={onRemove}>
          {removing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}删除
        </button>
      </div>
    </article>
  )
}

function PackDetails({ pack, profile, busy, onToggleItem, onRemoveItem, onAddPlugins, installedPresets, onAddPresets, onTogglePreset, onRemovePreset, installedSkills, onAddSkills, onToggleSkill, onRemoveSkill, installedApplications, onAddApplications, onToggleApplication, onRemoveApplication }: {
  pack: PackStatus | null
  profile: ProfileState
  busy: string | null
  onToggleItem: (packageName: string, enabled: boolean) => void
  onRemoveItem: (packageName: string) => void
  onAddPlugins: (packageNames: string[]) => void
  installedPresets: InstalledPreset[]
  onAddPresets: (presetNames: string[]) => void
  onTogglePreset: (presetName: string, enabled: boolean) => void
  onRemovePreset: (presetName: string) => void
  installedSkills: InstalledSkill[]
  onAddSkills: (skillNames: string[]) => void
  onToggleSkill: (skillName: string, enabled: boolean) => void
  onRemoveSkill: (skillName: string) => void
  installedApplications: InstalledApplicationAddon[]
  onAddApplications: (addonIds: string[]) => void
  onToggleApplication: (addonId: string, enabled: boolean) => void
  onRemoveApplication: (addonId: string) => void
}) {
  const [addingOpen, setAddingOpen] = useState(false)
  const [addingPresetsOpen, setAddingPresetsOpen] = useState(false)
  const [addingSkillsOpen, setAddingSkillsOpen] = useState(false)
  const [addingApplicationsOpen, setAddingApplicationsOpen] = useState(false)

  if (!pack) {
    return <aside className="pack-details empty">选择一个整合包查看详情</aside>
  }

  const candidates = profile.plugins.filter(plugin => !pack.plugins.some(item => item.packageName === plugin.packageName))
  const presetCandidates = installedPresets.filter(preset =>
    !pack.presets?.some(item => item.name === preset.name)
    && Boolean(preset.repository && preset.sourcePath && preset.revision)
  )
  const skillCandidates = installedSkills.filter(skill =>
    !pack.skills?.some(item => item.name === skill.name)
    && Boolean(skill.repository && skill.sourcePath && skill.revision)
  )
  const applicationCandidates = installedApplications.filter(addon =>
    !pack.applications?.some(item => item.id === addon.id)
  )

  return (
    <aside className="pack-details">
      <div className="pack-details-head">
        <div>
          <h2>{pack.name}</h2>
          <p>{pack.description || '（无描述）'}</p>
        </div>
        {pack.enabled && <span className="pack-active-badge">使用中</span>}
      </div>
      <dl className="pack-details-meta">
        <div><dt>版本</dt><dd>{pack.version}</dd></div>
        <div><dt>要求 DSH</dt><dd>{pack.dshVersion ?? '未记录（旧整合包）'}</dd></div>
        <div><dt>来源</dt><dd>{SOURCE_LABEL[pack.source]}</dd></div>
        <div><dt>状态</dt><dd className={pack.state}>{STATE_LABEL[pack.state]}</dd></div>
      </dl>
      {pack.failures && pack.failures.length > 0 && (
        <div className="pack-details-failures">
          <div className="pack-details-failures-head"><span>失败项（{pack.failures.length}）</span></div>
          <div className="pack-failure-items">
            {pack.failures.map(failure => (
              <div className="pack-failure-row" key={failure.packageName}>
                <code>{failure.packageName}</code>
                <span>{failure.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="pack-details-plugins">
        <div className="pack-details-plugins-head">
          <span>包含插件（{pack.plugins.length}）</span>
          <button
            type="button"
            className="install-button"
            disabled={busy !== null || candidates.length === 0}
            onClick={() => setAddingOpen(true)}
            title={candidates.length === 0 ? '当前 Profile 没有可添加的新插件' : '从当前 Profile 选择插件加入'}
          >
            <Plus size={14} />添加插件
          </button>
        </div>
        {pack.plugins.length === 0 ? (
          <div className="pack-details-empty">整合包里还没有插件。</div>
        ) : (
          <div className="pack-detail-items">
            {pack.plugins.map(item => {
              const toggling = busy === `pack-toggle:${pack.id}:${item.packageName}`
              const removing = busy === `pack-remove-item:${pack.id}:${item.packageName}`
              return (
                <div className={`pack-detail-item ${item.enabled ? '' : 'disabled'}`} key={item.packageName}>
                  <code>{item.packageName}</code>
                  <label className="switch" title={item.enabled ? '停用该插件' : '启用该插件'}>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      disabled={busy !== null}
                      onChange={event => onToggleItem(item.packageName, event.target.checked)}
                      aria-label={`${item.enabled ? '停用' : '启用'} ${item.packageName}`}
                    />
                    <span>{toggling && <LoaderCircle className="spin" size={11} />}</span>
                  </label>
                  <button
                    type="button"
                    className="pack-detail-remove"
                    disabled={busy !== null}
                    onClick={() => onRemoveItem(item.packageName)}
                    title="从整合包移除"
                    aria-label={`从整合包移除 ${item.packageName}`}
                  >
                    {removing ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="pack-details-plugins">
        <div className="pack-details-plugins-head">
          <span>包含预设（{pack.presets?.length ?? 0}）</span>
          <button
            type="button"
            className="install-button"
            disabled={busy !== null || presetCandidates.length === 0}
            onClick={() => setAddingPresetsOpen(true)}
            title={presetCandidates.length === 0 ? '没有可添加的预设（需先安装并留有来源记录）' : '从已安装预设中选择加入'}
          >
            <Plus size={14} />添加预设
          </button>
        </div>
        {(pack.presets?.length ?? 0) === 0 ? (
          <div className="pack-details-empty">整合包里还没有 Agent 预设。</div>
        ) : (
          <div className="pack-detail-items">
            {pack.presets!.map(item => {
              const toggling = busy === `pack-toggle-preset:${pack.id}:${item.name}`
              const removing = busy === `pack-remove-preset:${pack.id}:${item.name}`
              return (
                <div className={`pack-detail-item ${item.enabled ? '' : 'disabled'}`} key={item.name}>
                  <code>{item.name}</code>
                  <label className="switch" title={item.enabled ? '停用该预设' : '启用该预设'}>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      disabled={busy !== null}
                      onChange={event => onTogglePreset(item.name, event.target.checked)}
                      aria-label={`${item.enabled ? '停用' : '启用'} 预设 ${item.name}`}
                    />
                    <span>{toggling && <LoaderCircle className="spin" size={11} />}</span>
                  </label>
                  <button
                    type="button"
                    className="pack-detail-remove"
                    disabled={busy !== null}
                    onClick={() => onRemovePreset(item.name)}
                    title="从整合包移除预设"
                    aria-label={`从整合包移除预设 ${item.name}`}
                  >
                    {removing ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="pack-details-plugins">
        <div className="pack-details-plugins-head">
          <span>包含技能（{pack.skills?.length ?? 0}）</span>
          <button
            type="button"
            className="install-button"
            disabled={busy !== null || skillCandidates.length === 0}
            onClick={() => setAddingSkillsOpen(true)}
            title={skillCandidates.length === 0 ? '没有可添加的 Skill（需先安装并留有来源记录）' : '从已安装 Skill 中选择加入'}
          >
            <Plus size={14} />添加技能
          </button>
        </div>
        {(pack.skills?.length ?? 0) === 0 ? (
          <div className="pack-details-empty">整合包里还没有 Skill。</div>
        ) : (
          <div className="pack-detail-items">
            {pack.skills!.map(item => {
              const toggling = busy === `pack-toggle-skill:${pack.id}:${item.name}`
              const removing = busy === `pack-remove-skill:${pack.id}:${item.name}`
              return (
                <div className={`pack-detail-item ${item.enabled ? '' : 'disabled'}`} key={item.name}>
                  <code>{item.name}</code>
                  <label className="switch" title={item.enabled ? '停用该 Skill' : '启用该 Skill'}>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      disabled={busy !== null}
                      onChange={event => onToggleSkill(item.name, event.target.checked)}
                      aria-label={`${item.enabled ? '停用' : '启用'} Skill ${item.name}`}
                    />
                    <span>{toggling && <LoaderCircle className="spin" size={11} />}</span>
                  </label>
                  <button
                    type="button"
                    className="pack-detail-remove"
                    disabled={busy !== null}
                    onClick={() => onRemoveSkill(item.name)}
                    title="从整合包移除 Skill"
                    aria-label={`从整合包移除 Skill ${item.name}`}
                  >
                    {removing ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="pack-details-plugins">
        <div className="pack-details-plugins-head">
          <span>包含应用（{pack.applications?.length ?? 0}）</span>
          <button
            type="button"
            className="install-button"
            disabled={busy !== null || applicationCandidates.length === 0}
            onClick={() => setAddingApplicationsOpen(true)}
            title={applicationCandidates.length === 0 ? '没有可添加的应用加载项' : '从已安装应用加载项中选择加入'}
          >
            <Plus size={14} />添加应用
          </button>
        </div>
        {(pack.applications?.length ?? 0) === 0 ? (
          <div className="pack-details-empty">整合包里还没有 Application Addon。</div>
        ) : (
          <div className="pack-detail-items">
            {pack.applications!.map(item => {
              const toggling = busy === `pack-toggle-application:${pack.id}:${item.id}`
              const removing = busy === `pack-remove-application:${pack.id}:${item.id}`
              return (
                <div className={`pack-detail-item ${item.enabled ? '' : 'disabled'}`} key={item.id}>
                  <code>{item.name}</code>
                  <label className="switch" title={item.enabled ? '停用该应用' : '启用该应用'}>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      disabled={busy !== null}
                      onChange={event => onToggleApplication(item.id, event.target.checked)}
                      aria-label={`${item.enabled ? '停用' : '启用'} 应用 ${item.name}`}
                    />
                    <span>{toggling && <LoaderCircle className="spin" size={11} />}</span>
                  </label>
                  <button
                    type="button"
                    className="pack-detail-remove"
                    disabled={busy !== null}
                    onClick={() => onRemoveApplication(item.id)}
                    title="从整合包移除应用"
                    aria-label={`从整合包移除应用 ${item.name}`}
                  >
                    {removing ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {addingOpen && (
        <AddPluginsDialog
          pack={pack}
          candidates={candidates}
          busy={busy !== null}
          onCancel={() => setAddingOpen(false)}
          onConfirm={packageNames => {
            onAddPlugins(packageNames)
            setAddingOpen(false)
          }}
        />
      )}
      {addingPresetsOpen && (
        <AddPresetsDialog
          pack={pack}
          candidates={presetCandidates}
          busy={busy !== null}
          onCancel={() => setAddingPresetsOpen(false)}
          onConfirm={presetNames => {
            onAddPresets(presetNames)
            setAddingPresetsOpen(false)
          }}
        />
      )}
      {addingSkillsOpen && (
        <AddSkillsDialog
          pack={pack}
          candidates={skillCandidates}
          busy={busy !== null}
          onCancel={() => setAddingSkillsOpen(false)}
          onConfirm={skillNames => {
            onAddSkills(skillNames)
            setAddingSkillsOpen(false)
          }}
        />
      )}
      {addingApplicationsOpen && (
        <AddApplicationsDialog
          pack={pack}
          candidates={applicationCandidates}
          busy={busy !== null}
          onCancel={() => setAddingApplicationsOpen(false)}
          onConfirm={addonIds => {
            onAddApplications(addonIds)
            setAddingApplicationsOpen(false)
          }}
        />
      )}
    </aside>
  )
}

function AddPluginsDialog({ pack, candidates, busy, onCancel, onConfirm }: {
  pack: PackStatus
  candidates: ManagedPlugin[]
  busy: boolean
  onCancel: () => void
  onConfirm: (packageNames: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const toggle = (packageName: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(packageName)) next.delete(packageName)
      else next.add(packageName)
      return next
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onCancel() }}>
      <section className="modal add-plugin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-plugin-title">
        <header>
          <div><Plus size={18} /><h2 id="add-plugin-title">添加插件到「{pack.name}」</h2></div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="modal-content">
          <p className="add-plugin-summary">从当前 Profile 已安装插件中勾选，确认后逐个加入整合包。</p>
          {candidates.length === 0 ? (
            <div className="pack-checklist-empty">当前 Profile 没有可添加的新插件。</div>
          ) : (
            <div className="add-plugin-list">
              {candidates.map(plugin => {
                const checked = selected.has(plugin.packageName)
                return (
                  <label className={`pack-checklist-item ${checked ? 'checked' : ''}`} key={plugin.packageName}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(plugin.packageName)} aria-label={`${checked ? '取消' : '选择'} ${plugin.packageName}`} />
                    <span className="pack-item-glyph">{plugin.displayName.slice(0, 2).toUpperCase()}</span>
                    <span className="pack-checklist-copy">
                      <strong>{plugin.displayName}</strong>
                      <small>{plugin.packageName}</small>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="primary-command" disabled={busy || selected.size === 0} onClick={() => onConfirm(Array.from(selected))}>
            <Plus size={16} />添加 {selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        </footer>
      </section>
    </div>
  )
}

function AddPresetsDialog({ pack, candidates, busy, onCancel, onConfirm }: {
  pack: PackStatus
  candidates: InstalledPreset[]
  busy: boolean
  onCancel: () => void
  onConfirm: (presetNames: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const toggle = (presetName: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(presetName)) next.delete(presetName)
      else next.add(presetName)
      return next
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onCancel() }}>
      <section className="modal add-plugin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-preset-title">
        <header>
          <div><Plus size={18} /><h2 id="add-preset-title">添加预设到「{pack.name}」</h2></div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="modal-content">
          <p className="add-plugin-summary">从当前环境已安装且有来源记录的 Agent 预设中勾选。</p>
          {candidates.length === 0 ? (
            <div className="pack-checklist-empty">当前没有可添加的 Agent 预设。</div>
          ) : (
            <div className="add-plugin-list">
              {candidates.map(preset => {
                const checked = selected.has(preset.name)
                return (
                  <label className={`pack-checklist-item ${checked ? 'checked' : ''}`} key={preset.name}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(preset.name)} aria-label={`${checked ? '取消' : '选择'} 预设 ${preset.name}`} />
                    <span className="pack-item-glyph">{preset.name.slice(0, 2).toUpperCase()}</span>
                    <span className="pack-checklist-copy">
                      <strong>{preset.name}</strong>
                      <small>{preset.repository ?? '本地预设'}</small>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="primary-command" disabled={busy || selected.size === 0} onClick={() => onConfirm(Array.from(selected))}>
            <Plus size={16} />添加 {selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        </footer>
      </section>
    </div>
  )
}

function AddSkillsDialog({ pack, candidates, busy, onCancel, onConfirm }: {
  pack: PackStatus
  candidates: InstalledSkill[]
  busy: boolean
  onCancel: () => void
  onConfirm: (skillNames: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const toggle = (skillName: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(skillName)) next.delete(skillName)
      else next.add(skillName)
      return next
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onCancel() }}>
      <section className="modal add-plugin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-skill-title">
        <header>
          <div><Plus size={18} /><h2 id="add-skill-title">添加 Skill 到「{pack.name}」</h2></div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="modal-content">
          <p className="add-plugin-summary">从当前环境已安装且有来源记录的 Skill 中勾选。</p>
          {candidates.length === 0 ? (
            <div className="pack-checklist-empty">当前没有可添加的 Skill。</div>
          ) : (
            <div className="add-plugin-list">
              {candidates.map(skill => {
                const checked = selected.has(skill.name)
                return (
                  <label className={`pack-checklist-item ${checked ? 'checked' : ''}`} key={skill.name}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(skill.name)} aria-label={`${checked ? '取消' : '选择'} Skill ${skill.name}`} />
                    <span className="pack-item-glyph">{skill.name.slice(0, 2).toUpperCase()}</span>
                    <span className="pack-checklist-copy">
                      <strong>{skill.name}</strong>
                      <small>{skill.repository ?? '本地 Skill'}</small>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="primary-command" disabled={busy || selected.size === 0} onClick={() => onConfirm(Array.from(selected))}>
            <Plus size={16} />添加 {selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        </footer>
      </section>
    </div>
  )
}

function AddApplicationsDialog({ pack, candidates, busy, onCancel, onConfirm }: {
  pack: PackStatus
  candidates: InstalledApplicationAddon[]
  busy: boolean
  onCancel: () => void
  onConfirm: (addonIds: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const toggle = (addonId: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(addonId)) next.delete(addonId)
      else next.add(addonId)
      return next
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onCancel() }}>
      <section className="modal add-plugin-dialog" role="dialog" aria-modal="true" aria-labelledby="add-application-title">
        <header>
          <div><Plus size={18} /><h2 id="add-application-title">添加应用到「{pack.name}」</h2></div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="modal-content">
          <p className="add-plugin-summary">从当前环境已安装的 Application Addon 中勾选。</p>
          {candidates.length === 0 ? (
            <div className="pack-checklist-empty">当前没有可添加的应用加载项。</div>
          ) : (
            <div className="add-plugin-list">
              {candidates.map(addon => {
                const checked = selected.has(addon.id)
                return (
                  <label className={`pack-checklist-item ${checked ? 'checked' : ''}`} key={addon.id}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(addon.id)} aria-label={`${checked ? '取消' : '选择'} 应用 ${addon.name}`} />
                    <span className="pack-item-glyph">{addon.name.slice(0, 2).toUpperCase()}</span>
                    <span className="pack-checklist-copy">
                      <strong>{addon.name}</strong>
                      <small>{addon.repository}</small>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="primary-command" disabled={busy || selected.size === 0} onClick={() => onConfirm(Array.from(selected))}>
            <Plus size={16} />添加 {selected.size > 0 ? `（${selected.size}）` : ''}
          </button>
        </footer>
      </section>
    </div>
  )
}

function RemovePackDialog({ pack, busy, onCancel, onConfirm }: {
  pack: PackStatus
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-pack-title">
        <div className="confirm-icon"><Trash2 size={22} /></div>
        <h2 id="remove-pack-title">删除整合包「{pack.name}」？</h2>
        <p>
          这会移除该整合包及其 Profile。
          {pack.enabled ? '它当前正在使用，删除前会自动停用并恢复默认配置。' : '此操作不可撤销。'}
        </p>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}确认删除
          </button>
        </footer>
      </section>
    </div>
  )
}

function ProfileExportMenu({ profileName, busy, onExportProfile, onExport }: {
  profileName: string
  busy: string | null
  onExportProfile?: (profileName: string, mode: ProfileExportMode) => void
  onExport: () => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const exporting = busy?.startsWith(`profile-export:${profileName}:`) === true
  const anyExporting = busy?.startsWith('profile-export:') === true

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (busy !== null) setOpen(false)
  }, [busy])

  const selectMode = (mode: ProfileExportMode) => {
    setOpen(false)
    if (onExportProfile) onExportProfile(profileName, mode)
    else onExport()
  }

  return (
    <div className="profile-export-menu" ref={menuRef}>
      <button
        type="button"
        className="secondary-button profile-export-trigger"
        disabled={anyExporting}
        onClick={() => setOpen(value => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`导出 Profile「${profileName}」`}
      >
        {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
        导出
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="profile-export-submenu" role="menu" aria-label={`Profile「${profileName}」导出方式`}>
          <button type="button" role="menuitem" disabled={anyExporting} onClick={() => selectMode('light')}>
            <span>轻量导出</span><small>仅记录可追溯的远程来源</small>
          </button>
          <button type="button" role="menuitem" disabled={anyExporting} onClick={() => selectMode('full')}>
            <span>全量导出</span><small>携带插件本体，适合离线导入</small>
          </button>
          <button type="button" role="menuitem" disabled={anyExporting} onClick={() => selectMode('repository')}>
            <span>仓库化导出</span><small>同步到 GitHub Profile 仓库</small>
          </button>
        </div>
      )}
    </div>
  )
}

const packsStyle = `
.profile-environment-panel { margin: 18px 0; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--surface) 92%, var(--accent) 8%); }
.profile-environment-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:12px; }
.profile-environment-heading strong, .profile-environment-heading span { display:block; }
.profile-environment-heading span { color:var(--muted); font-size:12px; margin-top:3px; }
.profile-environment-list { display:grid; gap:8px; }
.profile-environment-row { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:var(--surface); }
.profile-environment-row.selected { border-color:var(--accent); box-shadow:0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
.profile-environment-row small { display:block; color:var(--muted); margin-top:4px; }
.profile-environment-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.profile-export-menu { position: relative; }
.profile-export-trigger { gap: 6px; }
.profile-export-submenu { position: absolute; z-index: 20; top: calc(100% + 6px); right: 0; display: grid; min-width: 214px; padding: 5px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); box-shadow: 0 10px 26px rgba(25, 45, 38, 0.18); }
.profile-export-submenu button { display: grid; gap: 2px; width: 100%; padding: 8px 10px; border: 0; border-radius: 5px; color: var(--text); background: transparent; text-align: left; cursor: pointer; }
.profile-export-submenu button:hover:not(:disabled), .profile-export-submenu button:focus-visible { background: var(--surface-soft); }
.profile-export-submenu button:disabled { color: var(--quiet); cursor: not-allowed; }
.profile-export-submenu span { font-size: 12px; font-weight: 650; }
.profile-export-submenu small { color: var(--muted); font-size: 10px; }
.packs-stats { grid-template-columns: 110px 110px 130px; }

.packs-layout {
  display: grid; grid-template-columns: minmax(640px, 1fr) 320px;
  min-height: 510px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--surface); overflow: hidden;
}
.packs-list-panel { min-width: 0; border-right: 1px solid var(--line); }
.pack-row {
  display: flex; min-height: 96px; align-items: center; justify-content: space-between;
  padding: 12px 14px; gap: 14px; border-bottom: 1px solid var(--line); cursor: pointer;
}
.pack-row:last-child { border-bottom: 0; }
.pack-row:hover { background: var(--surface-soft); }
.pack-row.selected { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.pack-row-main { display: grid; min-width: 0; grid-template-columns: 42px minmax(0, 1fr); align-items: center; gap: 12px; }
.pack-glyph {
  display: grid; width: 40px; height: 40px; place-items: center;
  border: 1px solid #bddae0; border-radius: 8px;
  color: #236a76; background: #edf7f8; font-size: 12px; font-weight: 750;
}
.pack-glyph.zip { color: #75521d; border-color: #ead9bb; background: #fbf6eb; }
.pack-glyph.manifest { color: #2866a0; border-color: #b7cfdd; background: var(--blue-soft); }
.pack-row-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.pack-title-line { display: flex; align-items: center; gap: 7px; }
.pack-title-line strong { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.pack-row-copy p { overflow: hidden; margin: 0; color: var(--muted); font-size: 11px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.pack-row-copy small { color: var(--quiet); font-size: 10px; }
.pack-source-badge { padding: 1px 8px; border: 1px solid #b9d7c7; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-size: 10px; font-weight: 650; }
.pack-state-badge { padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 650; }
.pack-state-badge.complete { color: var(--muted); background: var(--surface-strong); }
.pack-state-badge.partial { color: var(--amber); background: var(--amber-soft); }
.pack-state-badge.failed { color: var(--danger); background: var(--danger-soft); }
.pack-active-badge { padding: 1px 8px; border-radius: 999px; color: #fff; background: var(--accent); font-size: 10px; font-weight: 650; }
.pack-row-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }

.pack-details { display: flex; flex-direction: column; padding: 16px; background: #fbfcfb; }
.pack-details.empty { align-items: center; justify-content: center; color: var(--quiet); font-size: 12px; }
.pack-details-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.pack-details-head h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.pack-details-head p { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 17px; overflow-wrap: anywhere; }
.pack-details-meta { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 7px 12px; margin: 16px 0 0; }
.pack-details-meta > div { display: contents; }
.pack-details-meta dt { color: var(--quiet); font-size: 10px; }
.pack-details-meta dd { margin: 0; font-size: 11px; overflow-wrap: anywhere; }
.pack-details-meta dd.complete { color: var(--accent); }
.pack-details-meta dd.partial { color: var(--amber); }
.pack-details-meta dd.failed { color: var(--danger); }
.pack-details-failures { display: flex; flex-direction: column; margin-top: 14px; gap: 7px; }
.pack-details-failures-head > span { font-size: 11px; font-weight: 650; }
.pack-failure-items { display: flex; flex-direction: column; gap: 5px; }
.pack-failure-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 7px 10px; border: 1px solid #e4bcbc; border-radius: 6px; background: #fff5f4;
}
.pack-failure-row code { color: var(--danger); font-size: 10px; }
.pack-failure-row span { color: var(--muted); font-size: 10px; text-align: right; overflow-wrap: anywhere; }
.pack-details-plugins { display: flex; min-height: 0; flex-direction: column; margin-top: 18px; gap: 8px; }
.pack-details-plugins-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pack-details-plugins-head > span { font-size: 11px; font-weight: 650; }
.pack-detail-items { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.pack-detail-item {
  display: grid; grid-template-columns: minmax(0, 1fr) 35px 26px;
  align-items: center; padding: 7px 9px; gap: 6px;
  border-bottom: 1px solid var(--line); background: #fff;
}
.pack-detail-item:last-child { border-bottom: 0; }
.pack-detail-item.disabled { background: #f7f9f7; }
.pack-detail-item.disabled code { color: var(--quiet); text-decoration: line-through; }
.pack-detail-item code { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pack-detail-remove {
  display: grid; width: 25px; height: 25px; place-items: center;
  border: 0; border-radius: 5px; color: var(--muted); background: transparent; cursor: pointer;
}
.pack-detail-remove:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.pack-detail-remove:disabled { cursor: default; opacity: 0.45; }
.pack-details-empty { display: flex; min-height: 70px; align-items: center; justify-content: center; border: 1px dashed var(--line-strong); border-radius: 6px; color: var(--quiet); font-size: 11px; }

.empty-state-actions { display: flex; gap: 9px; }

.add-plugin-dialog { width: min(540px, calc(100vw - 32px)); }
.add-plugin-dialog > header { display: flex; min-height: 56px; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid var(--line); }
.add-plugin-dialog > header > div { display: flex; align-items: center; gap: 9px; }
.add-plugin-summary { margin: 0 0 10px; color: var(--muted); font-size: 11px; line-height: 17px; }
.add-plugin-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow-y: auto; }

/* 与 CreatePackDialog 共享的插件勾选行样式（inline style 只在组件挂载时存在，这里重复声明保证独立可用）。 */
.pack-checklist-item {
  display: grid; grid-template-columns: 15px 28px minmax(0, 1fr);
  align-items: center; padding: 8px 9px; gap: 8px;
  border: 1px solid var(--line); border-radius: 6px; background: #fff; cursor: pointer;
}
.pack-checklist-item input { width: 14px; height: 14px; accent-color: var(--accent); }
.pack-checklist-item.checked { border-color: #b9d7c7; background: var(--accent-soft); }
.pack-item-glyph {
  display: grid; width: 27px; height: 27px; place-items: center;
  border: 1px solid #bddae0; border-radius: 6px;
  color: #236a76; background: #edf7f8; font-size: 10px; font-weight: 700;
}
.pack-checklist-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.pack-checklist-copy strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.pack-checklist-copy small { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pack-checklist-empty {
  display: flex; min-height: 90px; align-items: center; justify-content: center;
  margin-top: 9px; border: 1px dashed var(--line-strong); border-radius: 6px;
  color: var(--muted); font-size: 11px;
}
`
