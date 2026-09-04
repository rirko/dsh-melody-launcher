import { Download, Sparkles, X } from 'lucide-react'

/** 官方推荐整合包（DSH Web UI）的首次询问弹窗。 */

export interface RecommendedWebUiDialogProps {
  kind: 'new' | 'existing'
  onDownload: () => void
  onDismiss: () => void
}

export function RecommendedWebUiDialog({ kind, onDownload, onDismiss }: RecommendedWebUiDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onDismiss() }}>
      <section className="modal recommended-dialog" role="alertdialog" aria-modal="true" aria-labelledby="recommended-webui-title">
        <button type="button" className="icon-button recommended-dialog-close" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDismiss() }} aria-label="关闭"><X size={16} /></button>
        <div className="recommended-dialog-hero">
          <span className="recommended-dialog-badge"><Sparkles size={19} /></span>
          <h2 id="recommended-webui-title">官方推荐整合包</h2>
          <p>DSH Web UI · 全家桶</p>
        </div>
        <div className="modal-content recommended-dialog-body">
          <p>
            {kind === 'new'
              ? '是否同时下载官方推荐的「DSH Web UI」全家桶整合包，以获得更佳使用体验？'
              : '建议下载并启用官方推荐的「DSH Web UI」全家桶整合包。'}
            <span className="recommended-dialog-sub">{kind === 'new' ? '后续可在启动项管理中关闭。' : '之后可在启动项管理中重新开启。'}</span>
          </p>
          <ul className="recommended-dialog-points">
            <li>一键体验官方全套 Web UI：任务看板、Git 图谱、宠物、皮肤中心等</li>
            <li>始终安装 npm 最新版本，国内镜像源加速</li>
          </ul>
          {kind === 'existing' && (
            <div className="recommended-dialog-warning">
              <strong>注意</strong>
              <span>首次启用将默认暂时停用您已安装的其它插件，以免兼容性冲突；之后可在启动项管理中重新开启。</span>
            </div>
          )}
        </div>
        <footer className="recommended-dialog-footer">
          <button type="button" className="secondary-button" onClick={onDismiss}>暂不</button>
          <button type="button" className="primary-command" onClick={onDownload}><Download size={16} />{kind === 'new' ? '下载' : '下载并启用'}</button>
        </footer>
      </section>
    </div>
  )
}