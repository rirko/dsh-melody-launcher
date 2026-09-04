/**
 * 窗口模式切换的目标位置计算（纯函数，不依赖 electron，便于单测）。
 *
 * 旧实现把目标框算成「工作区正中」，用户把窗口挪到别处后一切换模式
 * 就会被拽回屏幕中央；且尺寸判定在高 DPI 下因工作区钳制不相等，
 * 还会走一段 100ms 缩放动画（体感"卡一下"）。现在：
 *  - 尺寸装得下 → 原位置原尺寸，完全不动；
 *  - 需要缩放 → 只钳制尺寸，保持当前窗口中心（中心夹回工作区内），绝不强制居中。
 */

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** 工作区四周留白，防止窗口完全贴住屏幕边缘/任务栏。 */
export const WINDOW_WORK_AREA_MARGIN = 24

export function resolveWindowModeTarget(
  current: WindowBounds,
  size: WindowSize,
  workArea: WindowBounds,
): { bounds: WindowBounds; resizeNeeded: boolean } {
  const availableWidth = Math.max(1, workArea.width - WINDOW_WORK_AREA_MARGIN * 2)
  const availableHeight = Math.max(1, workArea.height - WINDOW_WORK_AREA_MARGIN * 2)
  const width = Math.min(size.width, availableWidth)
  const height = Math.min(size.height, availableHeight)

  if (current.width === width && current.height === height) {
    return { bounds: current, resizeNeeded: false }
  }

  const centerX = current.x + current.width / 2
  const centerY = current.y + current.height / 2
  const minCenterX = workArea.x + WINDOW_WORK_AREA_MARGIN + width / 2
  const maxCenterX = workArea.x + workArea.width - WINDOW_WORK_AREA_MARGIN - width / 2
  const minCenterY = workArea.y + WINDOW_WORK_AREA_MARGIN + height / 2
  const maxCenterY = workArea.y + workArea.height - WINDOW_WORK_AREA_MARGIN - height / 2
  const clampedCenterX = Math.min(Math.max(centerX, minCenterX), Math.max(maxCenterX, minCenterX))
  const clampedCenterY = Math.min(Math.max(centerY, minCenterY), Math.max(maxCenterY, minCenterY))
  return {
    bounds: {
      x: Math.round(clampedCenterX - width / 2),
      y: Math.round(clampedCenterY - height / 2),
      width,
      height,
    },
    resizeNeeded: true,
  }
}
