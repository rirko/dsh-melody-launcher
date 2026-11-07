import {
  Activity,
  Check,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  ServerCog,
  Trash2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import type {
  ApiProbeResult,
  ApiProbeTarget,
  CredentialStatus,
  CustomApiProtocol,
  CustomApiModel,
  CustomApiProvider,
  CustomApiProviderInput,
} from '../../types'

interface CredentialDialogProps {
  status: CredentialStatus
  providers: CustomApiProvider[]
  loading: boolean
  busy: boolean
  onClose: () => void
  onSaveDeepSeek: (apiKey: string) => Promise<boolean>
  onClearDeepSeek: () => Promise<boolean>
  onSaveCustom: (input: CustomApiProviderInput) => Promise<boolean>
  onSyncCustom: () => Promise<boolean>
  onRemoveCustom: (route: string) => Promise<boolean>
  onProbe: (target: ApiProbeTarget) => Promise<ApiProbeResult>
}

interface ProviderDraft {
  originalRoute?: string
  route: string
  displayName: string
  baseUrl: string
  protocol: CustomApiProtocol
  modelText: string
  models?: CustomApiModel[]
  apiKey: string
  hadApiKey: boolean
}

const PROTOCOL_LABELS: Record<CustomApiProtocol, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
}

function emptyDraft(): ProviderDraft {
  return {
    route: '',
    displayName: '',
    baseUrl: '',
    protocol: 'openai-completions',
    modelText: '',
    apiKey: '',
    hadApiKey: false,
  }
}

function draftFromProvider(provider: CustomApiProvider): ProviderDraft {
  const models = provider.models?.length
    ? provider.models.map(model => ({ ...model, input: [...model.input], reasoningEfforts: { ...model.reasoningEfforts } }))
    : provider.modelIds.map(id => ({ id, input: ['text' as const], reasoningEfforts: {} }))
  return {
    originalRoute: provider.route,
    route: provider.route,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    modelText: provider.modelIds.join('\n'),
    models,
    apiKey: '',
    hadApiKey: provider.hasApiKey,
  }
}

