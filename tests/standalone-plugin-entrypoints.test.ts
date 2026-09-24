import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 真实文件系统/子进程操作在并行与慢盘环境下会超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 })
import { IPC } from '../src/constants'
import type { AppSettings, ProfileState } from '../src/types'
import { registerIpcHandlers, type IpcDependencies } from '../electron/ipc'
import { createInstaller, type InstallerOptions } from '../electron/installer'
import type { StandaloneExportOptions, StandaloneImportOptions } from '../electron/standalone-plugin'
import { createPackManager, type InstallInstaller } from '../electron/pack'
import { writeProfileMetadata } from '../electron/profile-service'
import type { StandaloneNativeRuntime } from '../electron/standalone-plugin-native'
import { dshVersionRoot } from '../electron/runtime-versions'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  picker: vi.fn(),
  importArchive: vi.fn<(options: StandaloneImportOptions) => Promise<ProfileState>>(),
  exportArchive: vi.fn<(options: StandaloneExportOptions) => Promise<void>>(),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {}, shell: {},
  dialog: { showOpenDialog: mocks.picker },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
}))
vi.mock('../electron/standalone-plugin', () => ({ importStandalonePlugin: mocks.importArchive, exportStandalonePlugin: mocks.exportArchive }))

const nativeRuntime: StandaloneNativeRuntime = { node: '24.19.0', modules: '137', napi: '10', platform: 'win32', arch: 'x64' }

