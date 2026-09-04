/**
 * DeepSeek 官方价目快照与峰谷时段判定（余额小卡用）。
 * 官方规则：高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，
 * 其余时间（含周末全天）为空闲时段，价格为高峰价一半。价格页改版时手动更新快照。
 */

export type PricingPeriod = 'peak' | 'off'

/** 元 / 百万 tokens（高峰价）。 */
export const DEEPSEEK_PRICING: Array<{ model: string; hit: number; miss: number; output: number }> = [
  { model: 'deepseek-v4-flash', hit: 0.1, miss: 3, output: 9 },
  { model: 'deepseek-v4-pro', hit: 0.3, miss: 9, output: 27 },
]

const PEAK_WINDOWS_MINUTES: Array<[number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 按北京时间判定当前处于峰段还是谷段。 */
export function pricingPeriod(now: Date, timeZone = 'Asia/Shanghai'): PricingPeriod {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const weekday = parts.find(part => part.type === 'weekday')?.value ?? ''
  if (weekday === 'Sat' || weekday === 'Sun') return 'off'
  // hour12:false 在部分 ICU 版本里午夜返回 24，取模归一。
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0') % 24
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0')
  const minutes = hour * 60 + minute
  return PEAK_WINDOWS_MINUTES.some(([start, end]) => minutes >= start && minutes < end) ? 'peak' : 'off'
}

/** 谷段半价后的展示价格，去掉多余的尾零（13.50 → 13.5，2.00 → 2）。 */
export function periodPrice(peakValue: number, period: PricingPeriod): string {
  const value = period === 'off' ? peakValue / 2 : peakValue
  return value.toFixed(2).replace(/\.?0+$/, '')
}
