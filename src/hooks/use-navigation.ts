import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { errorText } from '../lib/format'
import type { ViewName, WindowMode } from '../types'

export type SurfaceTransitionPhase = 'idle' | 'exiting' | 'entering'

const SURFACE_EXIT_DURATION = 28
const SURFACE_ENTER_DURATION = 132

/**
 * 界面导航。切换 surface 时窗口尺寸也要跟着变，
 * 这个副作用属于导航本身，因此和导航状态放在一起。
 */
export function useNavigation(onError: (message: string) => void) {
  const api = useLauncherApi()
  const [surface, setSurface] = useState<WindowMode>('launcher')
  const [transitionPhase, setTransitionPhase] = useState<SurfaceTransitionPhase>('idle')
  const [view, setView] = useState<ViewName>('plugins')
  const surfaceRef = useRef<WindowMode>('launcher')
  const transitionPhaseRef = useRef<SurfaceTransitionPhase>('idle')
  const transitionTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const transitionFrameIdsRef = useRef<number[]>([])

  const clearTransitionTimers = useCallback(() => {
    transitionTimersRef.current.forEach(timer => clearTimeout(timer))
    transitionTimersRef.current = []
    if (typeof cancelAnimationFrame === 'function') {
      transitionFrameIdsRef.current.forEach(frameId => cancelAnimationFrame(frameId))
    }
    transitionFrameIdsRef.current = []
  }, [])

  useEffect(() => clearTransitionTimers, [clearTransitionTimers])

  const changeSurface = useCallback((next: WindowMode) => {
    if (next === surfaceRef.current || transitionPhaseRef.current !== 'idle') return

    clearTransitionTimers()
    transitionPhaseRef.current = 'exiting'
    setTransitionPhase('exiting')

    const exitTimer = setTimeout(() => {
      surfaceRef.current = next
      setSurface(next)

      // 等待新页面完成两帧绘制后再调整原生窗口尺寸。只等待一个
      // setTimeout(0) 时，Windows 可能先暴露旧的启动页表面，导致放大
      // 过程中出现黑色背景。
      const resizeWindow = () => {
        transitionFrameIdsRef.current = []
        void api.setWindowMode(next).catch(error => onError(errorText(error)))
      }
      if (typeof requestAnimationFrame === 'function') {
        const firstFrame = requestAnimationFrame(() => {
          const secondFrame = requestAnimationFrame(resizeWindow)
          transitionFrameIdsRef.current = [secondFrame]
        })
        transitionFrameIdsRef.current = [firstFrame]
      } else {
        const timer = setTimeout(resizeWindow, 32)
        transitionTimersRef.current = [timer]
      }

      transitionPhaseRef.current = 'entering'
      setTransitionPhase('entering')

      const enterTimer = setTimeout(() => {
        transitionPhaseRef.current = 'idle'
        transitionTimersRef.current = []
        setTransitionPhase('idle')
      }, SURFACE_ENTER_DURATION)
      transitionTimersRef.current = [enterTimer]
    }, SURFACE_EXIT_DURATION)
    transitionTimersRef.current = [exitTimer]
  }, [api, clearTransitionTimers, onError])

  return {
    surface,
    transitionPhase,
    view,
    setView,
    showManager: useCallback(() => changeSurface('manager'), [changeSurface]),
    showLauncher: useCallback(() => changeSurface('launcher'), [changeSurface]),
  }
}