let directory: string
beforeEach(async () => {
  vi.resetAllMocks()
  mocks.handlers.clear()
  directory = await mkdtemp(path.join(os.tmpdir(), 'standalone-entrypoints-'))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const settings: AppSettings = {
    dshInstallPath: path.join(directory, 'runtime'), dshHome: path.join(directory, 'home'),
    workspace: directory, profileName: 'web', dshVersion: '1.0.0', launchExecutable: 'dsh',
    launchArgs: ['web'], webPort: 3090, openAfterLaunch: false,
  }
  const profileFile = path.join(settings.dshHome, 'profiles', 'web', 'package.json')
  await mkdir(path.dirname(profileFile), { recursive: true })
  const profileText = '{"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n'
  await writeFile(profileFile, profileText)
  const profile: ProfileState = {
    profileDir: path.dirname(profileFile), manifestPath: profileFile, initialized: true,
    activeBundles: ['dsh-suite-demo'], plugins: [], dependencyCount: 1, disabledCount: 0,
  }
  const state = { running: false, queued: false }
  const options: InstallerOptions = {
    readSettings: vi.fn(async () => settings), saveSettings: vi.fn(async next => next),
    prepareNodeRuntime: vi.fn(), preparePnpmRuntime: vi.fn(), runCommand: vi.fn(),
    nativeRuntime: vi.fn(async () => nativeRuntime),
    pluginSourceRoot: path.join(directory, 'sources'), pluginReceiptsPath: path.join(directory, 'receipts.json'),
    presetReceiptsPath: path.join(directory, 'preset-receipts.json'), skillReceiptsPath: path.join(directory, 'skill-receipts.json'),
    skillSourceRoot: path.join(directory, 'skills'),
    emitOutput: vi.fn(), emitProgress: vi.fn(), isRuntimeRunning: vi.fn(() => state.running),
  }
  const installer = createInstaller(options)
  const idle = { isBusy: () => false }
  const dependencies = {
    settings: { read: options.readSettings }, pluginReceiptsPath: options.pluginReceiptsPath,
    installer, packManager: idle, pluginTrial: idle, aiInstaller: idle, applicationAddons: idle,
    dshMarket: idle, recommendedWebUi: idle, runtimeVersions: idle,
    installQueue: { hasWork: () => state.queued }, copilot: { isMutationBusy: () => false },
    runtime: { isRunning: () => state.running }, getWindow: () => ({}),
  }
  registerIpcHandlers(dependencies as unknown as IpcDependencies)
  const invoke = () => mocks.handlers.get(IPC.pluginsImportStandalone)!(undefined)
  const archivePath = path.join(directory, 'suite.dsh-plugin.zip')
  mocks.picker.mockResolvedValue({ canceled: false, filePaths: [archivePath] })
  mocks.importArchive.mockResolvedValue(profile)
  const installHost = async () => {
    const manifest = path.join(dshVersionRoot(settings.dshInstallPath, '1.0.0'), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    await mkdir(path.dirname(manifest), { recursive: true })
    await writeFile(manifest, '{"name":"@deepseek-ai/dsh","version":"1.0.0"}')
  }
  return { settings, state, options, installer, invoke, archivePath, profile, profileFile, profileText, installHost }
}

describe('standalone plugin import IPC', () => {
  it.each([
    { canceled: true, filePaths: ['ignored.dsh-plugin.zip'] },
    { canceled: false, filePaths: [] },
  ])('does not start an import when the picker returns $canceled / $filePaths', async result => {
    const env = await fixture()
    mocks.picker.mockResolvedValue(result)
    await expect(env.invoke()).resolves.toBeNull()
    expect(mocks.importArchive).not.toHaveBeenCalled()
    expect(env.options.emitProgress).not.toHaveBeenCalled()
    expect(env.installer.isBusy()).toBe(false)
  })

  it.each(['running', 'queued'] as const)('rejects %s state before opening the file picker', async state => {
    const env = await fixture()
    env.state[state] = true
    await expect(env.invoke()).rejects.toThrow(state === 'running' ? '停止 DSH' : '下载队列')
    expect(mocks.picker).not.toHaveBeenCalled()
    expect(mocks.importArchive).not.toHaveBeenCalled()
  })

  it.each(['running', 'queued'] as const)('rechecks %s state after the picker resolves', async state => {
    const env = await fixture()
    mocks.picker.mockImplementation(async () => {
      env.state[state] = true
      return { canceled: false, filePaths: [env.archivePath] }
    })
    await expect(env.invoke()).rejects.toThrow(state === 'running' ? '停止 DSH' : '下载队列')
    expect(mocks.picker).toHaveBeenCalledOnce()
    expect(mocks.importArchive).not.toHaveBeenCalled()
    expect(env.options.emitProgress).not.toHaveBeenCalled()
    expect(env.installer.isBusy()).toBe(false)
  })

  it('imports only the path selected by the main-process picker', async () => {
    const env = await fixture()
    await expect(env.invoke()).resolves.toEqual(env.profile)
    expect(mocks.importArchive).toHaveBeenCalledWith(expect.objectContaining({
      archivePath: env.archivePath, dshHome: env.settings.dshHome, profileName: 'web',
      nativeRuntime: env.options.nativeRuntime,
    }))
    expect(env.installer.isBusy()).toBe(false)
  })
})

describe('standalone installer lock and runtime validation', () => {
  it('propagates native runtime errors, releases its lock, and allows retry without downloading Node', async () => {
    const env = await fixture()
    vi.mocked(env.options.nativeRuntime!).mockRejectedValueOnce(new Error('选定 Node 未安装'))
    mocks.importArchive.mockImplementation(async options => {
      await options.nativeRuntime!()
      return env.profile
    })
    await expect(env.installer.importStandalonePlugin(env.archivePath)).rejects.toThrow('选定 Node 未安装')
    expect(env.installer.isBusy()).toBe(false)
    expect(await readFile(env.profileFile, 'utf8')).toBe(env.profileText)
    await expect(env.installer.importStandalonePlugin(env.archivePath)).resolves.toEqual(env.profile)
    expect(env.options.nativeRuntime).toHaveBeenCalledTimes(2)
    expect(env.options.prepareNodeRuntime).not.toHaveBeenCalled()
    expect(env.options.preparePnpmRuntime).not.toHaveBeenCalled()
    expect(env.options.runCommand).not.toHaveBeenCalled()
  })

  it.each(['missing host', 'different selected version'])('releases its lock after %s and permits a corrected retry', async problem => {
    const env = await fixture()
    if (problem === 'different selected version') {
      await env.installHost()
      env.settings.dshVersion = '2.0.0'
    }
    mocks.importArchive.mockImplementation(async options => {
      expect(env.installer.isBusy()).toBe(true)
      await options.hostNodeModules('1.0.0')
      return env.profile
    })
    await expect(env.installer.importStandalonePlugin(env.archivePath)).rejects.toThrow(
      problem === 'missing host' ? '安装 DSH 1.0.0' : '运行时版本设为 1.0.0',
    )
    expect(env.installer.isBusy()).toBe(false)
    expect(env.options.emitProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error', kind: 'plugin' }))
    expect(await readFile(env.profileFile, 'utf8')).toBe(env.profileText)
    await env.installHost()
    env.settings.dshVersion = '1.0.0'
    await expect(env.installer.importStandalonePlugin(env.archivePath)).resolves.toEqual(env.profile)
    expect(env.installer.isBusy()).toBe(false)
    expect(env.options.emitProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'complete', percent: 100 }))
    expect(env.options.prepareNodeRuntime).not.toHaveBeenCalled()
    expect(env.options.preparePnpmRuntime).not.toHaveBeenCalled()
    expect(env.options.runCommand).not.toHaveBeenCalled()
    expect(env.options.saveSettings).not.toHaveBeenCalled()
  })

  it('blocks a second import while decoding the first archive and releases the lock on completion', async () => {
    const env = await fixture()
    let complete!: (profile: ProfileState) => void
    mocks.importArchive.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const pending = env.installer.importStandalonePlugin(env.archivePath)
    expect(env.installer.isBusy()).toBe(true)
    await expect(env.installer.importStandalonePlugin(env.archivePath)).rejects.toThrow('请等待当前任务完成')
    complete(env.profile)
    await expect(pending).resolves.toEqual(env.profile)
    expect(mocks.importArchive).toHaveBeenCalledOnce()
    expect(env.installer.isBusy()).toBe(false)
  })
})

describe('standalone pack export entrypoint', () => {
  it('forwards the installed Node resolver lazily and releases the export lock on probe failure', async () => {
    const env = await fixture()
    await writeProfileMetadata(env.settings.dshHome, 'web', { dshVersion: '1.0.0', version: '1.0.0' })
    const manager = createPackManager({
      readSettings: async () => env.settings, saveSettings: async settings => settings,
      registryPath: path.join(directory, 'packs.json'), snapshotRoot: path.join(directory, 'snapshots'),
      pluginReceiptsPath: env.options.pluginReceiptsPath, presetReceiptsPath: env.options.presetReceiptsPath, skillReceiptsPath: env.options.skillReceiptsPath,
      installer: { readProfile: async () => env.profile } as unknown as InstallInstaller,
      applicationAddons: { list: async () => [], install: async () => undefined, uninstall: async () => [] },
      emitEvent: vi.fn(), isRuntimeRunning: () => false, isInstallerBusy: () => false,
      nativeRuntime: env.options.nativeRuntime, unifiedProfiles: true,
    })
    mocks.exportArchive.mockImplementationOnce(async options => {
      expect(options.nativeRuntime).toBe(env.options.nativeRuntime)
      expect(env.options.nativeRuntime).not.toHaveBeenCalled()
      await options.nativeRuntime!()
    })
    vi.mocked(env.options.nativeRuntime!).mockRejectedValueOnce(new Error('选定 Node 未安装'))
    await expect(manager.exportPack('web', 'plugin')).rejects.toThrow('选定 Node 未安装')
    expect(manager.isBusy()).toBe(false)
    mocks.exportArchive.mockResolvedValueOnce()
    await expect(manager.exportPack('web', 'plugin')).resolves.toMatchObject({ fileName: 'dsh-suite-web-1.0.0.dsh-plugin.zip' })
    expect(manager.isBusy()).toBe(false)
    expect(env.options.prepareNodeRuntime).not.toHaveBeenCalled()
  })
})
