import { Box, ChevronLeft, ChevronRight, Cpu, Layers, Newspaper, Puzzle, RefreshCw, Sparkles, Wand2, Wallet } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLauncherApi } from '../api/client'
import { DEEPSEEK_PRICING, periodPrice, pricingPeriod, type PricingPeriod } from '../lib/deepseek-pricing'
import type { DeepSeekBalanceResult, DshUpdateStatus, HomeTab, LauncherUpdateStatus, NewsFeedResult } from '../types'

/**
 * 首页小部件区：一块区域、多张卡片轮播（左右箭头 + 圆点切换）。
 * 一期四张卡：AI 日报（今日要闻，默认首卡）/ 版本更新 / 本地环境 / DeepSeek 余额。
 * 所有卡片保持挂载，切卡只切可见性，网络状态不丢。
 */

interface WidgetZoneProps {
  dshUpdate: DshUpdateStatus | null
  launcherUpdate: LauncherUpdateStatus | null
  busy: boolean
  dshVersion: string | null
  bundleCount: number
  pluginCount: number
  skillCount: number
  presetCount: number
  onUpdateDsh: () => void
  onOpenLauncherUpdate: () => void
  onNavigateTab: (tab: HomeTab) => void
}

function WidgetCard({ icon, title, actions, children }: { icon: ReactNode; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="widget-card">
      <header className="widget-card-head">
        <span className="widget-card-icon">{icon}</span>
        <span>{title}</span>
        {actions && <span className="widget-card-actions">{actions}</span>}
      </header>
      <div className="widget-card-body">{children}</div>
    </div>
  )
}

interface UpdateTileInfo {
  title: string
  sub: string
  good?: boolean
  action?: ReactNode
}

function UpdateCard({ dshUpdate, launcherUpdate, busy, onUpdateDsh, onOpenLauncherUpdate }: Pick<WidgetZoneProps, 'dshUpdate' | 'launcherUpdate' | 'busy' | 'onUpdateDsh' | 'onOpenLauncherUpdate'>) {
  const dsh: UpdateTileInfo = (() => {
    if (!dshUpdate) return { title: '待检查', sub: '启动 DSH 后自动检查版本' }
    if (dshUpdate.state === 'update-available') return {
      title: `DSH ${dshUpdate.remoteVersion}`,
      sub: `本地 ${dshUpdate.localVersion ?? '未知'} · 可更新`,
      action: <button type="button" className="primary-command" disabled={busy} onClick={onUpdateDsh}>更新</button>,
    }
    if (dshUpdate.state === 'up-to-date') return { title: `DSH ${dshUpdate.localVersion}`, sub: '已是最新 ✓', good: true }
    if (dshUpdate.state === 'not-installed') return { title: '未安装', sub: '点下方「启动」按钮完成部署' }
    return { title: '暂无法检查', sub: dshUpdate.message || '网络恢复后自动重试' }
  })()
  const launcher: UpdateTileInfo = (() => {
    if (!launcherUpdate) return { title: '待检查', sub: '启动器版本检查进行中' }
    if (launcherUpdate.state === 'update-available') return {
      title: `v${launcherUpdate.remoteVersion}`, sub: '发现新版本',
      action: <button type="button" className="secondary-button" onClick={onOpenLauncherUpdate}>查看</button>,
    }
    if (launcherUpdate.state === 'downloaded') return {
      title: `v${launcherUpdate.remoteVersion}`, sub: '下载完成，可立即应用',
      action: <button type="button" className="primary-command" onClick={onOpenLauncherUpdate}>立即更新</button>,
    }
    if (launcherUpdate.state === 'downloading' || launcherUpdate.state === 'applying') return { title: '更新中', sub: launcherUpdate.state === 'downloading' ? '正在下载启动器更新…' : '正在应用更新…' }
    if (launcherUpdate.state === 'up-to-date') return { title: '已是最新', sub: '当前版本无需更新', good: true }
    return { title: '暂无法检查', sub: launcherUpdate.message || '网络恢复后自动重试' }
  })()
  const tiles: Array<{ label: string; info: UpdateTileInfo }> = [
    { label: 'DSH 本体', info: dsh },
    { label: '启动器', info: launcher },
  ]
  return (
    <WidgetCard icon={<RefreshCw size={15} />} title="版本更新">
      <div className="widget-update-tiles">
        {tiles.map(tile => (
          <div key={tile.label} className="widget-update-tile">
            <div className="widget-update-tile-info">
              <span>{tile.label}</span>
              <strong>{tile.info.title}</strong>
              <small className={tile.info.good ? 'widget-good' : undefined}>{tile.info.sub}</small>
            </div>
            {tile.info.action}
          </div>
        ))}
      </div>
    </WidgetCard>
  )
}

