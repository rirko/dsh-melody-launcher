import { PackagePlus, X } from 'lucide-react'
import { useState } from 'react'
import type { InstalledApplicationAddon, InstalledPreset, InstalledSkill, ManagedPlugin } from '../../types'

/**
 * 自建整合包表单：名称（实时派生包 id）/描述 + 从当前 Profile 已装插件勾选。
 * 确认后由 App 交给 use-pack-install.startCreate，本对话框随即关闭，
 * 安装中/结果态由 PackInstallDialog 展示。
 */

type ResourceTab = 'plugins' | 'presets' | 'skills' | 'applications'

export interface CreatePackDialogProps {
  /** 当前 profile 已安装插件（含内置；内置会自动过滤），用 packageName 作为选择键。 */
  plugins: ManagedPlugin[]
  /** 已安装的 Agent 预设；即使没有来源记录也会随包离线导出。 */
  presets: InstalledPreset[]
  /** 已安装且带来源记录的 Skill。 */
  skills: InstalledSkill[]
  /** 已安装的 Application Addon。 */
  applications: InstalledApplicationAddon[]
  onConfirm: (request: { name: string; description: string; packageNames: string[]; presetNames: string[]; skillNames: string[]; applicationIds: string[] }) => void
  onClose: () => void
}

/**
 * 与主进程 pack-manifest.packProfileName 一致的包 id 派生规则（仅展示用预览）。
 * 注意与主进程保持同一变换：仅小写化并把非 [a-z0-9._-] 字符替换为 `-`，不做首尾清理。
 */
export function packIdFromName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  return `pack-${safe || 'untitled'}`
}

