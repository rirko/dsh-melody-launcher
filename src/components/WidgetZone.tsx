import { ChevronLeft, ChevronRight, Cpu, Newspaper, RefreshCw, Wallet } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLauncherApi } from '../api/client'
import type { DeepSeekBalanceResult, DshUpdateStatus, LauncherUpdateStatus, NewsFeedResult } from '../types'

/**
 * 首页小部件区：一块区域、多张卡片轮播（左右箭头 + 圆点切换）。
 * 一期四张卡：版本更新 / 本地环境 / DeepSeek 余额 / AI 日报（RSS 纯文字）。
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
}

function WidgetCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="widget-card">
      <header className="widget-card-head">
        {icon}
        <span>{title}</span>
      </header>
      <div className="widget-card-body">{children}</div>
    </div>
  )
}

function UpdateCard({ dshUpdate, launcherUpdate, busy, onUpdateDsh, onOpenLauncherUpdate }: Pick<WidgetZoneProps, 'dshUpdate' | 'launcherUpdate' | 'busy' | 'onUpdateDsh' | 'onOpenLauncherUpdate'>) {
  const dshLine = (() => {
    if (!dshUpdate) return <span className="widget-muted">版本检查将在启动后自动进行</span>
    if (dshUpdate.state === 'update-available') {
      return (
        <>
          <span><strong>DSH {dshUpdate.remoteVersion}</strong><small>本地 {dshUpdate.localVersion ?? '未知'}</small></span>
          <button type="button" className="primary-command" disabled={busy} onClick={onUpdateDsh}>更新</button>
        </>
      )
    }
    if (dshUpdate.state === 'up-to-date') return <span className="widget-good">DSH {dshUpdate.localVersion} 已是最新 ✓</span>
    if (dshUpdate.state === 'not-installed') return <span className="widget-muted">本地尚未安装 DSH，点下方「启动」按钮完成部署</span>
    return <span className="widget-muted">{dshUpdate.message || '暂时无法检查 DSH 更新'}</span>
  })()
  const launcherLine = (() => {
    if (!launcherUpdate) return <span className="widget-muted">启动器版本未知</span>
    if (launcherUpdate.state === 'update-available' || launcherUpdate.state === 'downloaded') {
      return (
        <>
          <span><strong>启动器 v{launcherUpdate.remoteVersion}</strong><small>{launcherUpdate.state === 'downloaded' ? '下载完成，可立即应用' : '发现新版本'}</small></span>
          <button type="button" className="secondary-button" onClick={onOpenLauncherUpdate}>{launcherUpdate.state === 'downloaded' ? '立即更新' : '查看'}</button>
        </>
      )
    }
    if (launcherUpdate.state === 'downloading' || launcherUpdate.state === 'applying') return <span className="widget-muted">{launcherUpdate.state === 'downloading' ? '正在下载启动器更新…' : '正在应用更新…'}</span>
    if (launcherUpdate.state === 'up-to-date') return <span className="widget-good">启动器已是最新 ✓</span>
    return <span className="widget-muted">{launcherUpdate.message || '启动器暂无更新'}</span>
  })()
  return (
    <WidgetCard icon={<RefreshCw size={15} />} title="版本更新">
      <div className="widget-rows">
        <div className="widget-row">{dshLine}</div>
        <div className="widget-row">{launcherLine}</div>
      </div>
    </WidgetCard>
  )
}

function EnvironmentCard({ dshVersion, bundleCount, pluginCount, skillCount, presetCount }: Pick<WidgetZoneProps, 'dshVersion' | 'bundleCount' | 'pluginCount' | 'skillCount' | 'presetCount'>) {
  const stats: Array<[string, string]> = [
    ['DSH 版本', dshVersion ?? '未安装'],
    ['加载层', `${bundleCount} 层`],
    ['已装插件', `${pluginCount}`],
    ['已装技能', `${skillCount}`],
    ['Agent 预设', `${presetCount}`],
  ]
  return (
    <WidgetCard icon={<Cpu size={15} />} title="本地环境">
      <div className="widget-stats">
        {stats.map(([label, value]) => (
          <div key={label} className="widget-stat"><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
    </WidgetCard>
  )
}

/** 内置价目快照（元 / 百万 tokens，高峰价；空闲时段减半）。价格页改版时手动更新。 */
const DEEPSEEK_PRICING = [
  { model: 'deepseek-v4-flash', hit: '0.10', miss: '3.0', output: '9.0' },
  { model: 'deepseek-v4-pro', hit: '0.30', miss: '9.0', output: '27.0' },
]

