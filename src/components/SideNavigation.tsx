import { Cpu, GitFork, Layers3, Package, PanelLeftClose, PanelLeftOpen, Settings, ShoppingBag, Sparkles } from 'lucide-react'
import type { PackStatus, ProfileState, ProfileSummary, RuntimeState, ViewName } from '../types'

/** 管理界面左侧导航与当前 Profile 摘要。 */

interface NavigationEntry {
  id: ViewName
  label: string
  icon: typeof Settings
  count?: number
}

interface SideNavigationProps {
  view: ViewName
  profile: ProfileState
  runtime: RuntimeState
  profileName: string
  packs: PackStatus[]
  profiles?: ProfileSummary[]
  activePackId: string | null | undefined
  collapsed: boolean
  profileMutationLocked: boolean
  onPackChange: (packId: string) => void
  onProfileChange?: (profileName: string) => void
  onToggleCollapsed: () => void
  onSettings: () => void
  onChange: (view: ViewName) => void
}

export function SideNavigation({ view, profile, runtime, profileName, packs, profiles = [], activePackId, collapsed, profileMutationLocked, onPackChange, onProfileChange, onToggleCollapsed, onSettings, onChange }: SideNavigationProps) {
  const entries: NavigationEntry[] = [
    { id: 'plugins', label: '启动项管理', icon: Layers3, count: profile.plugins.length },
    { id: 'discover', label: '资源市场', icon: Sparkles },
    { id: 'dsh-market', label: 'DSH Market', icon: ShoppingBag },
    { id: 'packs', label: 'Profile / 整合包', icon: Package },
    { id: 'github', label: 'GitHub', icon: GitFork },
    { id: 'environment', label: '运行环境', icon: Cpu },
  ]

  return (
    <aside className={`side-navigation ${collapsed ? 'collapsed' : ''}`}>
      <nav aria-label="主导航">
        {entries.map(entry => {
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type="button"
              className={view === entry.id ? 'active' : ''}
              aria-label={entry.label}
              title={entry.label}
              onClick={() => onChange(entry.id)}
            >
              <Icon size={18} />
              <span>{entry.label}</span>
              {entry.count !== undefined && <span className="nav-count">{entry.count}</span>}
            </button>
          )
        })}
      </nav>
      <div className="side-navigation-footer">
        <button
          type="button"
          className="sidebar-collapse-button"
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span>{collapsed ? '展开侧边栏' : '收起侧边栏'}</span>
        </button>
        <div className="profile-summary">
          <button className="profile-icon settings-profile-button" type="button" title="启动器设置" aria-label="启动器设置" onClick={onSettings}>
            <Settings size={17} />
          </button>
          <div className="profile-copy">
            <strong>{profileName}</strong>
            <span>{profile.initialized ? `${profile.activeBundles.length} 层已激活` : '等待初始化'}</span>
          </div>
          <span className={`mini-status ${runtime.running ? 'running' : ''}`} title={runtime.running ? 'DSH 正在运行' : 'DSH 未运行'} />
        </div>
      </div>
    </aside>
  )
}
