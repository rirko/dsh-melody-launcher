import type { RuntimeDrawerMode } from '../types'

export const MIN_RUNTIME_DRAWER_HEIGHT = 180
export const MAX_RUNTIME_DRAWER_HEIGHT = 760
export const RUNTIME_DRAWER_AUTO_CLOSE_MS = 3_000

export function nextRuntimeDrawerMode(mode: RuntimeDrawerMode): RuntimeDrawerMode {
  if (mode === 'hidden') return 'half'
  if (mode === 'half') return 'expanded'
  return 'hidden'
}

export function clampRuntimeDrawerHeight(height: number): number {
  if (!Number.isFinite(height)) return 260
  return Math.max(MIN_RUNTIME_DRAWER_HEIGHT, Math.min(MAX_RUNTIME_DRAWER_HEIGHT, Math.round(height)))
}
