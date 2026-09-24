import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/constants'
import type { PackManifest, PackPluginEntry } from '../src/types'
import { registerIpcHandlers, resolveLocalPluginBodies, type IpcDependencies } from '../electron/ipc'
import type { PluginInstallReceipt } from '../electron/plugin-receipts'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  readProfile: vi.fn(),
  analyzeRepository: vi.fn(),
  loadManifest: vi.fn(),
  writeMetadata: vi.fn(),
  inspectArchive: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: {},
  shell: {},
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) },
}))
vi.mock('../electron/profile', async importOriginal => ({
  ...await importOriginal<typeof import('../electron/profile')>(),
  readProfile: mocks.readProfile,
}))
vi.mock('../electron/profile-repository-import', async importOriginal => ({
  ...await importOriginal<typeof import('../electron/profile-repository-import')>(),
  analyzeProfileRepository: mocks.analyzeRepository,
  loadProfileRepositoryManifest: mocks.loadManifest,
}))
vi.mock('../electron/profile-service', async importOriginal => ({
  ...await importOriginal<typeof import('../electron/profile-service')>(),
  writeProfileMetadata: mocks.writeMetadata,
  consolidatePluginPool: vi.fn(),
}))
vi.mock('../electron/pack-zip', async importOriginal => ({
  ...await importOriginal<typeof import('../electron/pack-zip')>(),
  inspectPackZipFromPath: mocks.inspectArchive,
}))

