import { Check, ExternalLink, LoaderCircle, RefreshCw, Search, Star, Store, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { PageHeading } from '../components/PageHeading'
import { SkeletonCards } from '../components/Skeleton'
import { formatStars } from '../lib/format'
import type { DshMarketCatalog, DshMarketPlugin, DshMarketProgress } from '../types'

type Sort = 'stars' | 'updated' | 'name'

/**
 * 目录结果的模块级缓存：切走 tab 组件被卸载后，重进时先用旧目录直接渲染、
 * 后台静默刷新（主进程另有磁盘缓存 + 30 分钟 SWR），不再每次闪一遍骨架屏。
 */
let cachedCatalog: DshMarketCatalog | null = null

interface DshMarketViewProps {
  /** Market mutations write the active Profile; let the shared store refresh it. */
  onProfileChanged?: () => Promise<void> | void
  /** 嵌入 C 端设置页时：去掉整页容器与 PageHeading，改用紧凑面板头。 */
  embedded?: boolean
}

export function DshMarketView({ onProfileChanged, embedded = false }: DshMarketViewProps) {
  const api = useLauncherApi()
  const [catalog, setCatalog] = useState<DshMarketCatalog | null>(cachedCatalog)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<Sort>('stars')
  const [loading, setLoading] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<DshMarketProgress | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await api.loadDshMarket()
      cachedCatalog = next
      setCatalog(next)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取 DSH Market') }
    finally { setLoading(false) }
  }

  const checkUpdates = async () => {
    setCheckingUpdates(true)
    setError(null)
    try { await api.checkDshMarketUpdates(true); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '更新检查失败') }
    finally { setCheckingUpdates(false) }
  }

  useEffect(() => {
    void load()
    return api.onDshMarketProgress(setProgress)
  }, [])

  const visible = useMemo(() => {
    const list = (catalog?.plugins ?? []).filter(plugin => {
      if (category === '__installed') {
        if (!plugin.installed) return false
      } else if (category !== 'all' && plugin.category !== category) return false
      const text = `${plugin.name} ${plugin.owner} ${plugin.description.zh ?? ''} ${plugin.description.en ?? ''}`.toLowerCase()
      return text.includes(query.trim().toLowerCase())
    })
    return [...list].sort((left, right) => sort === 'stars'
      ? right.stars - left.stars || left.name.localeCompare(right.name)
      : sort === 'updated'
        ? String(right.added).localeCompare(String(left.added))
        : left.name.localeCompare(right.name))
  }, [catalog, query, category, sort])

  const mutate = async (plugin: DshMarketPlugin, action: 'install' | 'update' | 'uninstall' | 'toggle', enabled?: boolean) => {
    setBusy(plugin.name)
    setError(null)
    try {
      if (action === 'install') await api.installDshMarketPlugin(plugin.name)
      else if (action === 'update') await api.updateDshMarketPlugin(plugin.name)
      else if (action === 'uninstall') await api.uninstallPlugin(plugin.npm ?? plugin.name, { purgeStore: true })
      else await api.toggleDshMarketPlugin(plugin.name, enabled === true)
      // The market service and startup-item manager share the same Profile on
      // disk, but their renderer state is otherwise independent. Refresh the
      // shared Profile before redrawing the market so both switches agree.
      await onProfileChanged?.()
      await load()
    } catch (cause) {
      // Profile removal happens before the optional pnpm cache prune. Refresh
      // the shared list even when cache maintenance reports an error.
      if (action === 'uninstall') await onProfileChanged?.()
      setError(cause instanceof Error ? cause.message : '操作失败')
    }
    finally { setBusy(null) }
  }

  const categories = Object.entries(catalog?.categories ?? {})
  const refreshActions = <><button type="button" className="secondary-button" onClick={() => void checkUpdates()} disabled={loading || checkingUpdates}><RefreshCw size={14} className={checkingUpdates ? 'spin' : undefined} />检查更新</button><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || checkingUpdates}><RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新目录</button></>
  return (
    <div className={embedded ? 'dsh-market-page dsh-market-embedded' : 'page dsh-market-page'}>
      {embedded
        ? <div className="settings-panel-heading"><div className="settings-panel-title"><Store size={17} /><span>DSH Market · 精选插件</span></div><div className="dsh-market-embedded-actions">{refreshActions}</div></div>
        : <PageHeading
            eyebrow="独立插件市场"
            title="DSH Market"
            description="复用 dsh-market 的精选目录、安装、更新和启停逻辑。与资源市场完全独立。"
            actions={refreshActions}
          />}
      <div className="dsh-market-note">
        <span><Store size={14} /> 数据源：awesome-dsh-plugin.com/plugins.json</span>
        <span>{catalog ? `${catalog.count} 个精选插件 · 更新于 ${catalog.updated || '未知'}` : '正在读取目录'}</span>
      </div>
      <div className="dsh-market-toolbar">
        <label className="dsh-market-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、作者或描述" /></label>
        <select value={category} onChange={event => setCategory(event.target.value)} aria-label="插件分类"><option value="all">全部分类</option><option value="__installed">已安装</option>{categories.map(([id, label]) => <option key={id} value={id}>{label.zh ?? label.en ?? id}</option>)}</select>
        <select value={sort} onChange={event => setSort(event.target.value as Sort)} aria-label="排序"><option value="stars">星数最多</option><option value="updated">最近加入</option><option value="name">名称排序</option></select>
      </div>
      {progress && progress.phase !== 'complete' && progress.phase !== 'error' && (
        <div className="dsh-market-progress">
          <LoaderCircle size={14} className="spin" />
          <span>{progress.message}</span>
          <div className={`dsh-market-progress-track ${progress.percent !== null ? 'determinate' : 'indeterminate'}`}>
            {progress.percent !== null && <span style={{ width: `${progress.percent}%` }} />}
          </div>
          {progress.percent !== null && <strong>{progress.percent}%</strong>}
        </div>
      )}
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
      {loading && catalog === null && <div className="empty-state"><LoaderCircle size={22} className="spin" /><span>正在读取 DSH Market 目录…</span></div>}
      {!loading && catalog !== null && visible.length === 0 && <div className="empty-state"><Search size={22} /><span>{category === '__installed' ? '当前 Profile 还没有已安装的精选插件。' : '没有匹配的精选插件。'}</span></div>}
      <div className="dsh-market-grid">
        {visible.map(plugin => {
          const isBusy = busy === plugin.name
          return (
            <article key={`${plugin.owner}/${plugin.name}`} className="dsh-market-card">
              <div className="dsh-market-card-head"><div><h2>{plugin.name}</h2><span>{plugin.owner}</span></div><span className="dsh-market-stars"><Star size={13} />{formatStars(plugin.stars)}</span></div>
              <div className="dsh-market-meta"><span>{plugin.category}</span>{plugin.npm ? <code>npm</code> : <code>GitHub</code>}{plugin.version && <code>v{plugin.version}</code>}{plugin.installed && <b className={plugin.enabled ? 'market-enabled' : 'market-disabled'}>{plugin.enabled ? '已启用' : '未启用'}</b>}</div>
              <p>{plugin.description.zh ?? plugin.description.en ?? '暂无描述'}</p>
              <div className="dsh-market-card-foot"><button type="button" className="dsh-market-link" onClick={() => void api.openExternal(plugin.url)}><ExternalLink size={13} />仓库</button><span className="dsh-market-grow" />{plugin.installed && <button type="button" className="icon-button" title={plugin.enabled ? '停用插件' : '启用插件'} disabled={isBusy} onClick={() => void mutate(plugin, 'toggle', !plugin.enabled)}>{plugin.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}</button>}{plugin.installed && plugin.updateAvailable && <button type="button" className="secondary-button dsh-market-action" disabled={isBusy} onClick={() => void mutate(plugin, 'update')}>{isBusy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}更新</button>}{plugin.installed ? <button type="button" className="danger-button dsh-market-action" title="彻底清除插件及未引用的 pnpm 缓存" disabled={isBusy} onClick={() => void mutate(plugin, 'uninstall')}><Trash2 size={13} />卸载</button> : <button type="button" className="primary-command dsh-market-action" disabled={isBusy} onClick={() => void mutate(plugin, 'install')}>{isBusy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}安装</button>}</div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
