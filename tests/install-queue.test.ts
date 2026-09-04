import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInstallQueue, type InstallQueueExecutors } from '../electron/install-queue'
import type { InstallQueueSnapshot } from '../src/types'

const tempRoots: string[] = []

afterEach(async () => {
  // 等待 fire-and-forget 的落盘写完再清理临时目录。
  await new Promise(resolve => setTimeout(resolve, 120))
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempStorePath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-launcher-queue-'))
  tempRoots.push(root)
  return path.join(root, 'install-queue.json')
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(resolveFn => { resolve = resolveFn })
  return { promise, resolve }
}

const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 轮询等待队列持久化文件达到预期内容（fs 慢于微任务时兜底）。 */
async function waitForStore(storePath: string, check: (data: { paused: unknown; entries: unknown[] }) => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let data: { paused: unknown; entries: unknown[] } | null = null
    try {
      data = JSON.parse(await readFile(storePath, 'utf8')) as typeof data
    } catch {
      // 文件尚未写出，继续等待。
    }
    if (data && check(data)) return
    if (Date.now() > deadline) throw new Error('队列持久化内容未按时就绪')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function baseExecutors(overrides: Partial<InstallQueueExecutors> = {}): InstallQueueExecutors {
  return {
    dsh: async () => undefined,
    node: async () => undefined,
    plugin: async () => undefined,
    skill: async () => undefined,
    preset: async () => undefined,
    application: async () => undefined,
    'pack-create': async () => undefined,
    'pack-import': async () => undefined,
    'dsh-market': async () => undefined,
    ...overrides,
  }
}

describe('install queue', () => {
  it('runs enqueued jobs strictly serially and settles the enqueue promise with the executor result', async () => {
    const storePath = await tempStorePath()
    const gate = deferred()
    const calls: string[] = []
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors({
        plugin: async payload => {
          calls.push(`start:${String(payload)}`)
          await gate.promise
          calls.push(`end:${String(payload)}`)
          return `done:${String(payload)}`
        },
      }),
      emitEvent: () => undefined,
    })
    queue.start()
    const first = queue.enqueue('plugin', '插件 A', 'A')
    const second = queue.enqueue('plugin', '插件 B', 'B')
    await tick()
    expect(calls).toEqual(['start:A'])
    gate.resolve()
    expect(await first).toBe('done:A')
    expect(await second).toBe('done:B')
    await tick()
    expect(calls).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
    expect(queue.hasWork()).toBe(false)
  })

  it('pause stops the next job from starting and resume continues', async () => {
    const storePath = await tempStorePath()
    const gate = deferred()
    const calls: string[] = []
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors({
        dsh: async version => {
          calls.push(`start:${version}`)
          await gate.promise
        },
      }),
      emitEvent: () => undefined,
    })
    queue.start()
    void queue.enqueue('dsh', '下载 DSH v1', 'v1')
    void queue.enqueue('dsh', '下载 DSH v2', 'v2')
    await tick()
    expect(calls).toEqual(['start:v1'])

    queue.pause()
    gate.resolve()
    await tick()
    // 当前任务已结束，但暂停中的队列不开始下一个。
    expect(calls).toEqual(['start:v1'])
    expect(queue.list().paused).toBe(true)
    expect(queue.list().entries.find(entry => entry.label === '下载 DSH v2')?.state).toBe('pending')

    queue.resume()
    await tick()
    expect(calls).toEqual(['start:v1', 'start:v2'])
  })

  it('cancels only pending jobs', async () => {
    const storePath = await tempStorePath()
    const calls: string[] = []
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors({ skill: async () => { calls.push('ran') } }),
      emitEvent: () => undefined,
    })
    const pending = queue.enqueue('skill', '安装 Skill a/b', { repository: 'a/b', defaultBranch: 'main', targetId: 't' })
    await tick()
    const entry = queue.list().entries[0]
    expect(entry.state).toBe('pending')
    queue.cancel(entry.id)
    await expect(pending).rejects.toThrow('任务已取消')
    expect(queue.list().entries[0].state).toBe('cancelled')
    await tick()
    expect(calls).toEqual([])
    await expect(queue.cancel(entry.id)).rejects.toThrow('无法取消')
  })

  it('a failing job marks the entry failed and the queue continues with the next', async () => {
    const storePath = await tempStorePath()
    const calls: string[] = []
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors({
        preset: async request => {
          if (request.name === 'bad') throw new Error('预设源不可用')
          calls.push(request.name)
          return request.name
        },
      }),
      emitEvent: () => undefined,
    })
    queue.start()
    const bad = queue.enqueue('preset', '安装预设 bad', { repository: 'a/b', targetId: 't', name: 'bad', sourcePath: 'preset/bad', revision: 'a'.repeat(40) })
    const good = queue.enqueue('preset', '安装预设 good', { repository: 'c/d', targetId: 't', name: 'good', sourcePath: 'preset/good', revision: 'b'.repeat(40) })
    await expect(bad).rejects.toThrow('预设源不可用')
    expect(await good).toBe('good')
    const snapshot = queue.list()
    expect(snapshot.entries.find(entry => entry.label === '安装预设 bad')?.state).toBe('failed')
    expect(snapshot.entries.find(entry => entry.label === '安装预设 good')?.state).toBe('done')
  })

  it('persists pending entries and the paused flag, restoring them as pending on a fresh queue', async () => {
    const storePath = await tempStorePath()
    const hold = deferred()
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors({ dsh: async () => { await hold.promise } }),
      emitEvent: () => undefined,
    })
    queue.start()
    void queue.enqueue('dsh', '下载 DSH v1', 'v1')
    void queue.enqueue('dsh', '下载 DSH v2', 'v2')
    // pause 的落盘完成后，两个任务的快照一定已按序写入。
    await queue.pause()
    // fs 在并行测试负载下较慢：轮询等待文件内容达到预期，避免读到中间状态。
    await waitForStore(storePath, data => data.paused === true && Array.isArray(data.entries) && data.entries.length === 2)

    const persisted = JSON.parse(await readFile(storePath, 'utf8')) as { paused: boolean; entries: Array<{ label: string; state: string }> }
    expect(persisted.paused).toBe(true)
    expect(persisted.entries.map(entry => entry.label)).toEqual(['下载 DSH v1', '下载 DSH v2'])

    hold.resolve()
    const runs: string[] = []
    const restored = createInstallQueue({
      storePath,
      executors: baseExecutors({ dsh: async version => { runs.push(version) } }),
      emitEvent: () => undefined,
    })
    await restored.whenReady()
    expect(restored.list().paused).toBe(true)
    expect(restored.list().entries.map(entry => entry.state)).toEqual(['pending', 'pending'])
    restored.start()
    await tick()
    // 恢复时保持暂停状态，需要显式继续。
    expect(runs).toEqual([])
    restored.resume()
    await tick()
    expect(runs).toEqual(['v1', 'v2'])
    expect(restored.list().paused).toBe(false)
  })

  it('emits a snapshot on every state change', async () => {
    const storePath = await tempStorePath()
    const snapshots: InstallQueueSnapshot[] = []
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors(),
      emitEvent: snapshot => snapshots.push(snapshot),
    })
    queue.start()
    await queue.enqueue('node', '下载 Node.js v20', 'v20')
    await tick()
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    const last = snapshots.at(-1)!
    expect(last.entries[0]?.state).toBe('done')
    expect(last.paused).toBe(false)
  })

  it('keeps at most 50 finished entries in memory', async () => {
    const storePath = await tempStorePath()
    const queue = createInstallQueue({
      storePath,
      executors: baseExecutors(),
      emitEvent: () => undefined,
    })
    queue.start()
    const jobs: Array<Promise<unknown>> = []
    for (let index = 0; index < 60; index += 1) {
      jobs.push(queue.enqueue('dsh-market', `任务 ${index}`, { action: 'install', name: `p${index}` }))
    }
    await Promise.all(jobs)
    await queue.flush()
    await tick()
    expect(queue.list().entries.filter(entry => entry.state === 'done')).toHaveLength(50)
    expect(queue.list().entries.every(entry => entry.state === 'done')).toBe(true)
  })
})
