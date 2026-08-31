import { describe, expect, it, vi } from 'vitest'
import { ensureDshVersionInstalled } from '../electron/runtime-versions'

describe('ensureDshVersionInstalled', () => {
  it('版本已安装时直接返回，不触发安装', async () => {
    const install = vi.fn(async () => undefined)
    const result = await ensureDshVersionInstalled(
      [{ version: '1.2.3' }, { version: '2.0.0' }],
      install,
      '2.0.0',
    )
    expect(result).toBe(true)
    expect(install).not.toHaveBeenCalled()
  })

  it('版本缺失时调用安装并返回 true', async () => {
    const install = vi.fn(async () => undefined)
    const result = await ensureDshVersionInstalled([{ version: '1.2.3' }], install, '3.1.4')
    expect(install).toHaveBeenCalledWith('3.1.4')
    expect(result).toBe(true)
  })

  it('版本号缺省（raw 包未声明）时跳过，不触发安装', async () => {
    const install = vi.fn(async () => undefined)
    expect(await ensureDshVersionInstalled([], install, null)).toBe(false)
    expect(await ensureDshVersionInstalled([], install, undefined)).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})