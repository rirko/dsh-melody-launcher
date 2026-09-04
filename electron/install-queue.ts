import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstallQueueEntry, InstallQueueJobInputs, InstallQueueKind, InstallQueueSnapshot } from '../src/types'

/**
 * 全局下载任务队列：所有会改写 Profile 或下载资源的耗时操作在这里串行执行。
 *
 * - 任务以可序列化描述符（kind + payload）登记，执行器由 main.ts 装配时注入；
 *   这样待执行任务可以原子落盘并在重启后恢复继续执行。
 * - enqueue 返回的 Promise 在该任务真实完成/失败/取消时结算（成功时带执行器
 *   的返回值），调用方可以像直接调用服务一样 await，多个并发 enqueue 自动排队。
 * - 暂停语义：当前任务继续跑完，之后不再开始下一个排队项；继续后接着执行。
 *   （pnpm/git 安装无法断点续传，因此不做运行中任务的中断。）
 * - 持久化只保存待执行任务与暂停标记；done/failed/cancelled 仅驻留内存，
 *   重启时曾处于 running 的任务按 pending 恢复（其结果未知，重新执行）。
 */

/** 完成态条目在内存中的保留上限，超出后丢弃最旧的。 */
const MAX_FINISHED_ENTRIES = 50

export type InstallQueueExecutors = {
  [K in keyof InstallQueueJobInputs]: (payload: InstallQueueJobInputs[K]) => Promise<unknown>
}

export interface InstallQueueOptions {
  /** 持久化文件路径（userData/install-queue.json）。 */
  storePath: string
  executors: InstallQueueExecutors
  emitEvent: (snapshot: InstallQueueSnapshot) => void
  now?: () => Date
}

export interface InstallQueue {
  /** 登记一个任务并立即返回完成 Promise；多个并发 enqueue 自动串行。 */
  enqueue<K extends keyof InstallQueueJobInputs>(
    kind: K,
    label: string,
    payload: InstallQueueJobInputs[K],
  ): Promise<unknown>
  list(): InstallQueueSnapshot
  pause(): Promise<void>
  resume(): Promise<void>
  cancel(id: number): Promise<void>
  clearFinished(): Promise<void>
  /** 是否有待执行或执行中的任务；用于跨服务的「安装期间」互斥判断。 */
  hasWork(): boolean
  /** 持久化状态恢复完成（list() 之前调用可保证看到恢复结果）。 */
  whenReady(): Promise<void>
  /** 等待所有已排队的落盘写完成（测试与优雅退出用）。 */
  flush(): Promise<void>
  /** 装配完成后调用一次：恢复持久化的待执行任务并开始执行。 */
  start(): void
}

interface QueueWaiter {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface PersistedPayloadEntry {
  id: number
  kind: InstallQueueKind
  label: string
  payload: unknown
}

export function createInstallQueue(options: InstallQueueOptions): InstallQueue {
  const executors = options.executors
  const now = options.now ?? (() => new Date())

  let entries: InstallQueueEntry[] = []
  const payloads = new Map<number, unknown>()
  const waiters = new Map<number, QueueWaiter>()
  let paused = false
  let runningId: number | null = null
  let nextId = 1
  let started = false

  const runningEntry = (): InstallQueueEntry | null => entries.find(entry => entry.id === runningId) ?? null

  function emit(): void {
    options.emitEvent({ paused, entries: entries.map(entry => ({ ...entry })) })
  }

  // 持久化串行链：每次调用先同步快照当前状态，再排队写入，
  // 保证多次快速变更后磁盘上的最终内容是最后一次快照。
  let persistChain: Promise<void> = Promise.resolve()
  function persist(): Promise<void> {
    const pendingPayloads: PersistedPayloadEntry[] = []
    for (const entry of entries) {
      if (entry.state !== 'pending' && entry.state !== 'running') continue
      const payload = payloads.get(entry.id)
      if (payload === undefined) continue
      // running 保存为 pending：重启时其结果未知，重新执行。
      pendingPayloads.push({ id: entry.id, kind: entry.kind, label: entry.label, payload })
    }
    const content = `${JSON.stringify({ version: 1, paused, entries: pendingPayloads }, null, 2)}\n`
    const temporary = `${options.storePath}.${process.pid}.${Date.now()}.${persistSequence += 1}.tmp`
    const run = async (): Promise<void> => {
      await mkdir(path.dirname(options.storePath), { recursive: true })
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, options.storePath)
    }
    const result = persistChain.then(run, run)
    persistChain = result.then(() => undefined, () => undefined)
    return result.catch(error => {
      void rm(temporary, { force: true }).catch(() => undefined)
      throw error
    })
  }
  let persistSequence = 0