function EnvironmentCard({ dshVersion, bundleCount, pluginCount, skillCount, presetCount, onNavigateTab }: Pick<WidgetZoneProps, 'dshVersion' | 'bundleCount' | 'pluginCount' | 'skillCount' | 'presetCount' | 'onNavigateTab'>) {
  const tiles: Array<{ key: string; icon: ReactNode; value: string; label: string; tab: HomeTab; wide?: boolean }> = [
    { key: 'dsh', icon: <Box size={15} />, value: dshVersion ?? '未安装', label: 'DSH 版本', tab: 'versions', wide: true },
    { key: 'bundles', icon: <Layers size={15} />, value: `${bundleCount} 层`, label: '加载层', tab: 'packs' },
    { key: 'plugins', icon: <Puzzle size={15} />, value: `${pluginCount}`, label: '已装插件', tab: 'plugins' },
    { key: 'skills', icon: <Wand2 size={15} />, value: `${skillCount}`, label: '已装技能', tab: 'skills' },
    { key: 'presets', icon: <Sparkles size={15} />, value: `${presetCount}`, label: 'Agent 预设', tab: 'presets' },
  ]
  return (
    <WidgetCard icon={<Cpu size={15} />} title="本地环境">
      <div className="widget-tiles">
        {tiles.map(tile => (
          <button key={tile.key} type="button" className={`widget-tile ${tile.wide ? 'wide' : ''}`} onClick={() => onNavigateTab(tile.tab)} title={`前往${tile.label}`}>
            <span className="widget-tile-icon">{tile.icon}</span>
            <span className="widget-tile-body">
              <strong>{tile.value}</strong>
              <small>{tile.label}</small>
            </span>
            <ChevronRight size={14} className="widget-tile-arrow" />
          </button>
        ))}
      </div>
    </WidgetCard>
  )
}

/** 余额卡内联密钥表单：与开发人员选项走同一凭据 IPC，密钥只写本机 .credentials.yaml。 */
function KeyEntryForm({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const api = useLauncherApi()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    const key = value.trim()
    if (!key) { setError('请先粘贴 API Key'); return }
    setSaving(true)
    setError('')
    try {
      await api.setDeepSeekApiKey(key)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="widget-key-form">
      <p className="widget-key-hint">填入 DeepSeek 官方 API Key，实时查询账户余额。</p>
      <div className="widget-key-row">
        <input
          type="password"
          value={value}
          placeholder="sk-…"
          spellCheck={false}
          autoComplete="off"
          disabled={saving}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void save() }}
        />
        <button type="button" className="primary-command" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存并查询'}</button>
      </div>
      {error && <span className="widget-bad">{error}</span>}
      <div className="widget-key-foot">
        <small>密钥仅写入本机 .credentials.yaml，不会上传第三方。</small>
        {onCancel && <button type="button" className="settings-nav-link" onClick={onCancel}>取消</button>}
      </div>
    </div>
  )
}

function BalanceCard() {
  const api = useLauncherApi()
  const [result, setResult] = useState<DeepSeekBalanceResult | null>(null)
  const [editing, setEditing] = useState(false)
  const [period, setPeriod] = useState<PricingPeriod>(() => pricingPeriod(new Date()))
  const load = useCallback((force?: boolean) => {
    void api.deepseekBalance(force).then(setResult).catch((cause: unknown) => setResult({ status: 'error', message: cause instanceof Error ? cause.message : '查询失败' }))
  }, [api])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => setPeriod(pricingPeriod(new Date())), 60_000)
    return () => clearInterval(timer)
  }, [])
  const afterKeySaved = () => { setEditing(false); setResult(null); load(true) }

  const body = (() => {
    if (editing) return <KeyEntryForm onSaved={afterKeySaved} onCancel={result && result.status !== 'no-key' ? () => setEditing(false) : undefined} />
    if (!result) return <span className="widget-muted">正在查询余额…</span>
    if (result.status === 'no-key') return <KeyEntryForm onSaved={afterKeySaved} />
    if (result.status === 'error') {
      return (
        <div className="widget-inline-row">
          <span className="widget-bad">{result.message}</span>
          <div className="widget-inline-actions">
            <button type="button" className="settings-nav-link" onClick={() => load(true)}>重试</button>
            <button type="button" className="settings-nav-link" onClick={() => setEditing(true)}>重新填密钥</button>
          </div>
        </div>
      )
    }
    const info = result.balance.infos[0]
    return (
      <div className="widget-balance">
        <div className="widget-bubble-row">
          <div className="widget-bubble widget-bubble-main">
            <span>可用余额</span>
            <strong>{info ? `${info.totalBalance?.toFixed(2) ?? '--'} ${info.currency}` : '--'}</strong>
            {!result.balance.isAvailable && <em className="widget-bad">余额不足，API 已不可调用</em>}
          </div>
          <div className={`widget-bubble widget-bubble-period ${period}`}>
            <span>计费时段</span>
            <strong>{period === 'peak' ? '峰段 · 原价' : '谷段 · 半价'}</strong>
          </div>
        </div>
        <div className="widget-bubble-row">
          <div className="widget-bubble widget-bubble-sub" title="接入本地会话日志后显示">
            <span>今日使用 Token</span>
            <strong>--</strong>
          </div>
          <div className="widget-bubble widget-bubble-sub" title="接入本地会话日志后显示">
            <span>缓存命中率</span>
            <strong>--</strong>
          </div>
        </div>
      </div>
    )
  })()

  return (
    <WidgetCard
      icon={<Wallet size={15} />}
      title="DeepSeek 余额"
      actions={result?.status === 'ok' && !editing
        ? <button type="button" className="settings-nav-link" onClick={() => setEditing(true)}>更换密钥</button>
        : undefined}
    >
      {body}
      <div className="widget-pricing">
        <span>{DEEPSEEK_PRICING.map(row => `${row.model.replace('deepseek-v4-', '')} ${periodPrice(row.hit, period)} / ${periodPrice(row.miss, period)} / ${periodPrice(row.output, period)}`).join('　·　')}（命中/未命中/输出）</span>
        <span className="widget-muted">元/百万 tokens · 峰段 9–12、14–18（北京时间，工作日）</span>
      </div>
    </WidgetCard>
  )
}