function BalanceCard() {
  const api = useLauncherApi()
  const [result, setResult] = useState<DeepSeekBalanceResult | null>(null)
  const load = useCallback((force?: boolean) => {
    void api.deepseekBalance(force).then(setResult).catch((cause: unknown) => setResult({ status: 'error', message: cause instanceof Error ? cause.message : '查询失败' }))
  }, [api])
  useEffect(() => { load() }, [load])

  const body = (() => {
    if (!result) return <span className="widget-muted">正在查询余额…</span>
    if (result.status === 'no-key') return <span className="widget-muted">尚未配置 DeepSeek API 密钥，可在开发人员选项中配置后查看余额。</span>
    if (result.status === 'error') {
      return (
        <>
          <span className="widget-bad">{result.message}</span>
          <button type="button" className="settings-nav-link" onClick={() => load(true)}>重试</button>
        </>
      )
    }
    const info = result.balance.infos[0]
    return (
      <div className="widget-balance">
        <div className="widget-balance-main">
          <span>可用余额</span>
          <strong>{info ? `${info.totalBalance?.toFixed(2) ?? '--'} ${info.currency}` : '--'}</strong>
          {!result.balance.isAvailable && <em className="widget-bad">余额不足，API 已不可调用</em>}
        </div>
        {info && (info.grantedBalance !== null || info.toppedUpBalance !== null) && (
          <div className="widget-balance-split">
            <span>赠金 {info.grantedBalance?.toFixed(2) ?? '--'}</span>
            <span>充值 {info.toppedUpBalance?.toFixed(2) ?? '--'}</span>
            <span className="widget-muted">优先扣赠金</span>
          </div>
        )}
      </div>
    )
  })()

  return (
    <WidgetCard icon={<Wallet size={15} />} title="DeepSeek 余额">
      {body}
      <div className="widget-pricing">
        {DEEPSEEK_PRICING.map(row => (
          <span key={row.model}>{row.model.replace('deepseek-', '')} 命中{row.hit} / 未命中{row.miss} / 输出{row.output}</span>
        ))}
        <span className="widget-muted">元/百万 tokens · 高峰价，空闲时段半价</span>
      </div>
    </WidgetCard>
  )
}

function shortDate(pubDate: string): string {
  const date = new Date(pubDate)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()}`
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
  else body = (
    <ul className="widget-news">
      {result.items.slice(0, 6).map(item => (
        <li key={item.link}>
          <button type="button" onClick={() => void api.openExternal(item.link)} title={item.title}>
            <span className="widget-news-date">{shortDate(item.pubDate) || item.title}</span>
            <span className="widget-news-summary">{item.summary || item.title}</span>
          </button>
        </li>
      ))}
    </ul>
  )
  return (
    <WidgetCard icon={<Newspaper size={15} />} title="AI 日报 · 橘鸦">
      {body}
    </WidgetCard>
  )
}

export function WidgetZone({ dshUpdate, launcherUpdate, busy, dshVersion, bundleCount, pluginCount, skillCount, presetCount, onUpdateDsh, onOpenLauncherUpdate }: WidgetZoneProps) {
  const [index, setIndex] = useState(0)
  const cards: Array<{ key: string; node: ReactNode }> = [
    { key: 'update', node: <UpdateCard dshUpdate={dshUpdate} launcherUpdate={launcherUpdate} busy={busy} onUpdateDsh={onUpdateDsh} onOpenLauncherUpdate={onOpenLauncherUpdate} /> },
    { key: 'env', node: <EnvironmentCard dshVersion={dshVersion} bundleCount={bundleCount} pluginCount={pluginCount} skillCount={skillCount} presetCount={presetCount} /> },
    { key: 'balance', node: <BalanceCard /> },
    { key: 'news', node: <NewsCard /> },
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
