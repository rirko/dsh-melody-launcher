import { describe, expect, it } from 'vitest'
import { clampRuntimeDrawerHeight, nextRuntimeDrawerMode, RUNTIME_DRAWER_AUTO_CLOSE_MS } from '../src/lib/runtime-drawer'

describe('runtime drawer state', () => {
  it('cycles hidden, half and expanded in order', () => {
    expect(nextRuntimeDrawerMode('hidden')).toBe('half')
    expect(nextRuntimeDrawerMode('half')).toBe('expanded')
    expect(nextRuntimeDrawerMode('expanded')).toBe('hidden')
  })

  it('uses a three-second automatic close delay', () => {
    expect(RUNTIME_DRAWER_AUTO_CLOSE_MS).toBe(3_000)
  })

  it('clamps persisted and dragged heights to the supported range', () => {
    expect(clampRuntimeDrawerHeight(120)).toBe(180)
    expect(clampRuntimeDrawerHeight(260.6)).toBe(261)
    expect(clampRuntimeDrawerHeight(900)).toBe(760)
    expect(clampRuntimeDrawerHeight(Number.NaN)).toBe(260)
  })
})
