import {
  CircleAlert,
  CircleCheck,
  Download,
  History,
  LoaderCircle,
  Package,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PackInstallLogEntry, PackInstallPhase, PackItemProgress } from '../../hooks/use-pack-install'
import type { PackAnalysis, PackAnalysisItem, PackInstallResult } from '../../types'

/**
 * 整合包安装/导入对话框（创建与导入复用）。
 * 三种形态：
 *  - preview    导入流程的清单勾选（create 跳过）
 *  - installing 流式日志 + item 级进度
 *  - done/error 结果汇总 + 还原快照 / 启用整合包
 */

export interface PackInstallDialogProps {
  phase: PackInstallPhase
  events: PackInstallLogEntry[]
  result: PackInstallResult | null
  error: string | null
  analysis: PackAnalysis | null
  itemProgress: PackItemProgress
  /** 当前任务的快照事件已到达（更精确）；store 侧的 packHasSnapshot 兜底。 */
  hasSnapshot: boolean
  packSnapshotsAvailable?: boolean
  /** 一次性的还原快照 / 启用整合包动作是否忙碌。 */
  busy: boolean
  /** raw 扫描导入时由用户在预览中编辑包名（仅该来源需要）；name 缺省表示用派生名。 */
  onConfirmImport: (selectedItems: string[], name?: string) => void
  onRollback: () => void
  onActivate: (packId: string) => void
  onClose: () => void
}

const PHASE_LABEL: Record<PackInstallPhase, string> = {
  idle: '空闲',
  preview: '预览',
  installing: '安装中',
  done: '已完成',
  error: '出错',
}

const SOURCE_LABEL: Record<string, string> = {
  created: '自建',
  zip: '离线包',
  manifest: '清单包',
  raw: '扫描导入',
}

