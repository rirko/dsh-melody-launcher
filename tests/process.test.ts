import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWindowsBatchCommand,
  formatCommandLine,
  findGitExecutable,
  isGitHostedSpecifier,
  isGitUnavailableOutput,
  spawnCommand,
  withExecutableDirectoryOnPath,
  withGitOnPath,
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

  it('finds Git from the child PATH and keeps it available to pnpm', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-git-runtime-'))
    const gitDirectory = path.join(temporaryDirectory, 'git', 'cmd')
    await mkdir(gitDirectory, { recursive: true })
    const executable = path.join(gitDirectory, process.platform === 'win32' ? 'git.exe' : 'git')
    await writeFile(executable, '', 'utf8')

    const environment = {
      PATH: gitDirectory,
      ProgramFiles: path.join(temporaryDirectory, 'program-files'),
      'ProgramFiles(x86)': path.join(temporaryDirectory, 'program-files-x86'),
      LOCALAPPDATA: path.join(temporaryDirectory, 'local-app-data'),
      USERPROFILE: path.join(temporaryDirectory, 'user'),
    }
    expect(findGitExecutable(environment)).toBe(path.resolve(executable))
    const withGit = withGitOnPath(environment)
    expect(withGit.PATH).toBe(gitDirectory)
    expect(withGit.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('classifies Git specs and missing-Git output without matching ordinary npm errors', () => {
    expect(isGitHostedSpecifier('github:owner/plugin#abc')).toBe(true)
    expect(isGitHostedSpecifier('https://github.com/owner/plugin.git#main')).toBe(true)
    expect(isGitHostedSpecifier('@scope/plugin@1.0.0')).toBe(false)
    expect(isGitUnavailableOutput("'git' is not recognized as an internal or external command")).toBe(true)
    expect(isGitUnavailableOutput('Command failed with exit code 1: git -c "core.longpaths=true" init\n\n\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD')).toBe(true)
    expect(isGitUnavailableOutput('ERR_PNPM_FETCH_404 package not found')).toBe(false)
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
