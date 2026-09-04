import { CircleAlert, Download, GitFork, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { NonstandardPackImportPreview, PackPluginEntry, ProfileRepositoryImportMode, ProfileRepositoryImportPreview } from '../../types'

export interface ProfileRepositoryImportDialogProps {
  open: boolean
  url: string
  preview: ProfileRepositoryImportPreview | null
  nonstandardPreview?: NonstandardPackImportPreview | null
  busy: boolean
  error: string | null
  onUrlChange: (value: string) => void
  onAnalyze: () => void
  onConfirm: (mode: ProfileRepositoryImportMode, name?: string, overwrite?: boolean, resolutions?: Record<string, PackPluginEntry>) => void
  onConfirmNonstandard?: (name?: string, packageNames?: string[], installDsh?: boolean) => void
  onClose: () => void
}

export function ProfileRepositoryImportDialog({ open, url, preview, nonstandardPreview, busy, error, onUrlChange, onAnalyze, onConfirm, onConfirmNonstandard, onClose }: ProfileRepositoryImportDialogProps) {
  const [mode, setMode] = useState<ProfileRepositoryImportMode>('source')
  const [name, setName] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [resolutions, setResolutions] = useState<Record<string, PackPluginEntry>>({})
  const [selectedNonstandard, setSelectedNonstandard] = useState<string[]>([])
  const [installDsh, setInstallDsh] = useState(true)

  useEffect(() => {
    if (preview) {
      setName(preview.profileName)
      setMode('source')
      setOverwrite(false)
      setResolutions({})
    } else if (nonstandardPreview) {
      setName(nonstandardPreview.profileName)
      setMode('source')
      setOverwrite(false)
      setResolutions({})
    }
    setSelectedNonstandard(nonstandardPreview?.plugins.filter(plugin => plugin.source !== 'unavailable').map(plugin => plugin.packageName) ?? [])
    setInstallDsh(true)
  }, [preview, nonstandardPreview])

  if (!open) return null
  const unresolved = preview?.plugins.some(plugin => (plugin.match === 'missing') || (plugin.match === 'ambiguous' && !resolutions[plugin.packageName])) ?? false
  const nonstandard = nonstandardPreview !== null && nonstandardPreview !== undefined
  const canConfirm = (nonstandard ? Boolean(nonstandardPreview) && selectedNonstandard.length > 0 : Boolean(preview)) && !busy && name.trim().length > 0
    && (mode === 'source' ? !unresolved : preview?.hasFullPackage === true)
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onClose() }}>
      <section className="modal pack-install-dialog profile-repository-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-repository-title">
        <header>
          <div><GitFork size={19} /><h2 id="profile-repository-title">从 GitHub 导入 Profile / 整合包</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="modal-content pack-install-content">
          <label className="pack-preview-name">
            <span>GitHub 仓库链接</span>
            <div className="profile-repository-url-row">
              <input value={url} onChange={event => onUrlChange(event.target.value)} placeholder="https://github.com/owner/repository" disabled={busy} />
              <button type="button" className="secondary-button" onClick={onAnalyze} disabled={busy || !url.trim()}>{busy && !preview ? <LoaderCircle className="spin" size={15} /> : null}解析仓库</button>
            </div>
          </label>
          {error && <div className="pack-error-banner"><CircleAlert size={16} /><span>{error}</span></div>}
          {preview && !nonstandard && (
            <div className="pack-preview">
              <div className="pack-preview-head"><div><strong>{preview.profileName}</strong><span>{preview.description}</span></div><span className="pack-source-badge">{preview.repository} · {preview.branch}</span></div>
              <label className="pack-preview-name"><span>新 Profile 名称</span><input value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
              <p className="pack-preview-meta">清单 {preview.manifestPath} · commit {preview.commit?.slice(0, 8) ?? '未知'} · DSH {preview.dshVersion}（{preview.dshVersionInstalled === false ? '确认后自动安装' : '已安装'}） · {preview.plugins.length} 个插件</p>
              {preview.differences.length > 0 && <div className="profile-import-differences"><strong>相对上次导入的变化</strong>{preview.differences.map((difference, index) => <span key={`${difference.kind}-${difference.packageName}-${index}`}>{difference.packageName}：{difference.detail}</span>)}</div>}
              <div className="profile-import-mode-picker" role="radiogroup" aria-label="安装方式">
                <label className={mode === 'source' ? 'selected' : ''}><input type="radio" checked={mode === 'source'} onChange={() => setMode('source')} />来源安装<small>只按清单从 npm/GitHub 安装，不读取完整包</small></label>
                <label className={mode === 'full' ? 'selected' : ''}><input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} />完整安装<small>{preview.hasFullPackage ? '确认后读取 profile.zip 并还原插件本体' : '仓库没有 profile.zip，无法完整安装'}</small></label>
              </div>
              {preview.plugins.length > 0 && <div className="profile-import-plugin-list">{preview.plugins.map(plugin => <div key={plugin.packageName}><span>{plugin.order + 1}. {plugin.packageName}</span>{plugin.match === 'ambiguous' ? <select value={resolutions[plugin.packageName] ? JSON.stringify(resolutions[plugin.packageName]) : ''} onChange={event => { const selected = plugin.candidates.find(candidate => JSON.stringify(candidate) === event.target.value); if (selected) setResolutions(current => ({ ...current, [plugin.packageName]: selected })) }}><option value="">选择来源</option>{plugin.candidates.map(candidate => <option key={JSON.stringify(candidate)} value={JSON.stringify(candidate)}>{candidate.repository ?? candidate.source} · {candidate.version ?? '未知版本'}</option>)}</select> : <small>{plugin.match === 'declared' ? '来源已声明' : plugin.match === 'matched' ? '已匹配本地来源' : plugin.reason}</small>}</div>)}</div>}
              {preview.blockers.length > 0 && mode === 'source' && <div className="pack-error-banner"><CircleAlert size={16} /><span>{preview.blockers.join('；')}</span></div>}
              <label className="profile-import-overwrite"><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />覆盖同名 Profile（导入前创建快照）</label>
            </div>
          )}
          {nonstandardPreview && (
            <div className="pack-preview">
              <div className="pack-preview-head"><div><strong>{nonstandardPreview.name}</strong><span>{nonstandardPreview.description}</span></div><span className="pack-source-badge">{nonstandardPreview.repository} · {nonstandardPreview.branch}</span></div>
              <label className="pack-preview-name"><span>新 Profile 名称</span><input value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
              <p className="pack-preview-meta">仓库类型：{nonstandardPreview.kind} · commit {nonstandardPreview.commit?.slice(0, 8) ?? '未知'} · DSH {nonstandardPreview.dshVersion ?? '未声明'} · {nonstandardPreview.plugins.length} 个插件</p>
              {nonstandardPreview.dshVersion && <label className="profile-import-overwrite"><input type="checkbox" checked={nonstandardPreview.dshVersionInstalled || installDsh} disabled={nonstandardPreview.dshVersionInstalled === true || busy} onChange={event => setInstallDsh(event.target.checked)} />{nonstandardPreview.dshVersionInstalled ? `DSH ${nonstandardPreview.dshVersion} 已安装` : `安装整合包要求的 DSH ${nonstandardPreview.dshVersion}`}</label>}
              {nonstandardPreview.warnings.map((warning, index) => <div className="pack-error-banner" key={`warning-${index}`}><CircleAlert size={16} /><span>{warning}</span></div>)}
              <div className="profile-import-plugin-list">{nonstandardPreview.plugins.map(plugin => <label key={plugin.componentId}><input type="checkbox" checked={selectedNonstandard.includes(plugin.packageName)} disabled={plugin.source === 'unavailable' || busy} onChange={event => setSelectedNonstandard(current => event.target.checked ? [...current, plugin.packageName] : current.filter(name => name !== plugin.packageName))} /><span>{plugin.order + 1}. {plugin.packageName}</span><small>{plugin.category} · {plugin.sourceLabel}{plugin.reason ? ` · ${plugin.reason}` : ''}</small></label>)}</div>
              {nonstandardPreview.skipped.length > 0 && <div className="profile-import-differences"><strong>跳过的非插件组件</strong>{nonstandardPreview.skipped.map(item => <span key={item.id}>{item.name}：{item.reason}</span>)}</div>}
              {nonstandardPreview.blockers.length > 0 && <div className="pack-error-banner"><CircleAlert size={16} /><span>{nonstandardPreview.blockers.join('；')}</span></div>}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="primary-command" disabled={!canConfirm} onClick={() => nonstandard ? onConfirmNonstandard?.(name.trim(), selectedNonstandard, installDsh) : onConfirm(mode, name.trim(), overwrite, resolutions)}><Download size={16} />确认导入</button>
        </footer>
      </section>
    </div>
  )
}
