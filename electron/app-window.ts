import { BrowserWindow, screen, type Rectangle } from 'electron'
import type { WindowMode } from '../src/types'
import { attachWindowShadow, showWindowShadow, syncWindowShadow } from './window-shadow'

/** 主窗口的创建、尺寸模式切换，以及发往渲染层的消息通道。 */

interface WindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export const WINDOW_MODES: Record<WindowMode, WindowSize> = {
  launcher: { width: 900, height: 560, minWidth: 760, minHeight: 480 },
  manager: { width: 1380, height: 860, minWidth: 1024, minHeight: 680 },
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
const WINDOW_WORK_AREA_MARGIN = 24

interface WindowModeAnimation {
  cancelled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const windowModeAnimations = new WeakMap<BrowserWindow, WindowModeAnimation>()

function easeOutCubic(progress: number): number {
  // 先响应、后收束；比高次缓出更连贯，不会在开始时突然冲出。
  return 1 - Math.pow(1 - progress, 3)
}

function interpolate(from: number, to: number, progress: number): number {
  return Math.round(from + (to - from) * progress)
}

function centeredTargetBounds(current: Rectangle, size: WindowSize): Rectangle {
  const workArea = screen.getDisplayMatching(current).workArea
  // Keep the design size when it fits, but never let the manager extend
  // behind the taskbar or outside a smaller/high-DPI display.
  const availableWidth = Math.max(1, workArea.width - WINDOW_WORK_AREA_MARGIN * 2)
  const availableHeight = Math.max(1, workArea.height - WINDOW_WORK_AREA_MARGIN * 2)
  const width = Math.min(size.width, availableWidth)
  const height = Math.min(size.height, availableHeight)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  }
}

function cancelWindowModeAnimation(window: BrowserWindow): void {
  const current = windowModeAnimations.get(window)
  if (!current) return
  current.cancelled = true
  if (current.timer) clearTimeout(current.timer)
  windowModeAnimations.delete(window)
}

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
    title: 'DSH Launcher',
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
  cancelWindowModeAnimation(window)

  const size = WINDOW_MODES[mode]
  if (window.isMaximized()) window.unmaximize()

  // Windows may expose a newly resized region before Chromium paints its next
  // frame. Keep the fallback aligned with the shell color so no gray/white
  // square is exposed during the resize.
  window.setBackgroundColor(WINDOW_BACKGROUND_COLOR)

  const startBounds = window.getBounds()
  const targetBounds = centeredTargetBounds(startBounds, size)
  const targetMinWidth = Math.min(size.minWidth, targetBounds.width)
  const targetMinHeight = Math.min(size.minHeight, targetBounds.height)
  const [currentMinWidth, currentMinHeight] = window.getMinimumSize()

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

  animateFrame()
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
