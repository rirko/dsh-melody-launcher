// DSH 本地会话日志用量聚合：今日 Token 与缓存命中率。
// 数据源全部在 {dshHome} 本地磁盘（DSH 自己落盘的投影与会话日志），不发起任何网络请求。
// 快速路径读 storages/session_projcache.json 的每会话 totals；跨天活跃会话再扫
// sessions/{projectKey}/{sessionId}/session.jsonl(.zstd) 的逐 step usage 明细。

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import * as zlib from 'node:zlib'
import type { DshUsage, DshUsageResult } from '../src/types'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const zstdDecompressSync = (zlib as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync

export interface UsageRecord {
  time: number
  turn: number
  step: number
  input: number
  output: number
  cacheRead: number
}

interface TokenTotals {
  uncachedInput: number
  output: number
  cacheRead: number
}

const ZERO: TokenTotals = { uncachedInput: 0, output: 0, cacheRead: 0 }

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function sumTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return { uncachedInput: a.uncachedInput + b.uncachedInput, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead }
}

export function todayTokens(totals: TokenTotals): number {
  return totals.uncachedInput + totals.output + totals.cacheRead
}

/** 命中率 = 缓存读 /（缓存读 + 未缓存输入）；没有输入侧数据时返回 null。 */
export function cacheHitRate(totals: TokenTotals): number | null {
  const inputSide = totals.uncachedInput + totals.cacheRead
  return inputSide > 0 ? totals.cacheRead / inputSide : null
}

export function startOfLocalDay(nowMs: number): number {
  const day = new Date(nowMs)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * 解析会话日志明文行，按 (turn, step) 折叠：
 * assistant/message 的 data.usage 是最终样本，assistant/chunk(usage) 是早期样本，同键后者覆盖前者、不重复计数。
 */
export function parseSessionLogText(text: string): UsageRecord[] {
  const folded = new Map<string, UsageRecord>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: unknown
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue // 撕裂行直接跳过
    }
    const entry = row as {
      type?: unknown
      time?: unknown
      data?: { turn?: unknown; step?: unknown; usage?: unknown; chunk?: { type?: unknown; usage?: unknown } }
    }
    if (typeof entry.time !== 'number' || typeof entry.data?.turn !== 'number' || typeof entry.data?.step !== 'number') continue
    let usage: Record<string, unknown> | undefined
    if (entry.type === 'assistant/message' && entry.data.usage && typeof entry.data.usage === 'object') {
      usage = entry.data.usage as Record<string, unknown>
    } else if (entry.type === 'assistant/chunk' && entry.data.chunk?.type === 'usage' && entry.data.chunk.usage && typeof entry.data.chunk.usage === 'object') {
      usage = entry.data.chunk.usage as Record<string, unknown>
    }
    if (!usage) continue
    const key = `${entry.data.turn}:${entry.data.step}`
    const record: UsageRecord = {
      time: entry.time,
      turn: entry.data.turn,
      step: entry.data.step,
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
    }
    const previous = folded.get(key)
    if (!previous || record.time >= previous.time) folded.set(key, record)
  }
  return [...folded.values()]
}

/** 多帧拼接的 zstd 容器逐帧解码；尾部撕裂帧解码失败时跳过。无 zstd 能力时返回空串。 */
export function decodeZstdFrames(buffer: Buffer): string {
  if (typeof zstdDecompressSync !== 'function') return ''
  let text = ''
  for (let offset = buffer.indexOf(ZSTD_MAGIC); offset >= 0; offset = buffer.indexOf(ZSTD_MAGIC, offset + 1)) {
    try {
      text += zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
    } catch {
      // 帧不完整（写入中撕裂）：跳过该帧。
    }
  }
  return text
}

interface ProjcacheSession {
  createdAt: number
  lastPromptAt: number | null
  totals: TokenTotals
}

