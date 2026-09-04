import { Minus, SquareArrowOutUpRight, Wrench, X } from 'lucide-react'
import type { HomeTab } from '../types'

/**
 * 全局顶栏（PCL2 式）：DML 文字标记 + 一级导航 tab + 打开网页（运行中）+ 开发人员选项 + 窗口键。
 * 整条可拖拽；按钮区 no-drag。管理界面激活时 tab 全部落空、开发人员选项高亮。
 */

const HOME_TABS: Array<{ id: HomeTab; label: string }> = [
  { id: 'start', label: '启动' },
  { id: 'versions', label: 'DSH版本' },
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: '技能' },
  { id: 'presets', label: '预设' },
  { id: 'packs', label: '整合包' },
]

interface TopBarProps {
  activeTab: HomeTab | null
  developerActive: boolean
  /** DSH 运行中且有本地 Web 地址时，右上角出现「打开网页」。 */
  openWebVisible: boolean
  onSelectTab: (tab: HomeTab) => void
  onOpenHarness: () => void
  onOpenDeveloper: () => void
  onMinimize: () => void
  onClose: () => void
}

export function TopBar({ activeTab, developerActive, openWebVisible, onSelectTab, onOpenHarness, onOpenDeveloper, onMinimize, onClose }: TopBarProps) {
  return (
    <header className="topbar">
      <span className="topbar-mark" aria-hidden="true">DML</span>
      <nav className="topbar-tabs" aria-label="一级导航">
        {HOME_TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`topbar-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="topbar-right">
        {openWebVisible && (
          <button type="button" className="topbar-open-web" onClick={onOpenHarness} title="打开 DSH 网页工作台" aria-label="打开网页">
            <SquareArrowOutUpRight size={16} />
          </button>
        )}
        <button type="button" className={`topbar-developer ${developerActive ? 'active' : ''}`} onClick={onOpenDeveloper} title="资源市场 / GitHub / 运行环境">
          <Wrench size={14} /><span>开发人员选项</span>
        </button>
        <button type="button" className="topbar-window-button" title="最小化" aria-label="最小化" onClick={onMinimize}><Minus size={17} /></button>
        <button type="button" className="topbar-window-close" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      </div>
    </header>
  )
}