function shortDate(pubDate: string): string {
  const date = new Date(pubDate)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** RSS 摘要是压平的全文（含"AI 早报 … 视频版 … 概览"头部噪声），回退展示时只留「要闻」之后的内容。 */
function digestText(summary: string): string {
  const cut = summary.indexOf('要闻')
  const body = cut >= 0 ? summary.slice(cut + 2) : summary
  return body.replace(/\s*↗\s*\d+/g, ' ↗').trim().slice(0, 160)
}

function NewsCard() {
  const api = useLauncherApi()
  const [result, setResult] = useState<NewsFeedResult | null>(null)
  const load = useCallback(() => {
    void api.newsFeed().then(setResult).catch((cause: unknown) => setResult({ status: 'error', message: cause instanceof Error ? cause.message : '订阅源读取失败' }))
  }, [api])
  useEffect(() => { load() }, [load])

  let body: ReactNode
  if (!result) body = <span className="widget-muted">正在读取 AI 日报…</span>
  else if (result.status === 'error') body = (
    <div className="widget-inline-row">
      <span className="widget-bad">订阅源读取失败 · {result.message}</span>
      <button type="button" className="settings-nav-link" onClick={() => { setResult(null); load() }}>重试</button>
    </div>
  )
  else {
    const today = result.items[0]
    const headlines = today?.headlines ?? []
    if (!today) body = <span className="widget-muted">今日暂无日报条目</span>
    else if (headlines.length === 0) body = (
      <div className="widget-inline-row">
        <p className="widget-news-summary">{digestText(today.summary) || today.title}</p>
        <button type="button" className="settings-nav-link" onClick={() => void api.openExternal(today.link)}>阅读全文 ↗</button>
      </div>
    )
    else body = (
      <div className="widget-news-wrap">
        <div className="widget-news-head">
          <span>今日要闻</span>
          <small>{shortDate(today.pubDate) || today.title}</small>
        </div>
        <ul className="widget-news">
          {headlines.slice(0, 5).map(headline => (
            <li key={headline.link}>
              <button type="button" onClick={() => void api.openExternal(headline.link)} title={headline.text}>
                <span className="widget-news-dot" aria-hidden="true" />
                <span className="widget-news-text">{headline.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <WidgetCard icon={<Newspaper size={15} />} title="AI 日报">
      {body}
    </WidgetCard>
  )
}

export function WidgetZone({ dshUpdate, launcherUpdate, busy, dshVersion, bundleCount, pluginCount, skillCount, presetCount, onUpdateDsh, onOpenLauncherUpdate, onNavigateTab }: WidgetZoneProps) {
  const [index, setIndex] = useState(0)
  const cards: Array<{ key: string; node: ReactNode }> = [
    { key: 'news', node: <NewsCard /> },
    { key: 'update', node: <UpdateCard dshUpdate={dshUpdate} launcherUpdate={launcherUpdate} busy={busy} onUpdateDsh={onUpdateDsh} onOpenLauncherUpdate={onOpenLauncherUpdate} /> },
    { key: 'env', node: <EnvironmentCard dshVersion={dshVersion} bundleCount={bundleCount} pluginCount={pluginCount} skillCount={skillCount} presetCount={presetCount} onNavigateTab={onNavigateTab} /> },
    { key: 'balance', node: <BalanceCard /> },
  ]
  const count = cards.length
  return (
    <div className="widget-zone">
      <div className="widget-track">
        {cards.map((card, i) => (
          <div key={card.key} className={i === index ? 'widget-pane' : 'widget-pane view-hidden'}>{card.node}</div>
        ))}
      </div>
      <div className="widget-nav">
        <button type="button" className="widget-arrow" aria-label="上一张卡片" onClick={() => setIndex(current => (current + count - 1) % count)}><ChevronLeft size={15} /></button>
        <div className="widget-dots" role="tablist" aria-label="小部件卡片">
          {cards.map((card, i) => (
            <button key={card.key} type="button" role="tab" aria-selected={i === index} aria-label={card.key} className={`widget-dot ${i === index ? 'active' : ''}`} onClick={() => setIndex(i)} />
          ))}
        </div>
        <button type="button" className="widget-arrow" aria-label="下一张卡片" onClick={() => setIndex(current => (current + 1) % count)}><ChevronRight size={15} /></button>
      </div>
    </div>
  )
}
