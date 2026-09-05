import { BrowserWindow, type Rectangle } from 'electron'

const SHADOW_MARGIN = 30
const SHADOW_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      .shadow {
        position: absolute;
        inset: ${SHADOW_MARGIN}px;
        border-radius: 14px;
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

  // 拖动/缩放进行中收起影子：独立阴影窗跟手是异步的，移动中难免脱钩；
  // 停稳 160ms 后淡回。隐藏状态每次爆发只通知一次，不逐 move 打 executeJavaScript。
  let dragHidden = false
  let dragHideTimer: NodeJS.Timeout | null = null

  const controller: WindowShadowController = {
    shadow,
    pulse() {
      if (window.isDestroyed() || shadow.isDestroyed()) return
      void shadow.webContents.executeJavaScript(
        "const s=document.querySelector('.shadow');s.classList.add('lift');setTimeout(()=>s.classList.remove('lift'),620)",
      ).catch(() => undefined)
    },
    sync() {
      if (window.isDestroyed() || shadow.isDestroyed()) return
      shadow.setBounds(shadowBounds(window.getBounds()), false)
      // move/resize 事件爆发 = 正在拖动或拖拽边框：影子暂隐，停稳后淡回。
      void shadow.webContents.executeJavaScript(
        "const s=document.querySelector('.shadow');s.classList.add('drag-hide')",
      ).catch(() => undefined)
      if (dragHideTimer) clearTimeout(dragHideTimer)
      dragHideTimer = setTimeout(() => {
        dragHideTimer = null
        void shadow.webContents.executeJavaScript(
          "const s=document.querySelector('.shadow');s.classList.remove('drag-hide')",
        ).catch(() => undefined)
      }, 160)
    },
    showBehind() {
      if (window.isDestroyed() || shadow.isDestroyed() || window.isMinimized() || !window.isVisible()) return
      this.sync()
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
