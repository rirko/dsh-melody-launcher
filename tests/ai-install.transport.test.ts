import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createSpawnAcpTransport } from '../electron/ai-install'

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.assign(child, {
    // Keep the process in the "running" state so the transport's EOF path
    // exercises its process-tree cleanup guard without invoking taskkill in
    // tests that only verify protocol closure.
    pid: process.platform === 'win32' ? undefined : 1234,
    exitCode: 0,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  return child
}

describe('spawn ACP transport lifecycle', () => {
  it('notifies close exactly once and rejects writes after child exit', () => {
    const child = fakeChild()
    const transport = createSpawnAcpTransport(child, () => undefined)
    const errors: Array<Error | undefined> = []
    transport.onClose(error => errors.push(error))

    child.emit('exit', 1)
    child.emit('error', new Error('late error'))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('code 1')
    expect(() => transport.send('{}')).toThrow('ACP server 退出')

    // A subscriber attached after the process has exited must still observe
    // the terminal error; otherwise an ACP client created in that race can
    // remain apparently connected forever.
    const late: Array<Error | undefined> = []
    transport.onClose(error => late.push(error))
    expect(late).toHaveLength(1)
    expect(late[0]?.message).toContain('code 1')
  })

  it('treats stdout EOF as a terminal connection and closes idempotently', () => {
    const child = fakeChild()
    const transport = createSpawnAcpTransport(child, () => undefined)
    const closed: Array<Error | undefined> = []
    transport.onClose(error => closed.push(error))

    child.stdout.end()
    transport.close()
    child.emit('exit', 0)

    expect(closed).toHaveLength(1)
    expect(closed[0]).toBeUndefined()
    expect(child.stdin.writableEnded).toBe(true)
  })
})