  async function restore(): Promise<void> {
    let stored: { paused?: unknown; entries?: unknown } | null = null
    try {
      stored = JSON.parse(await readFile(options.storePath, 'utf8')) as { paused?: unknown; entries?: unknown } | null
    } catch {
      return
    }
    if (!stored || typeof stored !== 'object') return
    paused = stored.paused === true
    const storedEntries = Array.isArray(stored.entries) ? stored.entries : []
    for (const raw of storedEntries) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Partial<PersistedPayloadEntry>
      if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0) continue
      if (typeof item.label !== 'string' || !isQueueKind(item.kind)) continue
      if (item.payload === undefined) continue
      if (entries.some(entry => entry.id === item.id)) continue
      entries.push({
        id: item.id,
        kind: item.kind,
        label: item.label,
        state: 'pending',
        enqueuedAt: now().toISOString(),
        startedAt: null,
        finishedAt: null,
        error: null,
      })
      payloads.set(item.id, item.payload)
      nextId = Math.max(nextId, item.id + 1)
    }
  }

  function isQueueKind(value: unknown): value is InstallQueueKind {
    return value === 'dsh' || value === 'node' || value === 'plugin' || value === 'skill'
      || value === 'preset' || value === 'application' || value === 'pack-create'
      || value === 'pack-import' || value === 'dsh-market'
  }

  function trimFinished(): void {
    const finished = entries.filter(entry => entry.state === 'done' || entry.state === 'failed' || entry.state === 'cancelled')
    if (finished.length <= MAX_FINISHED_ENTRIES) return
    const removable = new Set(finished.slice(0, finished.length - MAX_FINISHED_ENTRIES).map(entry => entry.id))
    entries = entries.filter(entry => !removable.has(entry.id))
  }

  async function execute(entry: InstallQueueEntry): Promise<void> {
    const payload = payloads.get(entry.id)
    const executor = executors[entry.kind] as ((input: unknown) => Promise<unknown>) | undefined
    const waiter = waiters.get(entry.id)
    try {
      if (!executor || payload === undefined) throw new Error(`下载队列任务「${entry.label}」缺少可用的执行器。`)
      const result = await executor(payload)
      entry.state = 'done'
      entry.finishedAt = now().toISOString()
      waiter?.resolve(result)
    } catch (error) {
      entry.state = 'failed'
      entry.finishedAt = now().toISOString()
      entry.error = error instanceof Error ? error.message : String(error)
      waiter?.reject(error)
    } finally {
      runningId = null
      waiters.delete(entry.id)
      payloads.delete(entry.id)
      trimFinished()
      void persist().catch(() => undefined)
      emit()
      pump()
    }
  }

  function pump(): void {
    if (runningId !== null || paused || !started) return
    const next = entries.find(entry => entry.state === 'pending')
    if (!next) return
    next.state = 'running'
    next.startedAt = now().toISOString()
    runningId = next.id
    void persist().catch(() => undefined)
    emit()
    void execute(next)
  }

  const ready = restore().then(() => emit())

  return {
    async enqueue(kind, label, payload) {
      await ready
      const entry: InstallQueueEntry = {
        id: nextId,
        kind,
        label,
        state: 'pending',
        enqueuedAt: now().toISOString(),
        startedAt: null,
        finishedAt: null,
        error: null,
      }
      nextId += 1
      entries.push(entry)
      payloads.set(entry.id, payload)
      const settled = new Promise<unknown>((resolve, reject) => {
        waiters.set(entry.id, { resolve, reject })
      })
      void persist().catch(() => undefined)
      emit()
      pump()
      return settled
    },

    list() {
      return { paused, entries: entries.map(entry => ({ ...entry })) }
    },

    pause() {
      paused = true
      emit()
      return persist()
    },

    resume() {
      paused = false
      emit()
      pump()
      return persist()
    },

    async cancel(id) {
      const entry = entries.find(candidate => candidate.id === id)
      if (!entry) throw new Error('队列中不存在该任务。')
      if (entry.state !== 'pending') throw new Error('该任务正在执行或已结束，无法取消。')
      entry.state = 'cancelled'
      entry.finishedAt = now().toISOString()
      payloads.delete(id)
      trimFinished()
      emit()
      // 让等待中的调用方拿到取消错误（Promise 无 waiter 时为空操作）。
      waiters.get(id)?.reject(new Error('任务已取消。'))
      waiters.delete(id)
      await persist()
    },

    clearFinished() {
      entries = entries.filter(entry => entry.state === 'pending' || entry.state === 'running')
      emit()
      return persist()
    },

    hasWork() {
      return entries.some(entry => entry.state === 'pending' || entry.state === 'running')
    },

    whenReady() {
      return ready
    },

    flush() {
      return persistChain
    },

    start() {
      if (started) return
      started = true
      void ready.then(() => {
        emit()
        pump()
      })
    },
  }
}
