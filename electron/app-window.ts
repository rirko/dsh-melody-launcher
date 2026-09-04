import { BrowserWindow, screen } from 'electron'
import type { WindowMode } from '../src/types'
import { attachWindowShadow, showWindowShadow, syncWindowShadow } from './window-shadow'
import { resolveWindowModeTarget, type WindowSize } from './window-bounds'

/** 主窗口的创建、尺寸模式切换，以及发往渲染层的消息通道。 */

// 一级导航改造后：启动页与管理界面共用同一个固定尺寸窗口（PCL2 式单窗换页）。
export const WINDOW_MODES: Record<WindowMode, WindowSize> = {
  launcher: { width: 1080, height: 700, minWidth: 960, minHeight: 620 },
  manager: { width: 1080, height: 700, minWidth: 960, minHeight: 620 },
}

const WINDOW_MODE_ANIMATION_DURATION = 100
// Drive high-refresh displays more frequently than the traditional 60 Hz
// interval. Windows still coalesces updates to the compositor refresh rate.
const WINDOW_MODE_ANIMATION_FRAME = 8
// A transparent BrowserWindow can keep the old backing surface after its first
// native expansion. Repaint once immediately and once after the compositor
// has committed the new bounds so the newly exposed right edge is filled.
const WINDOW_MODE_REPAINT_DELAY = 16
const WINDOW_BACKGROUND_COLOR = '#00000000'

function invalidateAfterResize(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.invalidate()
  setTimeout(() => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.invalidate()
  }, WINDOW_MODE_REPAINT_DELAY)
}

/**
 * Apply a mode without the visual transition. This is used when a transparent
 * window is first shown or restored from the tray, where the native bounds may
 * have been restored independently from the renderer surface.
 */
export function applyWindowModeImmediate(window: BrowserWindow | null, mode: WindowMode): void {
  if (!window || window.isDestroyed()) return
  cancelWindowModeAnimation(window)

  const size = WINDOW_MODES[mode]
  if (window.isMaximized()) window.unmaximize()

  const targetBounds = centeredTargetBounds(window.getBounds(), size)
  window.setMinimumSize(
    Math.min(size.minWidth, targetBounds.width),
    Math.min(size.minHeight, targetBounds.height),
  )
  window.setBounds(targetBounds, false)
  syncWindowShadow(window)
  invalidateAfterResize(window)
}

export function isWindowMode(value: unknown): value is WindowMode {
  return value === 'launcher' || value === 'manager'
}

export interface CreateWindowOptions {
  preloadPath: string
  iconPath: string
  /** 开发模式下的 Vite 地址；缺省则加载打包后的 index.html。 */
  devServerUrl?: string
  indexPath: string
  onClosed: () => void
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const initialSize = WINDOW_MODES.launcher
  const window = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: initialSize.minWidth,
    minHeight: initialSize.minHeight,
    // Keep the native surface transparent so the renderer's rounded shell is
    // the actual outer edge instead of a rounded panel over a square window.
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    transparent: true,
    frame: false,
    // WS_THICKFRAME restores the native shadow but also paints an unavoidable
    // black activation outline. A separate click-through shadow window is used.
    thickFrame: false,
    // Keep the Windows compositor's corner clipping. This is independent of
    // thickFrame: the latter stays disabled to avoid the black activation
    // outline, while roundedCorners restores the v0.1.1 window silhouette.
    roundedCorners: true,
    hasShadow: true,
    icon: options.iconPath,
    title: 'DSH-Melody-Launcher',
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.setMenuBarVisibility(false)
  // Re-assert the compositor shadow after creating a borderless window.
  window.setHasShadow(true)
  window.once('closed', options.onClosed)
  attachWindowShadow(window)
  window.once('ready-to-show', () => {
    applyWindowModeImmediate(window, 'launcher')
    window.show()
    showWindowShadow(window)
  })

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl)
  } else {
    void window.loadFile(options.indexPath)
  }
  return window
}

export function applyWindowMode(window: BrowserWindow | null, mode: WindowMode): void {
  if (!window || window.isDestroyed()) return

  const size = WINDOW_MODES[mode]
  if (window.isMaximized()) window.unmaximize()

  // Windows may expose a newly resized region before Chromium paints its next
  // frame. Keep the fallback aligned with the shell color so no gray/white
  // square is exposed during the resize.
  window.setBackgroundColor(WINDOW_BACKGROUND_COLOR)

  const current = window.getBounds()
  const workArea = screen.getDisplayMatching(current).workArea
  const { bounds, resizeNeeded } = resolveWindowModeTarget(current, size, workArea)
  const targetMinWidth = Math.min(size.minWidth, bounds.width)
  const targetMinHeight = Math.min(size.minHeight, bounds.height)

  // Keep one absolute screen-space anchor for the whole resize. Interpolating
  // x/y independently from width/height can produce alternating half-pixel
  // rounding, which makes the launcher background appear to wobble by 1px.
  // The target is already centered in the display work area, so use that exact
  // center for every frame instead of recalculating it from rounded bounds.
  const anchorCenterX = targetBounds.x + targetBounds.width / 2
  const anchorCenterY = targetBounds.y + targetBounds.height / 2

  // 扩大窗口时若先提高最小尺寸，Windows 会立即把窗口跳到新下限。
  // 动画期间保留两种模式中更小的限制，结束后再应用目标限制。
  window.setMinimumSize(
    Math.min(currentMinWidth, targetMinWidth),
    Math.min(currentMinHeight, targetMinHeight),
  )

  const animation: WindowModeAnimation = { cancelled: false, timer: null }
  const startedAt = performance.now()
  windowModeAnimations.set(window, animation)

  const animateFrame = () => {
    if (animation.cancelled || window.isDestroyed()) return

    const elapsed = performance.now() - startedAt
    const progress = Math.min(1, elapsed / WINDOW_MODE_ANIMATION_DURATION)
    const eased = easeOutCubic(progress)

    // Keep the native fallback surface aligned with the shell while exposing
    // the next resized frame.
    window.setBackgroundColor(WINDOW_BACKGROUND_COLOR)
    const width = interpolate(startBounds.width, targetBounds.width, eased)
    const height = interpolate(startBounds.height, targetBounds.height, eased)
    window.setBounds({
      x: Math.round(anchorCenterX - width / 2),
      y: Math.round(anchorCenterY - height / 2),
      width,
      height,
    })
    syncWindowShadow(window)

    if (progress >= 1) {
      window.setMinimumSize(targetMinWidth, targetMinHeight)
      invalidateAfterResize(window)
      windowModeAnimations.delete(window)
      return
    }

    animation.timer = setTimeout(animateFrame, WINDOW_MODE_ANIMATION_FRAME)
  }

  // 仅当工作区装不下设计尺寸时单次 setBounds 收缩（保持窗口中心）。
  // 不再做 100ms 逐帧缩放动画：那是"卡一下再跳走"观感的来源。
  window.setMinimumSize(targetMinWidth, targetMinHeight)
  window.setBounds(bounds)
  syncWindowShadow(window)
}

/**
 * 发往渲染层的单一出口。
 * 「窗口是否还活着」的判断原本在三处推送逻辑里各写了一遍，这里收敛为一处。
 */
export interface RendererChannel {
  send(channel: string, payload: unknown): void
}

export function createRendererChannel(getWindow: () => BrowserWindow | null): RendererChannel {
  return {
    send(channel, payload) {
      const window = getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(channel, payload)
    },
  }
}