export function PackInstallDialog({
  phase,
  events,
  result,
  error,
  analysis,
  itemProgress,
  hasSnapshot,
  packSnapshotsAvailable = false,
  busy,
  onConfirmImport,
  onRollback,
  onActivate,
  onClose,
}: PackInstallDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** raw 扫描导入的可编辑包名（其它来源缺省用派生名）。 */
  const [nameInput, setNameInput] = useState('')
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (phase === 'preview' && analysis) {
      setSelected(new Set(analysis.items.filter(item => item.available).map(item => item.packageName)))
      setNameInput(analysis.name)
    }
  }, [phase, analysis])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' })
  }, [events])

  const active = phase === 'installing'
  const settled = phase === 'done' || phase === 'error'
  const closeable = !active && !busy
  const canRollback = hasSnapshot || packSnapshotsAvailable

  const toggleItem = (packageName: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(packageName)) next.delete(packageName)
      else next.add(packageName)
      return next
    })
  }

  const confirmImport = () => {
    const items = analysis?.items
      .filter(item => item.available && selected.has(item.packageName))
      .map(item => item.packageName) ?? []
    onConfirmImport(items, analysis?.source === 'raw' ? nameInput.trim() : undefined)
  }

  /** raw 来源要求一个能派生出有意义包标识的名字（含字母或数字）。 */
  const rawNameValid = analysis?.source !== 'raw' || /[a-zA-Z0-9]/.test(nameInput)

  const title = phase === 'preview' || phase === 'idle'
    ? '导入整合包'
    : phase === 'done'
      ? '整合包处理完成'
      : phase === 'error'
        ? '整合包处理失败'
        : '正在处理整合包'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && closeable) onClose() }}>
      <section className="modal pack-install-dialog" role="dialog" aria-modal="true" aria-labelledby="pack-install-title">
        <header>
          <div><Package size={19} /><h2 id="pack-install-title">{title}</h2></div>
          <div className="pack-header-actions">
            <span className={`ai-phase-badge ${phase}`}>{PHASE_LABEL[phase]}</span>
            <button type="button" className="icon-button" onClick={onClose} disabled={!closeable} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="modal-content pack-install-content">
          {phase === 'preview' && analysis && (
            <PreviewPanel
              analysis={analysis}
              selected={selected}
              nameInput={nameInput}
              onNameChange={setNameInput}
              onToggle={toggleItem}
            />
          )}
          {(phase === 'installing' || (settled && events.length > 0)) && (
            <>
              <ProgressPanel phase={phase} itemProgress={itemProgress} />
              <div className="ai-install-logs pack-install-logs" role="log" aria-live="polite">
                {events.length === 0 ? (
                  <div className="ai-log-empty"><LoaderCircle className="spin" size={17} />正在处理，请稍候…</div>
                ) : (
                  events.map(entry => (
                    <div key={entry.id} className={`ai-log-entry ${entry.kind}`}>
                      {entry.kind === 'error' && <CircleAlert size={13} />}
                      {entry.kind === 'success' && <CircleCheck size={13} />}
                      <span>{entry.text}</span>
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </>
          )}
          {phase === 'done' && result && <ResultPanel result={result} />}
          {phase === 'error' && error && (
            <div className="pack-error-banner"><CircleAlert size={16} /><span>{error}</span></div>
          )}
        </div>
        <footer>
          {phase === 'preview' && (
            <>
              <span className="pack-footer-note">共 {selected.size} 个组件将安装</span>
              <button type="button" className="secondary-button" onClick={onClose}>取消</button>
              <button
                type="button"
                className="primary-command"
                disabled={selected.size === 0 || !rawNameValid}
                onClick={confirmImport}
                title={rawNameValid ? undefined : '整合包名称需包含字母或数字'}
              >
                <Download size={16} />开始安装
              </button>
            </>
          )}
          {active && (
            <div className="pack-installing-note"><LoaderCircle className="spin" size={15} />正在处理，请勿关闭窗口…</div>
          )}
          {settled && (
            <>
              <button type="button" className="danger-button" disabled={!canRollback || busy} onClick={onRollback}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <History size={16} />}还原快照
              </button>
              {result?.id && (
                <button type="button" className="secondary-button accent" disabled={busy} onClick={() => onActivate(result!.id)}>
                  <CircleCheck size={16} />启用整合包
                </button>
              )}
              <button type="button" className="primary-command" onClick={onClose}><CircleCheck size={16} />关闭</button>
            </>
          )}
        </footer>
      </section>
      <style>{packDialogStyle}</style>
    </div>
  )
}

function PreviewPanel({ analysis, selected, nameInput, onNameChange, onToggle }: {
  analysis: PackAnalysis
  selected: Set<string>
  nameInput: string
  onNameChange: (value: string) => void
  onToggle: (packageName: string) => void
}) {
  const isRaw = analysis.source === 'raw'
  return (
    <div className="pack-preview">
      <div className="pack-preview-head">
        <div>
          <strong>{analysis.name || '（未命名整合包）'}</strong>
          <span>{analysis.description || '（无描述）'}</span>
        </div>
        <span className="pack-source-badge">{SOURCE_LABEL[analysis.source] ?? analysis.source}</span>
      </div>
      {isRaw && (
        <label className="pack-preview-name">
          <span>整合包名称</span>
          <input
            type="text"
            value={nameInput}
            onChange={event => onNameChange(event.target.value)}
            placeholder="给整合包起个名字（需包含字母或数字）"
            autoFocus
          />
          <small>{/[a-zA-Z0-9]/.test(nameInput) ? '名称将作为包标识与 Profile 名的一部分。' : '名称需包含字母或数字，否则无法生成包标识。'}</small>
        </label>
      )}
      <p className="pack-preview-meta">
        版本 {analysis.version} · 要求 DSH {analysis.dshVersion ?? '当前版本'} · {analysis.items.length} 个组件，勾选要安装的项；离线本体从包内安装，其余走在线源。
      </p>
      <div className="pack-item-list">
        {analysis.items.map(item => {
          const checked = selected.has(item.packageName)
          return (
            <PreviewRow key={item.packageName} item={item} checked={checked} onToggle={() => onToggle(item.packageName)} />
          )
        })}
      </div>
    </div>
  )
}

function PreviewRow({ item, checked, onToggle }: {
  item: PackAnalysisItem
  checked: boolean
  onToggle: () => void
}) {
  const selectable = item.available
  return (
    <label className={`pack-item-row ${checked ? 'checked' : ''} ${item.available ? '' : 'unavailable'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={!selectable}
        onChange={onToggle}
        aria-label={`选择安装 ${item.packageName}`}
      />
      <span className="pack-item-main">
        <code>{item.packageName}</code>
        <span className="pack-item-flags">
          {item.available
            ? <span className="pack-item-state ok">可安装</span>
            : <span className="pack-item-state bad">不可用</span>}
          {item.kind === 'skill' && <span className="pack-item-kind">技能</span>}
          {item.enabled === false && <span className="pack-item-inactive">安装后关闭</span>}
          {item.kind === 'preset' && <span className="pack-item-kind">预设</span>}
          {item.offline && <span className="pack-item-offline">离线本体</span>}
        </span>
      </span>
      {!item.available && item.reason && <small className="pack-item-reason">{item.reason}</small>}
    </label>
  )
}

function ProgressPanel({ phase, itemProgress }: {
  phase: PackInstallPhase
  itemProgress: PackItemProgress
}) {
  const ratio = itemProgress.total > 0 ? Math.round(itemProgress.done / itemProgress.total * 100) : 0
  return (
    <div className="pack-progress-panel">
      <div className="pack-progress-line">
        {phase === 'installing' ? <LoaderCircle className="spin" size={14} /> : <CircleCheck size={14} />}
        <span>{itemProgress.current ? `正在安装 ${itemProgress.current}…` : itemProgress.total > 0 ? `已完成 ${itemProgress.done}/${itemProgress.total} 个组件` : '准备中…'}</span>
        <strong>{itemProgress.total > 0 ? `${ratio}%` : '—'}</strong>
      </div>
      <div className="progress-track pack-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={itemProgress.total > 0 ? ratio : undefined}>
        <span style={itemProgress.total > 0 ? { width: `${ratio}%` } : undefined} />
      </div>
    </div>
  )
}

function ResultPanel({ result }: { result: PackInstallResult }) {
  return (
    <div className="pack-result">
      <div className={`pack-result-banner ${result.state}`}>
        {result.state === 'complete' ? <CircleCheck size={17} /> : <CircleAlert size={17} />}
        <span>
          {result.state === 'complete'
            ? `整合包创建/导入成功，共安装 ${result.installed.length} 个组件。`
            : result.state === 'partial'
              ? `部分完成：成功 ${result.installed.length} 个，失败 ${result.failures.length} 个。`
              : '安装失败，未能完成整合包。'}
        </span>
      </div>
      {result.installed.length > 0 && (
        <div className="pack-result-section">
          <h4>已安装</h4>
          <div className="pack-chip-list">
            {result.installed.map(name => <span className="pack-chip ok" key={name}>{name}</span>)}
          </div>
        </div>
      )}
      {result.failures.length > 0 && (
        <div className="pack-result-section">
          <h4>失败项</h4>
          <div className="pack-failure-list">
            {result.failures.map(failure => (
              <div className="pack-failure-row" key={failure.packageName}>
                <code>{failure.packageName}</code>
                <span>{failure.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const packDialogStyle = `
.pack-install-dialog { width: min(680px, calc(100vw - 32px)); }
.pack-install-dialog > header,
.create-pack-dialog > header {
  display: flex; min-height: 56px; align-items: center; justify-content: space-between;
  padding: 0 16px; border-bottom: 1px solid var(--line);
}
.pack-install-dialog > header > div,
.create-pack-dialog > header > div {
  display: flex; align-items: center; gap: 9px;
}
.pack-header-actions { display: flex; align-items: center; gap: 8px; }
.pack-install-content { display: flex; flex-direction: column; gap: 13px; }
.pack-install-logs { flex: 0 0 auto; min-height: 120px; max-height: 260px; }
.pack-progress-panel { display: flex; flex-direction: column; gap: 6px; }
.pack-progress-line {
  display: grid; grid-template-columns: 15px minmax(0, 1fr) auto;
  align-items: center; gap: 6px; color: var(--accent); font-size: 11px;
}
.pack-progress-line strong { font-family: Consolas, monospace; font-size: 10px; }
.pack-progress-track { width: 100%; }

.pack-preview { display: flex; flex-direction: column; gap: 12px; }
.pack-preview-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
}
.pack-preview-head > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.pack-preview-head strong { font-size: 15px; }
.pack-preview-head span { color: var(--muted); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.pack-preview-meta { margin: 0; color: var(--muted); font-size: 11px; line-height: 17px; }
.pack-source-badge {
  flex: 0 0 auto; padding: 2px 9px; border: 1px solid #b9d7c7; border-radius: 999px;
  color: var(--accent); background: var(--accent-soft); font-size: 11px; font-weight: 650;
}
.pack-preview-name {
  display: flex; flex-direction: column; gap: 4px;
  padding: 9px 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-soft);
}
.pack-preview-name > span { font-size: 11px; font-weight: 650; color: var(--muted); }
.pack-preview-name input {
  padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: #fff; color: var(--text); font-size: 12px; outline: none;
}
.pack-preview-name input:focus { border-color: var(--accent); }
.pack-preview-name small { color: var(--quiet); font-size: 10px; }
.pack-item-list {
  display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 7px; overflow: hidden;
}
.pack-item-row {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center; padding: 10px 12px; gap: 9px;
  border-bottom: 1px solid var(--line); background: #fff; cursor: pointer;
}
.pack-item-row:last-child { border-bottom: 0; }
.pack-item-row input { width: 15px; height: 15px; accent-color: var(--accent); }
.pack-item-row.unavailable { background: var(--surface-soft); cursor: default; }
.pack-item-row.unavailable code { color: var(--quiet); text-decoration: line-through; }
.pack-item-main { display: flex; min-width: 0; align-items: center; gap: 9px; }
.pack-item-main code { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.pack-item-flags { display: inline-flex; flex: 0 0 auto; gap: 5px; }
.pack-item-state { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 650; }
.pack-item-state.ok { color: var(--accent); background: var(--accent-soft); }
.pack-item-state.bad { color: var(--danger); background: var(--danger-soft); }
.pack-item-offline { padding: 1px 7px; border-radius: 999px; color: var(--blue); background: var(--blue-soft); font-size: 10px; font-weight: 650; }
.pack-item-kind { padding: 1px 7px; border-radius: 999px; color: var(--amber); background: var(--amber-soft); font-size: 10px; font-weight: 650; }
.pack-item-inactive { padding: 1px 7px; border-radius: 999px; color: var(--muted); background: var(--surface-strong); font-size: 10px; font-weight: 650; }
.pack-item-reason { color: var(--muted); font-size: 10px; text-align: right; overflow-wrap: anywhere; }

.pack-installing-note { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 11px; }
.pack-footer-note { margin-right: auto; color: var(--quiet); font-size: 11px; }

.pack-error-banner {
  display: flex; align-items: flex-start; gap: 8px; padding: 11px 12px;
  border: 1px solid #e4bcbc; border-radius: 7px; color: var(--danger); background: var(--danger-soft); font-size: 11px; line-height: 17px;
}
.pack-result { display: flex; flex-direction: column; gap: 12px; }
.pack-result-banner { display: flex; align-items: center; gap: 8px; padding: 11px 12px; border-radius: 7px; font-size: 12px; }
.pack-result-banner.complete { color: var(--accent); background: var(--accent-soft); }
.pack-result-banner.partial { color: var(--amber); background: var(--amber-soft); }
.pack-result-banner.failed { color: var(--danger); background: var(--danger-soft); }
.pack-result-section h4 { margin: 0 0 7px; font-size: 11px; color: var(--muted); }
.pack-chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.pack-chip { padding: 2px 9px; border-radius: 999px; font-family: Consolas, monospace; font-size: 10px; }
.pack-chip.ok { color: var(--accent); background: var(--accent-soft); }
.pack-failure-list { display: flex; flex-direction: column; gap: 5px; }
.pack-failure-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 7px 10px; border: 1px solid #e4bcbc; border-radius: 6px; background: #fff5f4;
}
.pack-failure-row code { color: var(--danger); font-size: 11px; }
.pack-failure-row span { color: var(--muted); font-size: 10px; text-align: right; overflow-wrap: anywhere; }
`
