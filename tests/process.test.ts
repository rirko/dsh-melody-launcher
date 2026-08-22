import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWindowsBatchCommand,
  formatCommandLine,
  spawnCommand,
  withExecutableDirectoryOnPath,
} from '../electron/process'

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('Windows batch command launching', () => {
  it('formats a readable command line for execution logs', () => {
    expect(formatCommandLine('C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log("ok")', 'plain']))
      .toBe('"C:\\Program Files\\nodejs\\node.exe" -e "console.log(""ok"")" plain')
  })

  it('quotes the executable path and every argument', () => {
    expect(buildWindowsBatchCommand('C:\\Program Files\\nodejs\\npx.cmd', ['hello world', 'a&b']))
      .toBe('""C:\\Program Files\\nodejs\\npx.cmd" "hello world" "a&b""')
  })

  it('adds an absolute executable directory to PATH once', () => {
    const executableDirectory = path.resolve(temporaryDirectory || os.tmpdir(), 'runtime with spaces')
    const executable = path.join(executableDirectory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    const systemDirectory = path.resolve(temporaryDirectory || os.tmpdir(), 'system-bin')
    const first = withExecutableDirectoryOnPath(executable, { PATH: systemDirectory })
    const second = withExecutableDirectoryOnPath(executable, first)

    expect(first.PATH).toBe(`${executableDirectory}${path.delimiter}${systemDirectory}`)
    expect(second.PATH).toBe(first.PATH)
  })

  it.skipIf(process.platform !== 'win32')('runs a batch file from a spaced path without losing arguments', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh launcher command '))
    const scriptPath = path.join(temporaryDirectory, 'print-args.cjs')
    const commandPath = path.join(temporaryDirectory, 'print args.cmd')
    await writeFile(scriptPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
    await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0print-args.cjs" %*\r\n`, 'utf8')

    const child = spawnCommand(commandPath, ['hello world', 'plain', 'a&b', 'say "hi"'], {
      cwd: temporaryDirectory,
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual(['hello world', 'plain', 'a&b', 'say "hi"'])
  })
})
