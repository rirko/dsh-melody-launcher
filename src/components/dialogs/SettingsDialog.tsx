import { Check, Download, Folder, Globe, ImagePlus, LoaderCircle, Palette, RotateCcw, Settings, X } from 'lucide-react'
import { useState } from 'react'
import { useLauncherApi } from '../../api/client'
import type { AppSettings, UiTheme } from '../../types'

/** 启动器设置：DSH_HOME、Profile、启动命令与工作目录。 */

interface SettingsDialogProps {
  settings: AppSettings
  busy: boolean
  onClose: () => void
  onSave: (settings: AppSettings) => void
  /** 一键下载并启用官方推荐整合包（DSH Web UI）。 */
  onDownloadRecommendedWebUi?: () => void
}

const UI_THEMES: Array<{ id: UiTheme; label: string }> = [
  { id: 'forest', label: '松林' },
  { id: 'ocean', label: '海湾' },
  { id: 'berry', label: '莓果' },
  { id: 'graphite', label: '石墨' },
]

export function SettingsDialog({ settings, busy, onClose, onSave, onDownloadRecommendedWebUi }: SettingsDialogProps) {
  const api = useLauncherApi()
  const [draft, setDraft] = useState(settings)
  // 参数在界面上是一整行文本，保存时才切成数组。
  const [argsText, setArgsText] = useState(settings.launchArgs.join(' '))

  const chooseDirectory = async (kind: 'dshInstallPath' | 'dshHome' | 'workspace') => {
    const chosen = await api.chooseDirectory(kind)
    if (chosen) setDraft(current => ({ ...current, [kind]: chosen }))
  }

  // 插图文件在选择时已复制进 launcher-assets；真正的清理发生在「保存设置」时。
  const chooseBackground = async () => {
    const name = await api.chooseLauncherBackground().catch(() => null)
    if (name) setDraft(current => ({ ...current, launcherBackground: name }))
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
      <section className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><Settings size={19} /><h2 id="settings-title">启动器设置</h2></div><button type="button" className="icon-button settings-close-button" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onClose() }} aria-label="关闭设置"><X size={18} /></button></header>
        <div className="modal-content">
          <div className="form-section"><h3>DSH 配置</h3><p>本体目录存放 DSH 程序与依赖；DSH_HOME 存放 Profile、配置、插件和 Skills。</p></div>
          <label className="form-field"><span>本体安装目录</span><div className="path-input"><input value={draft.dshInstallPath} onChange={event => setDraft({ ...draft, dshInstallPath: event.target.value })} /><button type="button" onClick={() => void chooseDirectory('dshInstallPath')} title="选择 DSH 本体安装目录"><Folder size={17} /></button></div></label>
          <label className="form-field"><span>DSH_HOME</span><div className="path-input"><input value={draft.dshHome} onChange={event => setDraft({ ...draft, dshHome: event.target.value })} /><button type="button" onClick={() => void chooseDirectory('dshHome')} title="选择 DSH_HOME"><Folder size={17} /></button></div></label>
          <label className="form-field"><span>Profile 名称</span><input value={draft.profileName} onChange={event => setDraft({ ...draft, profileName: event.target.value })} /></label>
          <div className="form-section divided"><h3>启动命令</h3><p>默认使用官方 npm 包启动 Web 工作台。</p></div>
          <label className="form-field"><span>可执行文件</span><input value={draft.launchExecutable} onChange={event => setDraft({ ...draft, launchExecutable: event.target.value })} /></label>
          <label className="form-field"><span>参数</span><input value={argsText} onChange={event => setArgsText(event.target.value)} /></label>
          <label className="form-field"><span>首选 Web 端口</span><input type="number" min={1} max={65535} step={1} value={draft.webPort} onChange={event => setDraft({ ...draft, webPort: Number(event.target.value) })} /></label>
          <label className="form-field"><span>工作目录</span><div className="path-input"><input value={draft.workspace} onChange={event => setDraft({ ...draft, workspace: event.target.value })} /><button type="button" onClick={() => void chooseDirectory('workspace')} title="选择工作目录"><Folder size={17} /></button></div></label>
          <label className="check-field"><input type="checkbox" checked={draft.openAfterLaunch} onChange={event => setDraft({ ...draft, openAfterLaunch: event.target.checked })} /><span><strong>启动后打开 Harness</strong><small>识别到本地 Web 地址时，在默认浏览器中打开。</small></span></label>
          <div className="form-section divided theme-section-title"><Palette size={16} /><h3>界面主题</h3></div>
          <div className="theme-options" role="radiogroup" aria-label="界面主题">
            {UI_THEMES.map(theme => (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={(draft.uiTheme ?? 'forest') === theme.id}
                className={`theme-option ${(draft.uiTheme ?? 'forest') === theme.id ? 'selected' : ''}`}
                onClick={() => setDraft({ ...draft, uiTheme: theme.id })}
              >
                <span className={`theme-swatch ${theme.id}`} aria-hidden="true"><i /><i /><i /></span>
                <span>{theme.label}</span>
                {(draft.uiTheme ?? 'forest') === theme.id && <Check size={14} />}
              </button>
            ))}
          </div>
          <div className="launcher-background-picker">
            <img
              className="launcher-background-preview"
              src={draft.launcherBackground ? `launcher-asset://${draft.launcherBackground}` : '/launcher-background.png'}
              alt="主界面插图预览"
            />
            <div className="launcher-background-actions">
              <div>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void chooseBackground()}><ImagePlus size={15} />更换插图</button>
                {draft.launcherBackground && (
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft({ ...draft, launcherBackground: null })}><RotateCcw size={15} />恢复默认</button>
                )}
              </div>
              <small>自定义主界面背景图，支持 PNG / JPG / WebP，不超过 8MB；保存设置后生效。</small>
            </div>
          </div>
          <div className="form-section divided"><h3>DSH Copilot</h3><p>默认模式会把自定义内容追加到内置提示词；开发者模式可替换基础提示词，但凭据保护、工作区边界和操作审批始终有效。</p></div>
          <label className="check-field"><input type="checkbox" checked={Boolean(draft.aiDeveloperMode)} onChange={event => setDraft({ ...draft, aiDeveloperMode: event.target.checked })} /><span><strong>开发者模式</strong><small>允许使用下面的内容替换 Copilot 基础 persona。</small></span></label>
          <label className="form-field copilot-prompt-field"><span>AI 分析提示词</span><textarea rows={7} value={draft.aiPrompt ?? ''} placeholder="留空使用内置 DSH Copilot 提示词。" onChange={event => setDraft({ ...draft, aiPrompt: event.target.value })} /><small>{draft.aiDeveloperMode ? '当前：替换基础 persona；固定安全规则仍会自动追加。' : '当前：作为附加开发指引追加到内置提示词。'}</small></label>
          <div className="settings-inline-actions"><button type="button" className="secondary-button" onClick={() => setDraft({ ...draft, aiPrompt: '' })}>恢复默认提示词</button></div>
          <div className="form-section divided"><h3>网络</h3><p>默认使用国内 npm 镜像（npmmirror），并自动跟随 Windows 系统代理；留空即可。</p></div>
          <label className="form-field"><span>npm 镜像</span><input value={draft.network?.npmRegistry ?? ''} placeholder="https://registry.npmmirror.com" onChange={event => setDraft({ ...draft, network: { ...draft.network, npmRegistry: event.target.value } })} /></label>
          <label className="form-field"><span>代理地址</span><input value={draft.network?.proxy ?? ''} placeholder="留空自动探测系统代理；如 http://127.0.0.1:7890" onChange={event => setDraft({ ...draft, network: { ...draft.network, proxy: event.target.value } })} /></label>
          <label className="form-field"><span>GitHub 镜像</span><input value={draft.network?.githubMirror ?? ''} placeholder="可选，留空不启用；如 https://gh-proxy.com" onChange={event => setDraft({ ...draft, network: { ...draft.network, githubMirror: event.target.value } })} /></label>
          <label className="check-field"><Globe size={15} /><small>直连 GitHub 不稳时，可配置代理或 GitHub 镜像后重试 DSH Market 安装；npm 安装始终优先镜像。</small></label>
          <div className="form-section divided"><h3>下载限制</h3><p>资源市场 Skill 仓库超过体积上限时停止安装，避免误装超大仓库；上调上限时，解压体积与文件数防线会同步放宽。</p></div>
          <label className="form-field"><span>Skill 压缩包上限（MB）</span><input type="number" min={16} max={2048} step={1} value={draft.skillMaxArchiveMb ?? 64} onChange={event => { const parsed = Number(event.target.value); setDraft({ ...draft, skillMaxArchiveMb: event.target.value === '' || !Number.isFinite(parsed) ? undefined : parsed }) }} /><small>16–2048；默认 64。保存后对下一次安装生效。</small></label>
          <div className="form-section divided"><h3>官方推荐</h3><p>一键安装官方推荐的「DSH Web UI」全家桶整合包，获得更佳使用体验。</p></div>
          {onDownloadRecommendedWebUi && <div className="recommended-action-row"><button type="button" className="primary-command" disabled={busy} onClick={onDownloadRecommendedWebUi}><Download size={16} />下载官方推荐整合包 DSH Web UI</button><small>可能与您已安装的其它插件冲突，建议首次尝试只启用这一个插件（可在启动项管理中调整）。</small></div>}
        </div>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-command" disabled={busy} onClick={() => onSave({ ...draft, launchArgs: argsText.trim().split(/\s+/).filter(Boolean) })}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存设置</button></footer>
      </section>
    </div>
  )
}