/** 解析 DSH 自己落盘的会话投影（storages/session_projcache.json）。 */
export function parseProjcacheSessions(json: unknown): Map<string, ProjcacheSession> {
  const out = new Map<string, ProjcacheSession>()
  const tables = (json as { tables?: { sessions?: Record<string, unknown> } })?.tables?.sessions
  if (!tables || typeof tables !== 'object') return out
  for (const [sessionId, entry] of Object.entries(tables)) {
    const item = entry as {
      identity?: { createdAt?: unknown }
      rows?: { tokenUsage?: { val?: { totals?: Record<string, unknown> } }; sessionListMetadata?: { val?: { lastPromptAt?: unknown } } }
    }
    const totals = item?.rows?.tokenUsage?.val?.totals
    if (!item?.identity || !totals) continue
    const lastPromptAt = num(item.rows?.sessionListMetadata?.val?.lastPromptAt)
    out.set(sessionId, {
      createdAt: num(item.identity.createdAt),
      lastPromptAt: lastPromptAt > 0 ? lastPromptAt : null,
      totals: {
        uncachedInput: num(totals.uncachedInputTokens),
        output: num(totals.outputTokens),
        cacheRead: num(totals.cacheReadTokens),
      },
    })
  }
  return out
}

/** 在 sessions/{projectKey}/{sessionId}/ 下找会话日志；mtime 早于 sinceMs 直接跳过。 */
async function readSessionRecords(dshHome: string, sessionId: string, sinceMs: number): Promise<UsageRecord[]> {
  const sessionsRoot = path.join(dshHome, 'sessions')
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return []
  }
  for (const project of projects) {
    const dir = path.join(sessionsRoot, project, sessionId)
    for (const file of ['session.jsonl.zstd', 'session.jsonl'] as const) {
      const logPath = path.join(dir, file)
      try {
        const info = await stat(logPath)
        if (info.mtimeMs < sinceMs) continue
        const text = file.endsWith('.zstd') ? decodeZstdFrames(await readFile(logPath)) : await readFile(logPath, 'utf8')
        return parseSessionLogText(text)
      } catch {
        // 该 project 下没有这个会话，试下一个。
      }
    }
  }
  return []
}

export async function readDshUsage(dshHome: string, nowMs = Date.now()): Promise<DshUsageResult> {
  try {
    let raw: string
    try {
      raw = await readFile(path.join(dshHome, 'storages', 'session_projcache.json'), 'utf8')
    } catch {
      return { status: 'no-data' }
    }
    const sessions = parseProjcacheSessions(JSON.parse(raw))
    if (sessions.size === 0) return { status: 'no-data' }

    const todayStart = startOfLocalDay(nowMs)
    let today: TokenTotals = ZERO
    let overall: TokenTotals = ZERO
    for (const [sessionId, session] of sessions) {
      overall = sumTotals(overall, session.totals)
      if (session.createdAt >= todayStart) {
        // 今天新建的会话：totals 全部计为今日。
        today = sumTotals(today, session.totals)
        continue
      }
      if (session.lastPromptAt !== null && session.lastPromptAt >= todayStart) {
        // 跨天活跃会话：只取今日时间窗内的逐 step 明细。
        for (const record of await readSessionRecords(dshHome, sessionId, todayStart)) {
          if (record.time >= todayStart) {
            today = sumTotals(today, { uncachedInput: record.input, output: record.output, cacheRead: record.cacheRead })
          }
        }
      }
    }
    const usage: DshUsage = {
      tokensToday: todayTokens(today),
      cacheHitRate: cacheHitRate(today) ?? cacheHitRate(overall),
    }
    return { status: 'ok', usage }
  } catch (cause) {
    return { status: 'error', message: cause instanceof Error ? cause.message : '读取本地用量失败' }
  }
}

/** 60 秒内存缓存 + in-flight 去重（同 deepseek-balance 模式）。 */
export function createDshUsageService(deps: { readDshHome: () => Promise<string>; cacheMs?: number }) {
  const cacheMs = deps.cacheMs ?? 60_000
  let cached: { at: number; dshHome: string; result: DshUsageResult } | null = null
  let inflight: Promise<DshUsageResult> | null = null
  return {
    async get(force = false): Promise<DshUsageResult> {
      const dshHome = await deps.readDshHome()
      if (!force && cached && cached.dshHome === dshHome && Date.now() - cached.at < cacheMs) return cached.result
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const result = await readDshUsage(dshHome)
          cached = { at: Date.now(), dshHome, result }
          return result
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
  }
}
