import { FolderGit2, Store } from 'lucide-react'
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { DshMarketView } from './DshMarketView'
import type { ProfileState } from '../types'

type MarketTab = 'market' | 'repositories'

interface ResourceMarketViewProps {
  active: boolean
  profile?: ProfileState
  children: ReactNode
  onProfileChanged?: () => Promise<void> | void
}

export function ResourceMarketView({ active, profile, children, onProfileChanged }: ResourceMarketViewProps) {
  const id = useId()
  const [tab, setTab] = useState<MarketTab>('market')
  // Retain visited panels so tab changes cannot interrupt installs or scans.
  const [repositoriesVisited, setRepositoriesVisited] = useState(false)

  useEffect(() => {
    if (!active) setTab('market')
  }, [active])

  const selectTab = (next: MarketTab) => {
    if (next === 'repositories') setRepositoriesVisited(true)
    setTab(next)
  }

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'market' : event.key === 'End' ? 'repositories'
      : tab === 'market' ? 'repositories' : 'market'
    selectTab(next)
    document.getElementById(`${id}-${next}-tab`)?.focus()
  }

  return (
    <div className="resource-market-view">
      <div className="resource-market-tabs" role="tablist" aria-label="资源市场来源">
        <button type="button" role="tab" id={`${id}-market-tab`} aria-controls={`${id}-market-panel`}
          aria-selected={tab === 'market'} tabIndex={tab === 'market' ? 0 : -1}
          onClick={() => selectTab('market')} onKeyDown={handleTabKey}>
          <Store size={16} /><span>DSH Market</span>
        </button>
        <button type="button" role="tab" id={`${id}-repositories-tab`} aria-controls={`${id}-repositories-panel`}
          aria-selected={tab === 'repositories'} tabIndex={tab === 'repositories' ? 0 : -1}
          onClick={() => selectTab('repositories')} onKeyDown={handleTabKey}>
          <FolderGit2 size={16} /><span>查看所有 dsh-plugin 标签下的仓库</span>
        </button>
      </div>
      <div role="tabpanel" id={`${id}-market-panel`} aria-labelledby={`${id}-market-tab`} hidden={tab !== 'market'}>
        <DshMarketView active={active && tab === 'market'} profile={profile} onProfileChanged={onProfileChanged} />
      </div>
      <div role="tabpanel" id={`${id}-repositories-panel`} aria-labelledby={`${id}-repositories-tab`} hidden={tab !== 'repositories'}>
        {repositoriesVisited && children}
      </div>
    </div>
  )
}
