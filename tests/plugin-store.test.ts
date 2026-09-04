import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPnpmStorePruner } from '../electron/plugin-store'
import type { AppSettings } from '../src/types'

const settings = { dshHome: 'C:/Users/test/.dsh' } as AppSettings

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

function makePruner(storeRoot: string, runCommand: Parameters<typeof createPnpmStorePruner>[0]['runCommand']) {
  const prepareNodeRuntime = vi.fn(async () => ({
    root: path.join(storeRoot, 'node'),
    node: path.join(storeRoot, 'node', 'node.exe'),
    npm: path.join(storeRoot, 'node', 'npm.cmd'),
    npx: path.join(storeRoot, 'node', 'npx.cmd'),
    managed: true,
  }))
  const preparePnpmRuntime = vi.fn(async (_nodeRuntime: ReturnType<typeof prepareNodeRuntime> extends Promise<infer T> ? T : never) => ({
    root: path.join(storeRoot, 'pnpm'),
    executable: path.join(storeRoot, 'pnpm', 'pnpm.cmd'),
  }))
  const emitOutput = vi.fn()
  const pruner = createPnpmStorePruner({
    storeRoot,
    readSettings: async () => settings,
    prepareNodeRuntime,
    preparePnpmRuntime,
    resolveNodeRuntime: async () => prepareNodeRuntime(),
    resolvePnpmRuntime: async nodeRuntime => preparePnpmRuntime(nodeRuntime),
    emitOutput,
    runCommand,
  })
  return { pruner, prepareNodeRuntime, preparePnpmRuntime, emitOutput }
}

describe('pnpm store purge', () => {
  it('does nothing when the launcher store does not exist', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-store-prune-'))
    const storeRoot = path.join(temporaryDirectory, 'missing-store')
    const runCommand = vi.fn()
    const { pruner, prepareNodeRuntime, preparePnpmRuntime } = makePruner(storeRoot, runCommand)

    await pruner(storeRoot)

    expect(runCommand).not.toHaveBeenCalled()
    expect(prepareNodeRuntime).not.toHaveBeenCalled()
    expect(preparePnpmRuntime).not.toHaveBeenCalled()
  })

  it('rejects a path outside the configured launcher store', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-store-prune-'))
    const storeRoot = path.join(temporaryDirectory, 'store')
    await mkdir(storeRoot, { recursive: true })
    const runCommand = vi.fn()
    const { pruner } = makePruner(storeRoot, runCommand)

    await expect(pruner(path.join(temporaryDirectory, 'other'))).rejects.toThrow('拒绝清理')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('runs bundled pnpm store prune with an isolated offline cache', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-store-prune-'))
    const storeRoot = path.join(temporaryDirectory, 'store')
    await mkdir(storeRoot, { recursive: true })
    const runCommand = vi.fn(async (_executable, _args, commandOptions) => {
      commandOptions.onOutput?.('Removed 2 files (1 KiB)\n', 'info')
      return { exitCode: 0, output: 'Removed 2 files (1 KiB)' }
    })
    const { pruner, emitOutput } = makePruner(storeRoot, runCommand)

    await pruner(storeRoot)

    expect(runCommand).toHaveBeenCalledTimes(1)
    const [executable, args, commandOptions] = runCommand.mock.calls[0]
    expect(executable).toContain(path.join('pnpm', 'pnpm.cmd'))
    expect(args).toEqual(['store', 'prune', '--store-dir', path.resolve(storeRoot)])
    expect(commandOptions.cwd).toBe(path.resolve(storeRoot))
    expect(commandOptions.env.PNPM_CONFIG_STORE_DIR).toBe(path.resolve(storeRoot))
    expect(commandOptions.env.PNPM_CONFIG_OFFLINE).toBe('true')
    expect(commandOptions.env.PNPM_CONFIG_CACHE_DIR).toBe(path.join(path.resolve(storeRoot), '.metadata-cache'))
    expect(emitOutput).toHaveBeenCalledWith('info', expect.stringContaining('Removed 2 files'))
  })

  it('reports a failed prune command', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-store-prune-'))
    const storeRoot = path.join(temporaryDirectory, 'store')
    await mkdir(storeRoot, { recursive: true })
    const runCommand = vi.fn(async () => ({ exitCode: 1, output: 'store is locked' }))
    const { pruner } = makePruner(storeRoot, runCommand)

    await expect(pruner(storeRoot)).rejects.toThrow('store is locked')
  })
})
