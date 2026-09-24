import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types'
import { managedDshExecutable } from '../electron/dsh-install'
import { createRuntimeVersionService, dshVersionRoot, type RuntimeVersionServiceOptions } from '../electron/runtime-versions'
import { defaultSettings } from '../electron/settings'

vi.mock('../electron/node-runtime', () => ({
  findManagedNodeRuntimes: vi.fn(async () => []),
  findSystemNodeRuntime: vi.fn(() => null),
  listAvailableNodeVersions: vi.fn(async () => []),
  normalizeNodeVersion: (version: string) => version.replace(/^v/, ''),
  installManagedNodeRuntime: vi.fn(async () => { throw new Error('Unexpected Node installation') }),
}))

const roots: string[] = []
const currentVersion = '0.1.0-rc.7'
const importedVersion = '0.1.1-rc.2'

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function writeInstalledRuntime(root: string, version: string) {
  const executable = managedDshExecutable(root)
  const manifest = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  await mkdir(path.dirname(executable), { recursive: true })
  await mkdir(path.dirname(manifest), { recursive: true })
  await writeFile(executable, '')
  await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
}

async function fixture(exitCode = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-profile-install-'))
  roots.push(root)
  const dshRoot = path.join(root, 'dsh-runtime')
  await writeInstalledRuntime(dshVersionRoot(dshRoot, currentVersion), currentVersion)
  const initialSettings: AppSettings = {
    ...defaultSettings({ homeDirectory: root, documentsDirectory: root }),
    dshHome: path.join(root, 'dsh-home'),
    profileName: 'web',
    dshInstallPath: dshRoot,
    dshVersion: currentVersion,
    launchExecutable: managedDshExecutable(dshVersionRoot(dshRoot, currentVersion)),
    launchArgs: ['web', '--no-open'],
  }
  let settings = initialSettings
  const saveSettings = vi.fn(async (next: AppSettings) => { settings = next; return next })
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    dependencies: {}, versions: { [currentVersion]: {}, [importedVersion]: {} }, 'dist-tags': { latest: importedVersion },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  const execute = vi.fn<NonNullable<RuntimeVersionServiceOptions['runCommand']>>(async (_executable, args, commandOptions) => {
    expect(args).toContain(`@deepseek-ai/dsh@${importedVersion}`)
    if (exitCode === 0) await writeInstalledRuntime(commandOptions.cwd, importedVersion)
    return { exitCode, output: exitCode === 0 ? 'installed' : 'simulated install failure' }
  })
  const emitProgress = vi.fn()
  const service = createRuntimeVersionService({
    dshRoot,
    nodeRoot: path.join(root, 'node-runtime'),
    readSettings: async () => settings,
    saveSettings,
    prepareNodeRuntime: async () => ({
      root, node: path.join(root, 'node.exe'), npm: path.join(root, 'npm.cmd'), npx: path.join(root, 'npx.cmd'), managed: true,
    }),
    preparePnpmRuntime: async () => ({ root, executable: path.join(root, 'pnpm.cmd') }),
    isRuntimeRunning: () => false,
    emitOutput: vi.fn(),
    emitProgress,
    githubFetch: fetchMock,
    runCommand: execute,
  })
  return { service, dshRoot, initialSettings, saveSettings, execute, emitProgress, getSettings: () => settings }
}

describe('Profile runtime preparation does not select an environment', () => {
  it('installs a requested runtime without changing current settings when select is false', async () => {
    const env = await fixture()

    const state = await env.service.installDsh(importedVersion, { select: false })

    expect(env.execute).toHaveBeenCalledTimes(1)
    expect(env.saveSettings).not.toHaveBeenCalled()
    expect(env.getSettings()).toEqual(env.initialSettings)
    expect(state.dshSelectedVersion).toBe(currentVersion)
    expect(state.dshInstalled).toContainEqual(expect.objectContaining({ version: importedVersion, selected: false }))
    expect(state.dshInstalled).toContainEqual(expect.objectContaining({ version: currentVersion, selected: true }))
    expect(env.emitProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'complete', repository: importedVersion, percent: 100 }))
    expect(env.service.isBusy()).toBe(false)
  })

  it('keeps selecting the installed runtime for ordinary installation', async () => {
    const env = await fixture()

    const state = await env.service.installDsh(importedVersion)

    expect(env.saveSettings).toHaveBeenCalledExactlyOnceWith({
      ...env.initialSettings,
      dshVersion: importedVersion,
      launchExecutable: managedDshExecutable(dshVersionRoot(env.dshRoot, importedVersion)),
      launchArgs: ['web'],
    })
    expect(env.getSettings().profileName).toBe('web')
    expect(state.dshSelectedVersion).toBe(importedVersion)
    expect(state.dshInstalled).toContainEqual(expect.objectContaining({ version: importedVersion, selected: true }))
    expect(env.service.isBusy()).toBe(false)
  })

  it('leaves current settings unchanged and releases the operation after a failed unselected install', async () => {
    const env = await fixture(1)

    await expect(env.service.installDsh(importedVersion, { select: false })).rejects.toThrow(/DSH .*1/)

    expect(env.execute).toHaveBeenCalledTimes(1)
    expect(env.saveSettings).not.toHaveBeenCalled()
    expect(env.getSettings()).toEqual(env.initialSettings)
    expect(env.emitProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'error', repository: importedVersion }))
    expect(env.service.isBusy()).toBe(false)
  })
})