export function CreatePackDialog({ plugins, presets, skills, applications, onConfirm, onClose }: CreatePackDialogProps) {
  // 内置 Bundle（核心插件）由启动器/DSH 自己提供，不属于用户可导出资源，不出现在勾选列表。
  const selectablePlugins = plugins.filter(plugin => !plugin.builtin)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectablePlugins.filter(plugin => plugin.enabled).map(plugin => plugin.packageName)),
  )
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(() => new Set())
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(() => new Set())
  const [selectedApplications, setSelectedApplications] = useState<Set<string>>(() => new Set())
  const [resourceTab, setResourceTab] = useState<ResourceTab>('plugins')

  const toggle = (packageName: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(packageName)) next.delete(packageName)
      else next.add(packageName)
      return next
    })
  }

  const togglePreset = (presetName: string) => {
    setSelectedPresets(current => {
      const next = new Set(current)
      if (next.has(presetName)) next.delete(presetName)
      else next.add(presetName)
      return next
    })
  }

  const toggleSkill = (skillName: string) => {
    setSelectedSkills(current => {
      const next = new Set(current)
      if (next.has(skillName)) next.delete(skillName)
      else next.add(skillName)
      return next
    })
  }

  const toggleApplication = (addonId: string) => {
    setSelectedApplications(current => {
      const next = new Set(current)
      if (next.has(addonId)) next.delete(addonId)
      else next.add(addonId)
      return next
    })
  }

  const canSubmit = name.trim().length > 0 && (
    selected.size > 0 || selectedPresets.size > 0 || selectedSkills.size > 0 || selectedApplications.size > 0
  )
  const packId = packIdFromName(name)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal create-pack-dialog" role="dialog" aria-modal="true" aria-labelledby="create-pack-title">
        <header>
          <div><PackagePlus size={19} /><h2 id="create-pack-title">创建整合包</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content create-pack-content">
          <div className="form-section">
            <h3>基本信息</h3>
            <label className="form-field">
              <span>名称</span>
              <span className="pack-name-wrap">
                <input
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder="例如：我的日常工作包"
                  autoFocus
                />
                <small>包 ID：<code>{packId}</code></small>
              </span>
            </label>
            <label className="form-field">
              <span>描述</span>
              <textarea
                className="pack-desc-input"
                value={description}
                onChange={event => setDescription(event.target.value)}
                placeholder="选填：这个整合包用来做什么？"
                rows={2}
              />
            </label>
          </div>
          <div className="form-section divided">
            <div className="pack-resource-tabs" role="tablist" aria-label="选择要加入整合包的资源类型">
              <button type="button" role="tab" aria-selected={resourceTab === 'plugins'} className={resourceTab === 'plugins' ? 'active' : ''} onClick={() => setResourceTab('plugins')}>
                插件 <span>{selected.size}/{selectablePlugins.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={resourceTab === 'presets'} className={resourceTab === 'presets' ? 'active' : ''} onClick={() => setResourceTab('presets')}>
                预设 <span>{selectedPresets.size}/{presets.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={resourceTab === 'skills'} className={resourceTab === 'skills' ? 'active' : ''} onClick={() => setResourceTab('skills')}>
                技能 <span>{selectedSkills.size}/{skills.length}</span>
              </button>
              <button type="button" role="tab" aria-selected={resourceTab === 'applications'} className={resourceTab === 'applications' ? 'active' : ''} onClick={() => setResourceTab('applications')}>
                应用 <span>{selectedApplications.size}/{applications.length}</span>
              </button>
            </div>

            {resourceTab === 'plugins' && (
              <div className="pack-resource-panel">
                <h3>包含插件（已选 {selected.size} / {selectablePlugins.length}）</h3>
                <p>从当前已安装插件中挑选（内置核心插件不参与打包）；创建后会把这些插件组合进新的整合包 Profile。</p>
                {selectablePlugins.length === 0 ? (
                  <div className="pack-checklist-empty">当前 Profile 还没有可挑选的插件，先安装一些插件再来创建。</div>
                ) : (
                  <div className="pack-plugin-checklist">
                    {selectablePlugins.map(plugin => {
                      const checked = selected.has(plugin.packageName)
                      return (
                        <label className={`pack-checklist-item ${checked ? 'checked' : ''} ${plugin.enabled ? '' : 'muted'}`} key={plugin.packageName}>
                          <input type="checkbox" checked={checked} onChange={() => toggle(plugin.packageName)} aria-label={`${checked ? '取消' : '选择'} ${plugin.packageName}`} />
                          <span className="pack-item-glyph">{plugin.displayName.slice(0, 2).toUpperCase()}</span>
                          <span className="pack-checklist-copy">
                            <strong>{plugin.displayName}</strong>
                            <small>{plugin.packageName}{plugin.enabled ? '' : ' · 已停用'}</small>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {resourceTab === 'presets' && (
              <div className="pack-resource-panel">
                <h3>包含预设（已选 {selectedPresets.size} / {presets.length}）</h3>
                <p>从已安装的 Agent 预设中挑选；即使没有来源记录，也会把本地预设本体打进整合包离线导出。</p>
                {presets.length === 0 ? (
                  <div className="pack-checklist-empty">当前环境还没有可加入整合包的 Agent 预设。</div>
                ) : (
                  <div className="pack-plugin-checklist">
                    {presets.map(preset => {
                      const addable = Boolean(preset.repository && preset.sourcePath && preset.revision)
                      const checked = selectedPresets.has(preset.name)
                      return (
                        <label className={`pack-checklist-item ${checked ? 'checked' : ''}`} key={preset.name}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePreset(preset.name)}
                            aria-label={`${checked ? '取消' : '选择'} 预设 ${preset.name}`}
                          />
                          <span className="pack-item-glyph">{preset.name.slice(0, 2).toUpperCase()}</span>
                          <span className="pack-checklist-copy">
                            <strong>{preset.name}</strong>
                            <small>{addable ? `${preset.repository} · ${preset.sourcePath}` : '无来源记录，将随包离线导出'}</small>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {resourceTab === 'skills' && (
              <div className="pack-resource-panel">
                <h3>包含技能（已选 {selectedSkills.size} / {skills.length}）</h3>
                <p>从已安装且有来源记录的 Skill 中挑选。</p>
                {skills.length === 0 ? (
                  <div className="pack-checklist-empty">当前环境还没有可加入整合包的 Skill。</div>
                ) : (
                  <div className="pack-plugin-checklist">
                    {skills.map(skill => {
                      const addable = Boolean(skill.repository && skill.sourcePath && skill.revision)
                      const checked = selectedSkills.has(skill.name)
                      return (
                        <label className={`pack-checklist-item ${checked ? 'checked' : ''} ${addable ? '' : 'muted'}`} key={skill.name}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!addable}
                            onChange={() => toggleSkill(skill.name)}
                            aria-label={`${checked ? '取消' : '选择'} Skill ${skill.name}`}
                          />
                          <span className="pack-item-glyph">{skill.name.slice(0, 2).toUpperCase()}</span>
                          <span className="pack-checklist-copy">
                            <strong>{skill.name}</strong>
                            <small>{addable ? `${skill.repository} · ${skill.sourcePath}` : '无来源记录，不可加入'}</small>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {resourceTab === 'applications' && (
              <div className="pack-resource-panel">
                <h3>包含应用（已选 {selectedApplications.size} / {applications.length}）</h3>
                <p>从已安装的 Application Addon 中挑选。</p>
                {applications.length === 0 ? (
                  <div className="pack-checklist-empty">当前环境还没有可加入整合包的应用加载项。</div>
                ) : (
                  <div className="pack-plugin-checklist">
                    {applications.map(addon => {
                      const checked = selectedApplications.has(addon.id)
                      return (
                        <label className={`pack-checklist-item ${checked ? 'checked' : ''}`} key={addon.id}>
                          <input type="checkbox" checked={checked} onChange={() => toggleApplication(addon.id)} aria-label={`${checked ? '取消' : '选择'} 应用 ${addon.name}`} />
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
            )}
          </div>
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-command"
            disabled={!canSubmit}
            onClick={() => onConfirm({
              name: name.trim(),
              description: description.trim(),
              packageNames: selectablePlugins.filter(plugin => selected.has(plugin.packageName)).map(plugin => plugin.packageName),
              presetNames: presets.filter(preset => selectedPresets.has(preset.name)).map(preset => preset.name),
              skillNames: skills.filter(skill => selectedSkills.has(skill.name)).map(skill => skill.name),
              applicationIds: applications.filter(addon => selectedApplications.has(addon.id)).map(addon => addon.id),
            })}
          >
            <PackagePlus size={16} />创建整合包
          </button>
        </footer>
      </section>
      <style>{createPackStyle}</style>
    </div>
  )
}

const createPackStyle = `
.create-pack-dialog { width: min(620px, calc(100vw - 32px)); }
.create-pack-content { max-height: min(76vh, 640px); }
.pack-name-wrap { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.pack-name-wrap small { color: var(--quiet); font-size: 10px; }
.pack-name-wrap code { color: var(--accent); font-family: Consolas, monospace; }
.pack-desc-input {
  width: 100%; min-width: 0; padding: 8px 9px;
  border: 1px solid var(--line-strong); border-radius: 5px;
  color: var(--ink); background: #fff;
  font-family: inherit; font-size: 11px; line-height: 16px; resize: vertical;
}
.pack-plugin-checklist {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 7px; margin-top: 9px; max-height: 260px; overflow-y: auto;
}
.pack-checklist-item {
  display: grid; grid-template-columns: 15px 28px minmax(0, 1fr);
  align-items: center; padding: 8px 9px; gap: 8px;
  border: 1px solid var(--line); border-radius: 6px; background: #fff; cursor: pointer;
}
.pack-checklist-item input { width: 14px; height: 14px; accent-color: var(--accent); }
.pack-checklist-item.checked { border-color: #b9d7c7; background: var(--accent-soft); }
.pack-checklist-item.muted { opacity: 0.6; }
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
.pack-resource-tabs {
  display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap;
}
.pack-resource-tabs button {
  padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--surface-soft); color: var(--muted); font-size: 11px; cursor: pointer;
}
.pack-resource-tabs button.active {
  border-color: #b9d7c7; color: var(--accent); background: var(--accent-soft); font-weight: 650;
}
.pack-resource-tabs button span { margin-left: 4px; opacity: 0.75; }
.pack-resource-panel h3 { margin: 0; font-size: 12px; }
.pack-resource-panel p { margin: 3px 0 0; color: var(--muted); font-size: 10px; line-height: 16px; }
`
