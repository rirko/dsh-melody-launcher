// DeepSeek 官方余额查询（GET https://api.deepseek.com/user/balance，Bearer sk- key）。
// 渲染层不碰网络也不碰 key：ipc 层从凭据存储读 key，这里只负责请求与解析。

import type { DeepSeekBalance, DeepSeekBalanceInfo, DeepSeekBalanceResult } from '../src/types'

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

function toAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** 官方现行格式是 balance_infos[]；旧版单一 balance 字段做兼容；结构对不上返回 null。 */
export function parseDeepSeekBalance(payload: unknown): DeepSeekBalance | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  const isAvailable = raw.is_available !== false
  if (Array.isArray(raw.balance_infos) && raw.balance_infos.length > 0) {
    const infos = raw.balance_infos.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const info = item as Record<string, unknown>
      const total = toAmount(info.total_balance) ?? toAmount(info.balance)
      if (total === null) return []
      return [{
        currency: typeof info.currency === 'string' ? info.currency : 'CNY',
        totalBalance: total,
        grantedBalance: toAmount(info.granted_balance),
        toppedUpBalance: toAmount(info.topped_up_balance),
      } satisfies DeepSeekBalanceInfo]
    })
    return infos.length > 0 ? { isAvailable, infos } : null
  }
  const legacy = toAmount(raw.balance)
  if (legacy !== null) {
    return { isAvailable, infos: [{ currency: 'CNY', totalBalance: legacy, grantedBalance: null, toppedUpBalance: null }] }
  }
  return null
}

export interface DeepSeekBalanceService {
  get(force?: boolean): Promise<DeepSeekBalanceResult>
}

/** 内存缓存 5 分钟：余额不是实时数据，首页轮询要克制（网关有统一限流器）。 */
export function createDeepSeekBalanceService(options: {
  fetchImpl: typeof fetch
  readApiKey: () => Promise<string | null>
  cacheMs?: number
}): DeepSeekBalanceService {
  const cacheMs = options.cacheMs ?? 5 * 60_000
  let cached: { at: number; result: DeepSeekBalanceResult } | null = null
  let inflight: Promise<DeepSeekBalanceResult> | null = null

  const request = async (): Promise<DeepSeekBalanceResult> => {
    const apiKey = await options.readApiKey()
    if (!apiKey) return { status: 'no-key' }
    try {
      const response = await options.fetchImpl(DEEPSEEK_BALANCE_URL, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.status === 401) return { status: 'error', message: 'API 密钥无效或已失效，请在开发人员选项里更新。' }
      if (!response.ok) return { status: 'error', message: `DeepSeek 返回 HTTP ${response.status}` }
      const balance = parseDeepSeekBalance(await response.json())
      if (!balance) return { status: 'error', message: 'DeepSeek 余额响应格式不认识。' }
      return { status: 'ok', balance }
    } catch (cause) {
      return { status: 'error', message: cause instanceof Error ? `查询失败：${cause.message}` : '查询失败' }
    }
  }

  return {
    async get(force?: boolean) {
      if (!force && cached && Date.now() - cached.at < cacheMs) return cached.result
      if (inflight) return inflight
      inflight = request()
      try {
        const result = await inflight
        // no-key 不缓存：用户随时可能在设置里补 key。
        if (result.status !== 'no-key') cached = { at: Date.now(), result }
        return result
      } finally {
        inflight = null
      }
    },
  }
}
