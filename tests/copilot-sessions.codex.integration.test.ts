import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AppSettings } from '../src/types'

/**
 * Keep this test at the manager boundary.  The app-server client tests prove
 * JSON-RPC framing in isolation, but a regression in `ensureAgent` or the
 * manager request callback can still leave a real Copilot session blocked.
 */
const processMocks = vi.hoisted(() => ({
  spawnCommand: vi.fn(),
}))

vi.mock('../electron/process', async () => {
  const actual = await vi.importActual<typeof import('../electron/process')>('../electron/process')
  return { ...actual, spawnCommand: processMocks.spawnCommand }
})

import { createCopilotSessionManager } from '../electron/copilot-sessions'

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function fakeChild(onClientMessage: (message: Record<string, unknown>) => void): FakeChild {
  const child = new EventEmitter() as FakeChild
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let buffer = ''
  stdin.on('data', chunk => {
    buffer += chunk.toString('utf8')
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      onClientMessage(JSON.parse(line) as Record<string, unknown>)
    }
  })
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    // Mark the in-memory process as already exited so manager shutdown never
    // invokes a platform task-killer against a fabricated PID.
    pid: undefined,
    exitCode: 0,
    signalCode: null,
    kill: vi.fn(() => true),
  })
  return child
}

function writeServerMessage(child: FakeChild, message: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(new Error('manager integration condition timed out'))
      }
    }, 5)
  })
}

