import { BrowserWindow, type Rectangle } from 'electron'

/** 主窗口壳的圆角：必须与 styles.css 里 .surface-stage 的 border-radius 保持一致，
 *  否则阴影环与卡片圆角错位。改动壳圆角时请同步此处。 */
const SHELL_CORNER_RADIUS = 12
/** 阴影页四周留白：需 ≥ box-shadow 垂直偏移(10) + 模糊(28) = 38px，
 *  否则底部阴影会被阴影窗自身裁剪。 */
const SHADOW_MARGIN = 40
const SHADOW_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      .shadow {
        position: absolute;
        inset: ${SHADOW_MARGIN}px;
        border-radius: ${SHELL_CORNER_RADIUS}px;
        box-shadow: 0 10px 28px rgba(22, 32, 26, .25), 0 2px 9px rgba(22, 32, 26, .16);
        transition: opacity .18s ease, transform .3s ease;
      }
      .shadow.lift { transform: scale(.955); opacity: .38; }
      .shadow.drag-hide { opacity: 0; }
    </style>
  </head>
  <body><div class="shadow"></div></body>
</html>`

interface WindowShadowController {
  shadow: BrowserWindow
  sync(): void
  showBehind(): void
  /** 模式翻转时的「抬升-回落」脉冲：影子随卡片抬起而收拢变淡。 */
  pulse(): void
  /** 拖动暂隐后的恢复：清除爆发计数并淡回影子。 */
  restoreShadow(): void
}

const controllers = new WeakMap<BrowserWindow, WindowShadowController>()

function shadowBounds(bounds: Rectangle): Rectangle {
  return {
    x: bounds.x - SHADOW_MARGIN,
    y: bounds.y - SHADOW_MARGIN,
    width: bounds.width + SHADOW_MARGIN * 2,
    height: bounds.height + SHADOW_MARGIN * 2,
  }
}

export function attachWindowShadow(window: BrowserWindow): void {
  if (process.platform !== 'win32' || window.isDestroyed() || controllers.has(window)) return

  const shadow = new BrowserWindow({
    ...shadowBounds(window.getBounds()),
    backgroundColor: '#00000000',
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  shadow.setMenuBarVisibility(false)
  shadow.setIgnoreMouseEvents(true)
  void shadow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SHADOW_HTML)}`)

  // 拖动/缩放进行中收起影子：独立阴影窗跟手是异步的，移动中难免脱钩——
  // 连续 ≥2 次 sync 判定为真拖动后暂隐，停稳 180ms 淡回；聚焦/显示时强制恢复，
  // 启动阶段的一次性 move 事件永远不会把影子藏起来。
  let burstCount = 0
  let dragHidden = false
  let dragHideTimer: NodeJS.Timeout | null = null

  const controller: WindowShadowController = {
    shadow,
    pulse() {
      if (window.isDestroyed() || shadow.isDestroyed()) return
      void shadow.webContents.executeJavaScript(
        "(()=>{const s=document.querySelector('.shadow');s.classList.add('lift');setTimeout(()=>s.classList.remove('lift'),620)})()",
      ).catch(() => undefined)
    },
    sync() {
      if (window.isDestroyed() || shadow.isDestroyed()) return
      shadow.setBounds(shadowBounds(window.getBounds()), false)
      burstCount += 1
      if (burstCount >= 2 && !dragHidden) {
        dragHidden = true
        void shadow.webContents.executeJavaScript(
          "(()=>{const s=document.querySelector('.shadow');s.classList.add('drag-hide')})()",
        ).catch(() => undefined)
      }
      if (dragHideTimer) clearTimeout(dragHideTimer)
      dragHideTimer = setTimeout(() => {
        dragHideTimer = null
        burstCount = 0
        this.restoreShadow()
      }, 180)
    },
    restoreShadow() {
      burstCount = 0
      if (dragHideTimer) {
        clearTimeout(dragHideTimer)
        dragHideTimer = null
      }
      if (!dragHidden) return
      dragHidden = false
      void shadow.webContents.executeJavaScript(
        "(()=>{const s=document.querySelector('.shadow');s.classList.remove('drag-hide')})()",
      ).catch(() => undefined)
    },
    showBehind() {
      if (window.isDestroyed() || shadow.isDestroyed() || window.isMinimized() || !window.isVisible()) return
      this.sync()
      this.restoreShadow()
      shadow.showInactive()
      // Raise both windows as a pair. Moving only the main window leaves the
      // shadow behind other applications; moveAbove(shadow) can instead demote
      // the main window to the shadow's previous Z-order position. The shadow
      // cannot take focus or mouse input, so moving it first and the main window
      // second keeps the pair together without changing keyboard focus.
      shadow.moveTop()
      window.moveTop()
    },
  }
  controllers.set(window, controller)

  const sync = () => controller.sync()
  const showBehind = () => controller.showBehind()
  const hide = () => {
    if (!shadow.isDestroyed()) shadow.hide()
  }

  window.on('move', sync)
  window.on('resize', sync)
  window.on('focus', showBehind)
  window.on('show', showBehind)
  window.on('restore', showBehind)
  window.on('hide', hide)
  window.on('minimize', hide)
  window.once('closed', () => {
    controllers.delete(window)
    if (!shadow.isDestroyed()) shadow.destroy()
  })
}

export function syncWindowShadow(window: BrowserWindow): void {
  controllers.get(window)?.sync()
}

export function showWindowShadow(window: BrowserWindow): void {
  controllers.get(window)?.showBehind()
}

/** 模式翻转时的阴影脉冲（卡片抬起，影子收拢变淡后恢复）。 */
export function pulseWindowShadow(window: BrowserWindow): void {
  controllers.get(window)?.pulse()
}
