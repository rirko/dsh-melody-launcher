import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { collectCommandOutput, runCommand, type CommandProcess } from '../electron/command'

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
