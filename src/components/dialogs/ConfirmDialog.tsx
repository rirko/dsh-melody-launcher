import { Trash2 } from 'lucide-react'
import type { ManagedPlugin } from '../../types'

/** 完全卸载插件前的确认。 */
export function ConfirmDialog({ plugin, onCancel, onConfirm }: {
  plugin: ManagedPlugin
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="confirm-icon"><Trash2 size={22} /></div>
        <h2 id="confirm-title">要彻底清除 {plugin.displayName} 吗？</h2>
        <p>这会从本机所有 DSH Profile、共享插件本体和安装记录中移除它，并清理不再被引用的 GitHub 源码快照、Release 安装包及启动器受控 pnpm store 缓存（也会一并清理其他已卸载插件的残留缓存）。远程仓库、仍被其他插件共用的缓存和 DSH 本体不会被删除。</p>
        <footer><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="button" className="danger-button" onClick={onConfirm}><Trash2 size={16} />彻底清除</button></footer>
      </section>
    </div>
  )
}
