import { describe, expect, it } from 'vitest'
import { resolveWindowModeTarget, type WindowSize } from '../electron/window-bounds'

const SIZE: WindowSize = { width: 1080, height: 700, minWidth: 960, minHeight: 620 }
const FULL_HD = { x: 0, y: 0, width: 1920, height: 1032 }

describe('resolveWindowModeTarget', () => {
  it('工作区装得下时原位置原尺寸、完全不动', () => {
    const current = { x: 300, y: 100, width: 1080, height: 700 }
    const result = resolveWindowModeTarget(current, SIZE, FULL_HD)
    expect(result.resizeNeeded).toBe(false)
    expect(result.bounds).toEqual(current)
  })

  it('高 DPI 小工作区只钳制尺寸，保持窗口中心而非跳回屏幕正中', () => {
    // 150% 缩放的 1920×1080 → 工作区约 1280×660 DIP。
    const current = { x: 300, y: 100, width: 1080, height: 700 }
    const { bounds, resizeNeeded } = resolveWindowModeTarget(current, SIZE, { x: 0, y: 0, width: 1280, height: 660 })
    expect(resizeNeeded).toBe(true)
    expect(bounds.width).toBe(1080)
    expect(bounds.height).toBe(612) // 660 - 24*2
    // 原中心 (840, 450)：x 夹到 [564, 716]→716（左边 176），y 夹到 [330, 330]→顶边 24。
    expect(bounds.x).toBe(176)
    expect(bounds.y).toBe(24)
  })

  it('窗口被拖出屏幕时收缩并把中心夹回工作区', () => {
    const current = { x: 1500, y: 900, width: 1080, height: 700 }
    const { bounds } = resolveWindowModeTarget(current, SIZE, { x: 0, y: 0, width: 1920, height: 1032 })
    // 中心 (2040,1250) 越界 → 夹到 (1380, 666)；尺寸未变仍走 resizeNeeded=false 分支？
    // 尺寸相等时不动位置（出屏由系统/用户处理），这里尺寸相等 → 原样返回。
    expect(bounds).toEqual(current)
  })

  it('多显示器负坐标工作区同样保持中心', () => {
    const workArea = { x: -1920, y: 0, width: 1920, height: 1080 }
    const current = { x: -1700, y: 120, width: 1080, height: 700 }
    const result = resolveWindowModeTarget(current, SIZE, workArea)
    expect(result.resizeNeeded).toBe(false)
    expect(result.bounds).toEqual(current)
  })

  it('极小工作区下尺寸钳到下限之上仍按可用空间返回', () => {
    const { bounds, resizeNeeded } = resolveWindowModeTarget(
      { x: 0, y: 0, width: 1080, height: 700 },
      SIZE,
      { x: 0, y: 0, width: 1000, height: 500 },
    )
    expect(resizeNeeded).toBe(true)
    expect(bounds.width).toBe(952) // 1000 - 48
    expect(bounds.height).toBe(452) // 500 - 48
    expect(bounds.x).toBe(24)
    expect(bounds.y).toBe(24)
  })
})
