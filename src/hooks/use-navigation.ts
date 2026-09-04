import { useCallback, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { errorText } from '../lib/format'
import type { HomeTab, ViewName, WindowMode } from '../types'

export type SurfaceTransitionPhase = 'idle'

/**
 * 界面导航。一级导航拍平后 launcher/manager 共用同一窗口尺寸，
 * 切 surface 不再需要"先退场再改窗口"的过渡动画——即时换页才跟手。
 */
export function useNavigation(onError: (message: string) => void) {
  const api = useLauncherApi()
  const [surface, setSurface] = useState<WindowMode>('launcher')
  const [view, setView] = useState<ViewName>('plugins')
  // 一级导航：启动 surface 内的当前 tab（顶栏切换，不换窗口）。
  const [homeTab, setHomeTab] = useState<HomeTab>('start')
  const surfaceRef = useRef<WindowMode>('launcher')

  const changeSurface = useCallback((next: WindowMode) => {
    if (next === surfaceRef.current) return
    surfaceRef.current = next
    setSurface(next)
    void api.setWindowMode(next).catch(error => onError(errorText(error)))
  }, [api, onError])

  const goHome = useCallback((tab: HomeTab) => {
    setHomeTab(tab)
    changeSurface('launcher')
  }, [changeSurface])

  return {
    surface,
    transitionPhase: 'idle' as SurfaceTransitionPhase,
    view,
    setView,
    homeTab,
    goHome,
    showManager: useCallback(() => changeSurface('manager'), [changeSurface]),
    showLauncher: useCallback(() => changeSurface('launcher'), [changeSurface]),
  }
}