describe('Copilot manager Codex App Server integration', () => {
  it('answers a legal server request, survives a failed request, and receives turn/completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-codex-manager-'))
    const sentByManager: Array<Record<string, unknown>> = []
    const emitted: Array<{ kind: string; session?: { phase?: string; messages?: Array<{ text: string }> } }> = []
    let child!: FakeChild
    let turnNumber = 0
    let settingsReads = 0
    let rejectSettingsDuringOptionalRequest = false

    child = fakeChild(message => {
      sentByManager.push(message)
      const id = message.id
      switch (message.method) {
        case 'initialize':
          writeServerMessage(child, { id, result: { userAgent: 'fixture-codex' } })
          break
        case 'thread/start':
          writeServerMessage(child, { id, result: { thread: { id: 'thread-fixture' } } })
          break
        case 'turn/start': {
          turnNumber += 1
          const turnId = `turn-fixture-${turnNumber}`
          writeServerMessage(child, { id, result: { turn: { id: turnId } } })
          // Let the manager install its turn waiter before notifications are
          // delivered.  The first turn exercises both a valid optional
          // request and an unknown request that must become an explicit error.
          const sendTurnEvents = () => {
            if (turnNumber === 1) {
              // The fallback path must not call readSettings.  Make such a
              // call fail so this integration test catches regressions.
              rejectSettingsDuringOptionalRequest = true
              writeServerMessage(child, {
                id: 501,
                method: 'item/tool/requestUserInput',
                params: { threadId: 'thread-fixture', turnId, questions: [] },
              })
              writeServerMessage(child, {
                id: 502,
                method: 'future/unsupportedRequest',
                params: { threadId: 'thread-fixture', turnId },
              })
            }
            if (turnNumber === 1) {
              writeServerMessage(child, {
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-fixture', turnId, delta: `turn ${turnNumber} completed` },
              })
            } else {
              // The completed item is authoritative and may be the only text
              // event emitted by an App Server implementation.
              writeServerMessage(child, {
                method: 'item/completed',
                params: {
                  threadId: 'thread-fixture',
                  turnId,
                  item: { type: 'agentMessage', id: `message-${turnNumber}`, text: `turn ${turnNumber} completed`, phase: 'final_answer' },
                },
              })
            }
            writeServerMessage(child, {
              method: 'turn/completed',
              // Exercise the older app-server shape on the second turn: some
              // builds put status at params.status and omit turn.id.  The
              // manager must still finish the active waiter.
              params: turnNumber === 2
                ? { threadId: 'thread-fixture', status: 'completed' }
                : { threadId: 'thread-fixture', turn: { id: turnId, status: 'completed' } },
            })
          }
          sendTurnEvents()
          break
        }
        default:
          // `initialized` and responses do not need a fixture response.
          break
      }
    })
    processMocks.spawnCommand.mockReturnValue(child)

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => {
        settingsReads += 1
        if (rejectSettingsDuringOptionalRequest) {
          rejectSettingsDuringOptionalRequest = false
          throw new Error('settings read intentionally unavailable')
        }
        return settings
      },
      readApiKey: async () => null,
      prepareNodeRuntime: async () => { throw new Error('not used for Codex backend') },
      preparePnpmRuntime: async () => { throw new Error('not used for Codex backend') },
      emitEvent: event => {
        if (event.kind === 'session-updated') {
          emitted.push({ kind: event.kind, session: event.session })
        }
      },
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
      codexExecutable: 'fixture-codex',
    })

    try {
      const session = await manager.create({ backend: 'codex', title: 'manager fixture' })
      await manager.send(session.id, 'first prompt')
      await waitFor(() => emitted.some(event => event.session?.phase === 'done'))

      // The optional request was emitted after the turn had started.  Its
      // fallback must not add another settings read (the exact number of
      // ordinary reads is an implementation detail).
      expect(settingsReads).toBe(2)
      // Keep the second-turn setup independent if an implementation under
      // test did not issue the guarded read at all (the expected behavior).
      rejectSettingsDuringOptionalRequest = false
      expect(sentByManager).toContainEqual({ id: 501, result: { answers: {} } })
      expect(sentByManager).toContainEqual({
        id: 502,
        error: { code: -32000, message: 'DSH Launcher 未实现 Codex 请求：future/unsupportedRequest' },
      })
      const firstDone = emitted.find(event => event.session?.phase === 'done')?.session
      expect(firstDone?.messages?.some(message => message.text.includes('turn 1 completed'))).toBe(true)

      // A second prompt must reuse the same live transport.  If the failed
      // request closed the app-server connection, this send would end in an
      // initialization/turn error instead of another completed turn.
      await manager.send(session.id, 'second prompt')
      await waitFor(() => emitted.some(event => event.session?.messages?.some(message => message.text.includes('turn 2 completed'))))
      expect(processMocks.spawnCommand).toHaveBeenCalledTimes(1)
      const finalDone = emitted.filter(event => event.session?.phase === 'done').at(-1)?.session
      expect(finalDone?.messages?.some(message => message.text.includes('turn 2 completed'))).toBe(true)
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
      processMocks.spawnCommand.mockReset()
    }
  })

  it('associates terminal notifications that arrive before turn/start response', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-codex-early-terminal-'))
    const emitted: Array<{ session?: { id?: string; phase?: string; messages?: Array<{ text: string }> } }> = []
    let child!: FakeChild
    let turnNumber = 0

    child = fakeChild(message => {
      const id = message.id
      switch (message.method) {
        case 'initialize':
          writeServerMessage(child, { id, result: { userAgent: 'fixture-codex' } })
          break
        case 'thread/start':
          writeServerMessage(child, { id, result: { thread: { id: 'thread-early' } } })
          break
        case 'turn/start': {
          turnNumber += 1
          const turnId = `turn-early-${turnNumber}`
          // Deliberately put the terminal notification before the response to
          // turn/start.  App Server can flush both frames in one write, and a
          // client that only installs its waiter after the response loses the
          // notification and appears to stop after its first tool call.
          if (turnNumber === 1) {
            writeServerMessage(child, {
              method: 'turn/completed',
              params: { threadId: 'thread-early', turn: { id: turnId, status: 'completed' } },
            })
          } else {
            writeServerMessage(child, {
              method: 'error',
              params: { threadId: 'thread-early', turnId, status: 'failed', message: 'early turn failure' },
            })
          }
          writeServerMessage(child, { id, result: { turn: { id: turnId } } })
          break
        }
        default:
          break
      }
    })
    processMocks.spawnCommand.mockReturnValue(child)

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => settings,
      readApiKey: async () => null,
      prepareNodeRuntime: async () => { throw new Error('not used for Codex backend') },
      preparePnpmRuntime: async () => { throw new Error('not used for Codex backend') },
      emitEvent: event => {
        if (event.kind === 'session-updated') emitted.push(event)
      },
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
      codexExecutable: 'fixture-codex',
    })

    try {
      const session = await manager.create({ backend: 'codex', title: 'early terminal fixture' })
      await manager.send(session.id, 'first prompt')
      await waitFor(() => emitted.some(event => event.session?.phase === 'done'))
      expect(emitted.filter(event => event.session?.phase === 'error')).toHaveLength(0)

      await manager.send(session.id, 'second prompt')
      await waitFor(() => emitted.some(event => event.session?.phase === 'error'))
      const failed = emitted.filter(event => event.session?.phase === 'error').at(-1)?.session
      expect(failed?.messages?.some(message => message.text.includes('early turn failure'))).toBe(true)
      expect(processMocks.spawnCommand).toHaveBeenCalledTimes(1)
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
      processMocks.spawnCommand.mockReset()
    }
  })

  it('finishes when turn/start itself returns a terminal turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-codex-terminal-response-'))
    const emitted: Array<{ session?: { phase?: string; messages?: Array<{ text: string }> } }> = []
    let child!: FakeChild

    child = fakeChild(message => {
      const id = message.id
      switch (message.method) {
        case 'initialize':
          writeServerMessage(child, { id, result: { userAgent: 'fixture-codex' } })
          break
        case 'thread/start':
          writeServerMessage(child, { id, result: { thread: { id: 'thread-terminal' } } })
          break
        case 'turn/start':
          // Immediate failures/validation errors can be represented in the
          // response without a follow-up turn/completed notification.
          writeServerMessage(child, {
            id,
            result: {
              turn: {
                id: 'turn-terminal',
                status: 'failed',
                error: { message: 'terminal response failure' },
              },
            },
          })
          break
        default:
          break
      }
    })
    processMocks.spawnCommand.mockReturnValue(child)

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => settings,
      readApiKey: async () => null,
      prepareNodeRuntime: async () => { throw new Error('not used for Codex backend') },
      preparePnpmRuntime: async () => { throw new Error('not used for Codex backend') },
      emitEvent: event => {
        if (event.kind === 'session-updated') emitted.push(event)
      },
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
      codexExecutable: 'fixture-codex',
    })

    try {
      const session = await manager.create({ backend: 'codex', title: 'terminal response fixture' })
      await manager.send(session.id, 'trigger terminal response')
      await waitFor(() => emitted.some(event => event.session?.phase === 'error'))
      const failed = emitted.filter(event => event.session?.phase === 'error').at(-1)?.session
      expect(failed?.messages?.some(message => message.text.includes('terminal response failure'))).toBe(true)
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
      processMocks.spawnCommand.mockReset()
    }
  })

  it('marks an in-flight turn as an error when Codex exits with code zero', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-codex-exit-zero-'))
    const emitted: Array<{ session?: { phase?: string; messages?: Array<{ text: string }> } }> = []
    let child!: FakeChild

    child = fakeChild(message => {
      const id = message.id
      if (message.method === 'initialize') {
        writeServerMessage(child, { id, result: {} })
      } else if (message.method === 'thread/start') {
        writeServerMessage(child, { id, result: { thread: { id: 'thread-exit-zero' } } })
      } else if (message.method === 'turn/start') {
        writeServerMessage(child, { id, result: { turn: { id: 'turn-exit-zero' } } })
        setTimeout(() => {
          child.stdout.end()
          child.emit('exit', 0)
        }, 0)
      }
    })
    processMocks.spawnCommand.mockReturnValue(child)

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => settings,
      readApiKey: async () => null,
      prepareNodeRuntime: async () => { throw new Error('not used for Codex backend') },
      preparePnpmRuntime: async () => { throw new Error('not used for Codex backend') },
      emitEvent: event => {
        if (event.kind === 'session-updated') emitted.push(event)
      },
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
      codexExecutable: 'fixture-codex',
    })

    try {
      const session = await manager.create({ backend: 'codex', title: 'exit zero fixture' })
      await manager.send(session.id, 'trigger exit')
      await waitFor(() => emitted.some(event => event.session?.phase === 'error'))
      const failed = emitted.filter(event => event.session?.phase === 'error').at(-1)?.session
      expect(failed?.messages?.some(message => message.text.includes('Codex App Server 连接已关闭'))).toBe(true)
      expect(failed?.phase).toBe('error')
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
      processMocks.spawnCommand.mockReset()
    }
  })

  it('closes an agent created after cancellation during startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-codex-cancel-start-'))
    let child!: FakeChild
    let resolveSettings!: (settings: AppSettings) => void
    const settingsReady = new Promise<AppSettings>(resolve => { resolveSettings = resolve })
    let settingsReads = 0

    child = fakeChild(message => {
      const id = message.id
      if (message.method === 'initialize') writeServerMessage(child, { id, result: {} })
      else if (message.method === 'thread/start') writeServerMessage(child, { id, result: { thread: { id: 'thread-cancel-start' } } })
    })
    processMocks.spawnCommand.mockReturnValue(child)

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => {
        settingsReads += 1
        if (settingsReads === 1) return settingsReady
        return settings
      },
      readApiKey: async () => null,
      prepareNodeRuntime: async () => { throw new Error('not used for Codex backend') },
      preparePnpmRuntime: async () => { throw new Error('not used for Codex backend') },
      emitEvent: () => undefined,
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
      codexExecutable: 'fixture-codex',
    })

    try {
      const session = await manager.create({ backend: 'codex', title: 'cancel startup fixture' })
      await manager.send(session.id, 'cancel while starting')
      await waitFor(() => settingsReads === 1)

      // At this point ensureAgent is waiting before it has spawned the child,
      // so cancel() cannot find an agent to stop yet.
      await manager.cancel(session.id)
      resolveSettings(settings)
      await waitFor(() => child.stdin.writableEnded)
      expect(child.stdin.writableEnded).toBe(true)
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
      processMocks.spawnCommand.mockReset()
    }
  })

  it('拒绝现代 file-change 请求中的越界实际变更路径', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-copilot-codex-file-change-'))
    const sent: Array<Record<string, unknown>> = []
    const emitted: Array<{ session?: { phase?: string; pendingApproval?: unknown } }> = []
    let child!: FakeChild
    let completed = false

    child = fakeChild(message => {
      sent.push(message)
      const id = message.id
      if (message.method === 'initialize') {
        writeServerMessage(child, { id, result: {} })
      } else if (message.method === 'thread/start') {
        writeServerMessage(child, { id, result: { thread: { id: 'thread-file-change' } } })
      } else if (message.method === 'turn/start') {
        const turnId = 'turn-file-change'
        writeServerMessage(child, { id, result: { turn: { id: turnId } } })
        // The modern approval payload intentionally omits fileChanges and
        // grantRoot.  The manager must use the item/started proposal instead.
        setTimeout(() => {
          writeServerMessage(child, {
            method: 'item/started',
            params: {
              threadId: 'thread-file-change',
              turnId,
              item: {
                id: 'file-change-1',
                type: 'fileChange',
                changes: [{ path: path.join(root, '..', 'outside.txt'), kind: { type: 'add' }, diff: '+ outside' }],
                status: 'inProgress',
              },
            },
          })
          writeServerMessage(child, {
            id: 710,
            method: 'item/fileChange/requestApproval',
            params: {
              threadId: 'thread-file-change',
              turnId,
              itemId: 'file-change-1',
              reason: 'write outside workspace',
            },
          })
        }, 0)
      } else if (message.id === 710 && message.result) {
        completed = true
        writeServerMessage(child, {
          method: 'turn/completed',
          params: { threadId: 'thread-file-change', turn: { id: 'turn-file-change', status: 'completed' } },
        })
      }
    })
    processMocks.spawnCommand.mockReturnValue(child)

    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => settings,
      readApiKey: async () => null,
      prepareNodeRuntime: async () => { throw new Error('not used for Codex backend') },
      preparePnpmRuntime: async () => { throw new Error('not used for Codex backend') },
      emitEvent: event => {
        if (event.kind === 'session-updated') emitted.push(event)
      },
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
      codexExecutable: 'fixture-codex',
    })

    try {
      const session = await manager.create({ backend: 'codex', title: 'file-change fixture' })
      await manager.send(session.id, 'reject an unsafe patch')
      await waitFor(() => completed)
      await waitFor(() => emitted.some(event => event.session?.phase === 'done'))
      expect(sent).toContainEqual({ id: 710, result: { decision: 'decline' } })
      expect(emitted.some(event => event.session?.pendingApproval)).toBe(false)
    } finally {
      await manager.shutdown()
      await rm(root, { recursive: true, force: true })
      processMocks.spawnCommand.mockReset()
    }
  })
})
