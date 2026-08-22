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
        <h2 id="confirm-title">要完全卸载 {plugin.displayName} 吗？</h2>
        <p>这会从本机所有 DSH Profile 中移除插件及其安装记录，操作不可撤销。远程仓库和 DSH 本体不会被删除。</p>
        <footer><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="button" className="danger-button" onClick={onConfirm}><Trash2 size={16} />完全卸载</button></footer>
      </section>
    </div>
  )
}
