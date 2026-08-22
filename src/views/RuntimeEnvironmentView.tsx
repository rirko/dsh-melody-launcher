import { Check, Cpu, Download, FolderOpen, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { RuntimeEnvironmentState, RuntimeVersionCandidate } from '../types'

interface RuntimeEnvironmentViewProps {
  state: RuntimeEnvironmentState | null
  busy: boolean
  onRefresh: () => void
  onInstallDsh: (version: string) => Promise<boolean>
  onSelectDsh: (version: string) => Promise<boolean>
  onRemoveDsh: (version: string) => Promise<boolean>
  onInstallNode: (version: string) => Promise<boolean>
  onSelectNode: (version: string | null) => Promise<boolean>
  onRemoveNode: (version: string) => Promise<boolean>
  onOpenDshFolder: () => void
  onOpenNodeFolder: () => void
}

export function RuntimeEnvironmentView({
  state,
  busy,
  onRefresh,
  onInstallDsh,
  onSelectDsh,
  onRemoveDsh,
  onInstallNode,
  onSelectNode,
  onRemoveNode,
  onOpenDshFolder,
  onOpenNodeFolder,
}: RuntimeEnvironmentViewProps) {
  const [dshVersion, setDshVersion] = useState('')
  const [nodeVersion, setNodeVersion] = useState('')
  const dshChoices = useMemo(() => state ? mergeCandidates(state.dshAvailable, state.dshInstalled.map(item => ({ version: item.version, label: null, lts: null, date: null, prerelease: item.version.includes('-') }))) : [], [state])
  const nodeChoices = useMemo(() => state ? mergeCandidates(state.nodeAvailable, state.nodeInstalled.filter(item => item.version !== 'system').map(item => ({ version: item.version, label: null, lts: null, date: null, prerelease: item.version.includes('-') }))) : [], [state])

  if (!state) {
    return <div className="page runtime-environment-page"><div className="environment-loading"><LoaderCircle className="spin" size={20} />正在读取运行环境版本</div></div>
  }

  const installDsh = async () => {
    const version = dshVersion.trim()
    if (!version) return
    if (await onInstallDsh(version)) setDshVersion('')
  }
  const installNode = async () => {
    const version = nodeVersion.trim()
    if (!version) return
    if (await onInstallNode(version)) setNodeVersion('')
  }

  return (
    <div className="page runtime-environment-page">
      <div className="management-titlebar environment-titlebar">
        <div>
          <span className="management-eyebrow">RUNTIME ENVIRONMENT</span>
          <h1>运行环境</h1>
          <p>并行管理 DSH 与 Node.js 版本，当前选中的版本会用于启动和资源安装。</p>
        </div>
        <div className="management-title-actions">
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={busy}><RefreshCw size={17} />刷新版本</button>
        </div>
      </div>

      <div className="environment-grid">
        <RuntimeVersionPanel
          kind="dsh"
          title="DSH 版本管理"
          icon={<Cpu size={18} />}
          selectedVersion={state.dshSelectedVersion}
          installed={state.dshInstalled}
          candidates={dshChoices}
          input={dshVersion}
          busy={busy}
          onInput={setDshVersion}
          onInstall={() => void installDsh()}
          onSelect={onSelectDsh}
          onRemove={onRemoveDsh}
          onOpenFolder={onOpenDshFolder}
        />
        <RuntimeVersionPanel
          kind="node"
          title="Node.js 版本管理"
          icon={<Cpu size={18} />}
          selectedVersion={state.nodeSelectedVersion}
          installed={state.nodeInstalled}
          candidates={nodeChoices}
          input={nodeVersion}
          busy={busy}
          onInput={setNodeVersion}
          onInstall={() => void installNode()}
          onSelect={version => onSelectNode(version === 'system' ? null : version)}
          onRemove={onRemoveNode}
          onOpenFolder={onOpenNodeFolder}
          allowSystem
        />
      </div>
    </div>
  )
}

function mergeCandidates(left: RuntimeVersionCandidate[], right: RuntimeVersionCandidate[]): RuntimeVersionCandidate[] {
  const entries = new Map<string, RuntimeVersionCandidate>()
  for (const candidate of [...left, ...right]) entries.set(candidate.version, candidate)
  return [...entries.values()].slice(0, 36)
}

function RuntimeVersionPanel({
  kind,
  title,
  icon,
  selectedVersion,
  installed,
  candidates,
  input,
  busy,
  onInput,
  onInstall,
  onSelect,
  onRemove,
  onOpenFolder,
  allowSystem = false,
}: {
  kind: 'dsh' | 'node'
  title: string
  icon: React.ReactNode
  selectedVersion: string | null
  installed: RuntimeEnvironmentState['dshInstalled'] | RuntimeEnvironmentState['nodeInstalled']
  candidates: RuntimeVersionCandidate[]
  input: string
  busy: boolean
  onInput: (value: string) => void
  onInstall: () => void
  onSelect: (version: string) => void
  onRemove: (version: string) => void
  onOpenFolder: () => void
  allowSystem?: boolean
}) {
  return (
    <section className="environment-panel" aria-label={title}>
      <div className="environment-panel-heading">
        <div className="environment-panel-title">{icon}<span>{title}</span></div>
        <button type="button" className="icon-button" onClick={onOpenFolder} title={`打开${title.replace('版本管理', '')}文件夹`} aria-label={`打开${title.replace('版本管理', '')}文件夹`}><FolderOpen size={16} /></button>
      </div>
      <div className="environment-current">
        <span>当前使用</span>
        <strong>{selectedVersion ?? (allowSystem ? '系统 Node.js' : '未选择')}</strong>
      </div>
      <div className="environment-install-row">
        <input list={`${kind}-version-candidates`} value={input} onChange={event => onInput(event.target.value)} placeholder={`输入或选择 ${kind === 'dsh' ? 'DSH' : 'Node.js'} 精确版本`} disabled={busy} />
        <datalist id={`${kind}-version-candidates`}>
          {candidates.map(candidate => <option key={candidate.version} value={candidate.version}>{candidate.label ?? ''}</option>)}
        </datalist>
        <button type="button" className="primary-command environment-install-button" onClick={onInstall} disabled={busy || !input.trim()}><Download size={15} />安装</button>
      </div>
      <div className="environment-version-list">
        {allowSystem && installed.some(item => item.version === 'system') && (
          <VersionRow version="system" selected={selectedVersion === null} removable={false} busy={busy} onSelect={onSelect} onRemove={onRemove} label="系统 Node.js" />
        )}
        {installed.filter(item => item.version !== 'system').map(item => (
          <VersionRow key={item.version} version={item.version} selected={item.selected} removable={item.removable} busy={busy} onSelect={onSelect} onRemove={onRemove} label={item.source === 'legacy' ? '旧目录' : undefined} />
        ))}
        {installed.length === 0 && <div className="environment-empty">尚未安装可切换的版本</div>}
      </div>
    </section>
  )
}

function VersionRow({ version, selected, removable, busy, label, onSelect, onRemove }: {
  version: string
  selected: boolean
  removable: boolean
  busy: boolean
  label?: string
  onSelect: (version: string) => void
  onRemove: (version: string) => void
}) {
  return (
    <div className={`environment-version-row ${selected ? 'selected' : ''}`}>
      <div className="environment-version-copy"><strong>{version}</strong>{label && <span>{label}</span>}</div>
      {selected ? <span className="environment-current-badge"><Check size={13} />当前</span> : <button type="button" className="environment-select-button" onClick={() => onSelect(version)} disabled={busy}>使用</button>}
      <button type="button" className="icon-button environment-remove-button" onClick={() => onRemove(version)} disabled={busy || !removable} title={removable ? `删除 ${version}` : '当前或系统版本不可删除'} aria-label={removable ? `删除 ${version}` : `${version} 不可删除`}><Trash2 size={14} /></button>
    </div>
  )
}

