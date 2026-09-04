import { describe, expect, it } from 'vitest'
import { DEEPSEEK_PRICING, periodPrice, pricingPeriod } from '../src/lib/deepseek-pricing'

// 北京时间 = UTC+8，用 UTC 时刻构造边界。2026-09-04 是周五，2026-09-05 是周六。
const bj = (utc: string) => new Date(utc)

describe('pricingPeriod', () => {
  it('工作日峰段窗口内为 peak（9:00-12:00、14:00-18:00）', () => {
    expect(pricingPeriod(bj('2026-09-04T01:00:00Z'))).toBe('peak') // 北京 09:00 整点
    expect(pricingPeriod(bj('2026-09-04T03:59:00Z'))).toBe('peak') // 北京 11:59
    expect(pricingPeriod(bj('2026-09-04T06:00:00Z'))).toBe('peak') // 北京 14:00 整点
    expect(pricingPeriod(bj('2026-09-04T09:59:00Z'))).toBe('peak') // 北京 17:59
  })

  it('窗口边界与窗口之间为 off', () => {
    expect(pricingPeriod(bj('2026-09-04T00:59:00Z'))).toBe('off') // 北京 08:59
    expect(pricingPeriod(bj('2026-09-04T04:00:00Z'))).toBe('off') // 北京 12:00（12:00 不含）
    expect(pricingPeriod(bj('2026-09-04T05:59:00Z'))).toBe('off') // 北京 13:59
    expect(pricingPeriod(bj('2026-09-04T10:00:00Z'))).toBe('off') // 北京 18:00（18:00 不含）
    expect(pricingPeriod(bj('2026-09-03T16:00:00Z'))).toBe('off') // 北京 00:00 午夜
  })

  it('周末全天为 off', () => {
    expect(pricingPeriod(bj('2026-09-05T01:00:00Z'))).toBe('off') // 周六北京 09:00
    expect(pricingPeriod(bj('2026-09-06T06:00:00Z'))).toBe('off') // 周日北京 14:00
  })
})

describe('periodPrice', () => {
  it('峰段原价、谷段半价并去尾零', () => {
    expect(periodPrice(3, 'peak')).toBe('3')
    expect(periodPrice(3, 'off')).toBe('1.5')
    expect(periodPrice(27, 'off')).toBe('13.5')
    expect(periodPrice(0.1, 'off')).toBe('0.05')
    expect(periodPrice(0.3, 'peak')).toBe('0.3')
  })
})

it('价目快照与官方高峰价一致', () => {
  expect(DEEPSEEK_PRICING).toEqual([
    { model: 'deepseek-v4-flash', hit: 0.1, miss: 3, output: 9 },
    { model: 'deepseek-v4-pro', hit: 0.3, miss: 9, output: 27 },
  ])
})