export function CredentialDialog({
  status,
  providers,
  loading,
  busy,
  onClose,
  onSaveDeepSeek,
  onClearDeepSeek,
  onSaveCustom,
  onSyncCustom,
  onRemoveCustom,
  onProbe,
}: CredentialDialogProps) {
  const [tab, setTab] = useState<'deepseek' | 'custom'>('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [customKeyVisible, setCustomKeyVisible] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [probing, setProbing] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ApiProbeResult>>({})

  /** key 为 'deepseek' 或 provider 路由；结果同时经 store toast 呈现。 */
  const probe = async (target: ApiProbeTarget, key: string) => {
    if (busy || probing !== null) return
    setProbing(key)
    try {
      const result = await onProbe(target)
      setProbeResults(current => ({ ...current, [key]: result }))
    } finally {
      setProbing(null)
    }
  }

  const saveDeepSeek = async () => {
    if (!apiKey.trim() || busy) return
    if (await onSaveDeepSeek(apiKey)) {
      setApiKey('')
      setConfirmingClear(false)
    }
  }

  const saveCustom = async () => {
    if (!draft || busy) return
    const input: CustomApiProviderInput = {
      originalRoute: draft.originalRoute,
      route: draft.route,
      displayName: draft.displayName,
      baseUrl: draft.baseUrl,
      protocol: draft.protocol,
      modelIds: (draft.models ?? []).map(model => model.id.trim()).filter(Boolean),
      models: draft.models,
      apiKey: draft.apiKey,
    }
    if (await onSaveCustom(input)) {
      setDraft(null)
      setCustomKeyVisible(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !busy) onClose() }}>
      <div className="modal credential-dialog" aria-modal="true" aria-labelledby="credential-title" role="dialog">
        <header>
          <div><KeyRound size={19} /><h2 id="credential-title">API 配置</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭 API 配置"><X size={18} /></button>
        </header>

        <div className="api-config-tabs" role="tablist" aria-label="API 配置类型">
          <button type="button" role="tab" aria-selected={tab === 'deepseek'} className={tab === 'deepseek' ? 'active' : ''} onClick={() => setTab('deepseek')}>
            <KeyRound size={15} />DeepSeek
          </button>
          <button type="button" role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>
            <ServerCog size={15} />自定义 API <span>{providers.length}</span>
          </button>
        </div>

        <div className="modal-content api-config-content">
          {tab === 'deepseek' ? (
            <form id="deepseek-api-form" onSubmit={event => { event.preventDefault(); void saveDeepSeek() }}>
              <div className={`credential-summary ${status.configured ? 'configured' : ''}`}>
                {status.configured ? <CircleCheck size={19} /> : <CircleAlert size={19} />}
                <div>
                  <strong>{status.configured ? 'DeepSeek Key 已配置' : '尚未配置 DeepSeek Key'}</strong>
                  <span>{status.configured ? '输入新 Key 可直接替换现有值。' : '保存后即可在 DeepSeek Harness 中调用模型。'}</span>
                </div>
              </div>
              <label className="credential-field">
                <span>API Key</span>
                <div className="secret-input">
                  <input
                    autoFocus
                    autoComplete="off"
                    type={visible ? 'text' : 'password'}
                    value={apiKey}
                    placeholder={status.configured ? '输入新的 Key 以替换' : '输入 DeepSeek API Key'}
                    spellCheck={false}
                    onChange={event => setApiKey(event.target.value)}
                  />
                  <button type="button" title={visible ? '隐藏 Key' : '显示 Key'} aria-label={visible ? '隐藏 Key' : '显示 Key'} onClick={() => setVisible(current => !current)}>
                    {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </label>
              <p className="credential-privacy">Key 仅写入当前 DSH_HOME 的本机凭据文件。启动器不会回显、记录或上传它。</p>
              {probeResults['deepseek'] && (
                <p className={`api-probe-result ${probeResults['deepseek'].ok ? 'ok' : 'fail'}`}>{probeResults['deepseek'].message}</p>
              )}
            </form>
          ) : (
            <div className="custom-api-panel">
              <div className="custom-api-heading">
                <div><strong>自定义模型服务</strong><span>通过 DSH 内置的 LLM Provider 加载。</span></div>
                <div className="custom-api-heading-actions">
                  <button type="button" className="secondary-button compact" disabled={busy || loading} onClick={() => void onSyncCustom()}><LoaderCircle size={15} className={busy ? 'spin' : ''} />同步到全局设置</button>
                  <button type="button" className="secondary-button compact" disabled={busy || loading} onClick={() => { setDraft(emptyDraft()); setConfirmingRemove(null) }}><Plus size={15} />新增</button>
                </div>
              </div>

              {loading ? (
                <div className="custom-api-empty"><LoaderCircle className="spin" size={20} /><span>正在读取本地 API 配置</span></div>
              ) : providers.length === 0 && !draft ? (
                <div className="custom-api-empty"><ServerCog size={23} /><strong>还没有自定义 API</strong><span>可接入兼容 OpenAI 或 Anthropic 协议的本地、代理或第三方服务。</span></div>
              ) : (
                <div className="custom-api-list">
                  {providers.map(provider => (
                    <div className="custom-api-item" key={provider.route}>
                      <div className="custom-api-icon"><ServerCog size={17} /></div>
                      <div className="custom-api-copy">
                        <strong>{provider.displayName}</strong>
                        <span>{provider.route} · {PROTOCOL_LABELS[provider.protocol]}</span>
                        <small title={provider.baseUrl}>{provider.baseUrl}</small>
                        {provider.models && provider.models.length > 0 && <div className="custom-api-model-list">{provider.models.map(model => <small key={model.id}>{model.id} · {model.contextWindow ? `上下文 ${model.contextWindow}` : '上下文未设置'}{model.maxOutputTokens ? ` · 输出 ${model.maxOutputTokens}` : ''} · {model.input.join('、')}</small>)}</div>}
                        {provider.defaultModel?.startsWith(`${provider.route}/`) && <small>默认模型：{provider.defaultModel.slice(provider.route.length + 1)}</small>}
                        {probeResults[provider.route] && (
                          <small className={`api-probe-result ${probeResults[provider.route].ok ? 'ok' : 'fail'}`}>{probeResults[provider.route].message}</small>
                        )}
                      </div>
                      <div className="custom-api-meta">
                        <span>{provider.modelIds.length} 个模型</span>
                        <small className={provider.hasApiKey ? 'configured' : ''}>{provider.hasApiKey ? '密钥已配置' : '无本地密钥'}</small>
                      </div>
                      <button type="button" className="icon-button" title="测试连接" aria-label={`测试 ${provider.displayName}`} disabled={busy || probing !== null} onClick={() => void probe({ target: 'custom', route: provider.route }, provider.route)}>
                        {probing === provider.route ? <LoaderCircle size={15} className="spin" /> : <Activity size={15} />}
                      </button>
                      <button type="button" className="icon-button" title="编辑" aria-label={`编辑 ${provider.displayName}`} disabled={busy} onClick={() => { setDraft(draftFromProvider(provider)); setConfirmingRemove(null) }}><Pencil size={15} /></button>
                      <button
                        type="button"
                        className={`icon-button custom-api-remove ${confirmingRemove === provider.route ? 'confirming' : ''}`}
                        title={confirmingRemove === provider.route ? '再次点击确认删除' : '删除'}
                        aria-label={confirmingRemove === provider.route ? `确认删除 ${provider.displayName}` : `删除 ${provider.displayName}`}
                        disabled={busy}
                        onClick={async () => {
                          if (confirmingRemove !== provider.route) {
                            setConfirmingRemove(provider.route)
                            return
                          }
                          if (await onRemoveCustom(provider.route)) {
                            if (draft?.originalRoute === provider.route) setDraft(null)
                            setConfirmingRemove(null)
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {draft && (
                <form id="custom-api-form" className="custom-api-form" onSubmit={event => { event.preventDefault(); void saveCustom() }}>
                  <div className="custom-api-form-title"><strong>{draft.originalRoute ? '编辑自定义 API' : '新增自定义 API'}</strong><span>路由会用于 DSH 的模型选择和凭据名称。</span></div>
                  <div className="custom-api-form-grid">
                    <label><span>显示名称</span><input autoFocus value={draft.displayName} onChange={event => setDraft(current => current ? { ...current, displayName: event.target.value } : current)} placeholder="例如：本地 Ollama" /></label>
                    <label><span>路由</span><input value={draft.route} onChange={event => setDraft(current => current ? { ...current, route: event.target.value.toLowerCase() } : current)} placeholder="例如：local-ollama" spellCheck={false} /></label>
                    <label className="wide"><span>Base URL</span><input value={draft.baseUrl} onChange={event => setDraft(current => current ? { ...current, baseUrl: event.target.value } : current)} placeholder="https://example.com/v1" spellCheck={false} /></label>
                    <label><span>协议</span><select value={draft.protocol} onChange={event => setDraft(current => current ? { ...current, protocol: event.target.value as CustomApiProtocol } : current)}>{Object.entries(PROTOCOL_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
                    <div className="custom-model-editor wide">
                      <div className="custom-model-editor-heading"><span>模型目录</span><button type="button" className="settings-nav-link" onClick={() => setDraft(current => current ? { ...current, models: [...(current.models ?? []), { id: '', input: ['text'], reasoningEfforts: {} }] } : current)}><Plus size={14} />添加模型</button></div>
                      {(draft.models ?? []).map((model, index) => <div className="custom-model-row" key={`${index}-${model.id}`}>
                        <input value={model.id} placeholder="模型 ID" onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) } : current)} />
                        <input value={model.name ?? ''} placeholder="显示名称" onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value || undefined } : item) } : current)} />
                        <input type="number" min="1" value={model.contextWindow ?? ''} placeholder="上下文窗口" onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, contextWindow: event.target.value ? Number(event.target.value) : undefined } : item) } : current)} />
                        <input type="number" min="1" value={model.maxOutputTokens ?? ''} placeholder="最大输出 Token" onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, maxOutputTokens: event.target.value ? Number(event.target.value) : undefined } : item) } : current)} />
                        <input value={Object.keys(model.reasoningEfforts).join(',')} placeholder="推理档位" onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, reasoningEfforts: Object.fromEntries(event.target.value.split(',').map(value => value.trim()).filter(Boolean).map(value => [value, item.reasoningEfforts[value] ?? value])) } : item) } : current)} />
                        <span className="custom-model-inputs"><label><input type="checkbox" checked={model.input.includes('text')} onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, input: event.target.checked ? [...new Set([...item.input, 'text' as const])] : item.input.filter(input => input !== 'text') } : item) } : current)} />文本</label><label><input type="checkbox" checked={model.input.includes('image')} onChange={event => setDraft(current => current ? { ...current, models: (current.models ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, input: event.target.checked ? [...new Set([...item.input, 'image' as const])] : item.input.filter(input => input !== 'image') } : item) } : current)} />图片</label></span>
                      </div>)}
                      <small className="custom-model-hint">推理档位：已从 DSH Profile 同步并保留；新增档位可在 DSH 中配置后再次点击同步。</small>
                    </div>
                    <label className="wide"><span>API Key（可选）</span><div className="secret-input"><input autoComplete="off" type={customKeyVisible ? 'text' : 'password'} value={draft.apiKey} onChange={event => setDraft(current => current ? { ...current, apiKey: event.target.value } : current)} placeholder={draft.hadApiKey ? '留空保留现有密钥' : '本地免鉴权服务可留空'} spellCheck={false} /><button type="button" title={customKeyVisible ? '隐藏 Key' : '显示 Key'} aria-label={customKeyVisible ? '隐藏 Key' : '显示 Key'} onClick={() => setCustomKeyVisible(current => !current)}>{customKeyVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
                  </div>
                  <p className="credential-privacy">配置写入当前 Profile 的 cordis.patch.yml；点击“同步到全局设置”后才会镜像到 settings.yaml。密钥单独写入 .credentials.yaml，界面不会读取或显示密钥原文。</p>
                </form>
              )}
            </div>
          )}
        </div>

        <footer>
          {tab === 'deepseek' ? (
            <>
              {status.configured && (
                <button type="button" className="danger-button clear-key" disabled={busy} onClick={async () => {
                  if (!confirmingClear) { setConfirmingClear(true); return }
                  if (await onClearDeepSeek()) setConfirmingClear(false)
                }}><Trash2 size={16} />{confirmingClear ? '再次点击确认清除' : '清除 Key'}</button>
              )}
              <button type="button" className="secondary-button" disabled={busy || probing !== null} onClick={() => void probe({ target: 'deepseek-official' }, 'deepseek')}>
                {probing === 'deepseek' ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}测试连接
              </button>
              <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>关闭</button>
              <button type="submit" form="deepseek-api-form" className="primary-command" disabled={busy || !apiKey.trim()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{status.configured ? '替换 Key' : '保存 Key'}</button>
            </>
          ) : draft ? (
            <>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>取消编辑</button>
              <button type="submit" form="custom-api-form" className="primary-command" disabled={busy || !draft.route.trim() || !draft.displayName.trim() || !draft.baseUrl.trim() || !(draft.models ?? []).some(model => model.id.trim())}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{draft.originalRoute ? '保存修改' : '添加 API'}</button>
            </>
          ) : (
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>关闭</button>
          )}
        </footer>
      </div>
    </div>
  )
}