let directory: string
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  directory = await mkdtemp(path.join(os.tmpdir(), 'profile-ipc-authority-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function localBody(relative: string, version: string, packageName = 'sample-plugin'): Promise<PluginInstallReceipt> {
  const body = path.join(directory, relative)
  await mkdir(body, { recursive: true })
  await writeFile(path.join(body, 'package.json'), JSON.stringify({ name: packageName, version }))
  return {
    repository: `file:${body}`, packageName, version, source: 'local-directory', profileName: 'other',
    subdirectory: null, commit: '', installedAt: '2026-09-21T00:00:00Z',
  }
}

describe('Profile source authority in IPC', () => {
  it.each<PackPluginEntry>([
    { packageName: 'sample-plugin', source: 'npm', version: '2.0.0' },
    { packageName: 'sample-plugin', source: 'github', repository: 'author/plugin', commit: 'abc1234' },
    { packageName: 'sample-plugin', repository: 'author/plugin' },
  ])('does not substitute a shared local body for $source $repository', async entry => {
    const receipt = await localBody('body', '1.0.0')
    expect(await resolveLocalPluginBodies(directory, [entry], [receipt])).toEqual({})
  })

  it('only resolves a local body compatible with the declared package version', async () => {
    const old = await localBody('old', '1.0.0')
    const current = await localBody('current', '2.0.0')
    const entry: PackPluginEntry = { packageName: 'sample-plugin', source: 'local', version: '2.0.0' }
    expect(await resolveLocalPluginBodies(directory, [entry], [old])).toEqual({})
    expect(await resolveLocalPluginBodies(directory, [entry], [old, current])).toEqual({
      'sample-plugin': path.join(directory, 'current'),
    })
  })

  it('keeps distinct compatible local bodies ambiguous', async () => {
    const first = await localBody('first', '1.0.0')
    const second = await localBody('second', '1.0.0')
    expect(await resolveLocalPluginBodies(directory, [{ packageName: 'sample-plugin', source: 'local' }], [first, second])).toEqual({})
  })

  it('does not trust bodies outside DSH_HOME', async () => {
    const receipt = await localBody('outside', '1.0.0')
    expect(await resolveLocalPluginBodies(path.join(directory, 'home'), [{ packageName: 'sample-plugin', source: 'local' }], [receipt])).toEqual({})
  })
})

function dependencies() {
  const idle = { isBusy: () => false }
  return {
    settings: { read: vi.fn(async () => ({ dshHome: directory, profileName: 'web' })) },
    pluginReceiptsPath: path.join(directory, 'receipts.json'),
    installer: idle, packManager: { ...idle, activatePack: vi.fn(), exportPack: vi.fn(), importPack: vi.fn() },
    pluginTrial: idle, aiInstaller: idle, applicationAddons: idle, dshMarket: idle, recommendedWebUi: idle,
    runtimeVersions: { ...idle, read: vi.fn(async () => ({ dshInstalled: [{ version: '0.1.0' }] })), installDsh: vi.fn() },
    installQueue: { hasWork: () => false }, copilot: { isMutationBusy: () => false },
    runtime: { isRunning: () => false }, profiles: { switch: vi.fn(), list: vi.fn(), metadata: vi.fn() },
    githubAuth: {
      getStatus: vi.fn(async () => ({ authenticated: true, login: 'me' })),
      createRepository: vi.fn(async () => ({ fullName: 'me/dsh-profile-demo', htmlUrl: 'https://github.com/me/dsh-profile-demo', defaultBranch: 'main' })),
      upsertRepositoryFile: vi.fn(),
    },
  }
}

function register(deps: ReturnType<typeof dependencies>) {
  registerIpcHandlers(deps as unknown as IpcDependencies)
  return (name: string, ...args: unknown[]) => mocks.handlers.get(name)!(undefined, ...args)
}

describe('Profile compatibility IPC', () => {
  it.each([IPC.profilesImport, IPC.profilesRepositoryImport])('downloads imported runtimes without selecting them through %s', async channel => {
    const deps = dependencies()
    mocks.loadManifest.mockResolvedValue({
      repository: 'author/demo', branch: 'main', commit: 'abc1234', file: { path: 'dsh-profile.yaml' },
      manifest: { name: 'demo', description: '', version: '1.0.0', dshVersion: '0.2.0', plugins: [] },
    })
    deps.packManager.importPack.mockResolvedValue({ id: 'demo', installed: [], failures: [] })
    deps.profiles.metadata.mockResolvedValue({ id: 'demo' })
    const url = 'https://github.com/author/demo'
    await register(deps)(channel, channel === IPC.profilesImport ? { filePath: url } : { url, mode: 'source' })
    expect(deps.runtimeVersions.installDsh).toHaveBeenCalledWith('0.2.0', { select: false })
  })

  it('routes legacy pack activation through Profile switching and its dependency checks', async () => {
    const deps = dependencies()
    deps.profiles.switch.mockRejectedValue(new Error('missing dependency'))
    const invoke = register(deps)
    await expect(invoke(IPC.packsActivate, 'demo')).rejects.toThrow('missing dependency')
    expect(deps.profiles.switch).toHaveBeenCalledWith('demo')
    expect(deps.packManager.activatePack).not.toHaveBeenCalled()
  })

  it('does not report plugins from another Profile as removed in repository updates', async () => {
    const deps = dependencies()
    deps.profiles.list.mockResolvedValue([{ id: 'demo', source: { kind: 'github', repository: 'author/demo' } }])
    mocks.analyzeRepository.mockResolvedValue({
      repository: 'author/demo', dshVersion: '0.1.0', differences: [],
      plugins: [{ packageName: 'owned', enabled: false, version: '1.0.0', order: 0 }],
    })
    mocks.readProfile.mockResolvedValue({ plugins: [
      { packageName: 'shared-only', builtin: false, declaredInProfile: false, enabled: false },
      { packageName: 'owned', builtin: false, declaredInProfile: true, enabled: false, version: '1.0.0' },
    ] })
    const result = await register(deps)(IPC.profilesRepositoryAnalyze, 'https://github.com/author/demo')
    expect(result.differences).toEqual([])
  })

  it.each([false, true])('preserves origin provenance when exporting (existing destination: %s)', async reuseDestination => {
    const deps = dependencies()
    const archiveDir = path.join(directory, 'export')
    await mkdir(archiveDir)
    const zipPath = path.join(archiveDir, 'profile.zip')
    await writeFile(zipPath, 'test archive')
    deps.packManager.exportPack.mockResolvedValue({ zipPath, fileName: 'demo.zip' })
    deps.profiles.metadata.mockResolvedValue({
      source: { kind: 'github', repository: 'author/original', branch: 'develop', commit: 'abc1234' },
      ...(reuseDestination ? { exportRepository: { repository: 'me/published', branch: 'release' } } : {}),
    })
    mocks.inspectArchive.mockResolvedValue({ manifest: {
      name: 'demo', version: '1.0.0', description: '', dshVersion: '0.1.0', plugins: [],
    } satisfies PackManifest })
    const result = await register(deps)(IPC.profilesExport, { profileName: 'demo', mode: 'repository' })
    const destination = reuseDestination ? 'me/published' : 'me/dsh-profile-demo'
    expect(result).toBe(`https://github.com/${destination}`)
    expect(deps.githubAuth.createRepository).toHaveBeenCalledTimes(reuseDestination ? 0 : 1)
    expect(deps.githubAuth.upsertRepositoryFile.mock.calls.every(call => call[0] === destination)).toBe(true)
    expect(mocks.writeMetadata).toHaveBeenCalledWith(directory, 'demo', {
      exportRepository: { repository: destination, branch: reuseDestination ? 'release' : 'main' },
      exportedAt: expect.any(String),
    })
  })
})
