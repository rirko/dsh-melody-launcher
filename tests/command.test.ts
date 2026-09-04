import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectCommandOutput, runCommand, type CommandProcess } from '../electron/command'

afterEach(() => {
  vi.useRealTimers()
})

/** 一个只实现 collectCommandOutput 所需接口的子进程替身。 */
function fakeProcess() {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = {
    stdout,
    stderr,
    once: (event: string, listener: (...args: any[]) => void) => emitter.once(event, listener),
  } as unknown as CommandProcess
  return { child, stdout, stderr, emitter }
}

describe('collectCommandOutput', () => {
  it('merges stdout and stderr in arrival order and reports the exit code', async () => {
    const { child, stdout, stderr, emitter } = fakeProcess()
    const pending = collectCommandOutput(child)

    stdout.write('hello ')
    stderr.write('warning ')
    stdout.write('world')
    emitter.emit('exit', 0)

    await expect(pending).resolves.toEqual({ exitCode: 0, output: 'hello warning world' })
  })

  it('forwards each chunk with its stream level', async () => {
    const { child, stdout, stderr, emitter } = fakeProcess()
    const seen: Array<[string, string]> = []
    const pending = collectCommandOutput(child, { onOutput: (text, level) => seen.push([level, text]) })

    stdout.write('out')
    stderr.write('err')
    emitter.emit('exit', 0)
    await pending

    expect(seen).toEqual([['info', 'out'], ['error', 'err']])
  })

  it('keeps only the tail of the output once the capture limit is reached', async () => {
    const { child, stdout, emitter } = fakeProcess()
    const pending = collectCommandOutput(child, { captureLimit: 5 })

    stdout.write('abcdefgh')
    emitter.emit('exit', 0)

    await expect(pending).resolves.toEqual({ exitCode: 0, output: 'defgh' })
  })

  it('treats a null exit code as a failure', async () => {
    const { child, emitter } = fakeProcess()
    const pending = collectCommandOutput(child)
    emitter.emit('exit', null)
    await expect(pending).resolves.toMatchObject({ exitCode: 1 })
  })

  it('rejects when the process fails to start', async () => {
    const { child, emitter } = fakeProcess()
    const pending = collectCommandOutput(child)
    emitter.emit('error', new Error('ENOENT'))
    await expect(pending).rejects.toThrow('ENOENT')
  })

  it('terminates and rejects a command that produces no output for too long', async () => {
    vi.useFakeTimers()
    const { child, emitter } = fakeProcess()
    const seen: number[] = []
    const pending = collectCommandOutput(child, {
      inactivityTimeoutMs: 1_000,
      onTimeout: timeoutMs => seen.push(timeoutMs),
    })
    const rejection = expect(pending).rejects.toThrow('没有输出')

    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
    expect(seen).toEqual([1_000])
    // A late exit event from taskkill must not turn the timeout into success.
    emitter.emit('exit', 0)
    await expect(pending).rejects.toThrow()
  })
})

describe('runCommand execution log', () => {
  it('records the command, output, working directory and exit code', async () => {
    const seen: Array<[string, string]> = []
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("command-ok")'], {
      cwd: process.cwd(),
      env: process.env,
      onOutput: (text, level) => seen.push([level, text]),
    })

    expect(result.exitCode).toBe(0)
    expect(seen.some(([level, text]) => level === 'info' && text.includes('命令：'))).toBe(true)
    expect(seen.some(([, text]) => text.includes('工作目录：'))).toBe(true)
    expect(seen.some(([, text]) => text.includes('command-ok'))).toBe(true)
    expect(seen.some(([level, text]) => level === 'info' && text.includes('命令退出：0'))).toBe(true)
  })
})

describe('runCommand timeout', () => {
  it('terminates a hung subprocess after the timeout and reports exitCode -1', async () => {
    const startedAt = Date.now()
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 500,
    })
    expect(result.exitCode).toBe(-1)
    expect(result.output).toContain('命令执行超时')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })
})
