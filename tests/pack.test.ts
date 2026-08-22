import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, InstalledSkill, PackManifest, PackPluginEntry, ProfileState } from '../src/types'
import { createPackManager, type PackInstallTarget } from '../electron/pack'
import { buildPackZip, inspectPackZip } from '../electron/pack-zip'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { recordPluginInstall, type PluginInstallReceipt } from '../electron/plugin-receipts'
import { recordPresetInstall } from '../electron/preset-receipts'
import { defaultSettings } from '../electron/settings'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'dsh-pack-mgr-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

async function makeEnv(): Promise<{
  root: string
  dshHome: string
  registryPath: string
  snapshotRoot: string
  pluginReceiptsPath: string
  presetReceiptsPath: string
  skillReceiptsPath: string
}> {
  const root = await temporaryDirectory()
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles'), { recursive: true })
  return {
    root,
    dshHome,
    registryPath: path.join(root, 'packs.json'),
    snapshotRoot: path.join(root, 'pack-snapshots'),
    pluginReceiptsPath: path.join(root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(root, 'preset-installs.json'),
    skillReceiptsPath: path.join(root, 'skill-installs.json'),
  }
}

const defaultProfile: ProfileState = {
  initialized: true,
  profileDir: '',
  manifestPath: '',
  plugins: [],
  activeBundles: [],
  dependencyCount: 0,
  disabledCount: 0,
}

function makeInstallerStub() {
  const installPluginTarget = vi.fn(async (_target: PackInstallTarget): Promise<void> => {})
  const installSkillLocal = vi.fn(async (_dshHome: string, _skill: { name: string; format: 'bundle' | 'flat'; sourceDir: string }): Promise<void> => {})
  const installPreset = vi.fn(async (request: { name: string }): Promise<{ installedPreset: { name: string; path: string; enabled: boolean }; installedPresets: never[] }> => ({
    installedPreset: { name: request.name, path: path.join(process.cwd(), request.name), enabled: true },
    installedPresets: [],
  }))
  const installPresetLocal = vi.fn(async (_dshHome: string, _preset: { name: string; sourceDir: string }): Promise<void> => {})
  const installSkill = vi.fn(async (_request: { repository: string; targetId: string }): Promise<{ installedSkill: InstalledSkill; installedSkills: never[] }> => ({
    installedSkill: {
      name: _request.targetId,
      description: '',
      path: path.join(process.cwd(), _request.targetId),
      format: 'bundle',
      enabled: true,
      modelInvocable: false,
      userInvocable: false,
    },
    installedSkills: [],
  }))
  const installSkillPinned = vi.fn(async (_request: { repository: string; target: { name: string } }): Promise<InstalledSkill> => ({
    name: _request.target.name,
    description: '',
    path: path.join(process.cwd(), _request.target.name),
    format: 'bundle',
    enabled: true,
    modelInvocable: false,
    userInvocable: false,
  }))
  const toggleSkill = vi.fn(async (_name: string, _enabled: boolean): Promise<never[]> => [])
  const togglePreset = vi.fn(async (_name: string, _enabled: boolean): Promise<never[]> => [])
  const remove = vi.fn(async (_packageName: string, _profileName?: string): Promise<void> => {})
  const readProfile = vi.fn(async (): Promise<ProfileState> => defaultProfile)
  const togglePlugin = vi.fn(async (): Promise<ProfileState> => defaultProfile)
  return {
    installPluginTarget,
    installSkillLocal,
    installSkill,
    installSkillPinned,
    toggleSkill,
    installPreset,
    installPresetLocal,
    togglePreset,
    remove,
    readProfile,
    togglePlugin,
  }
}

type InstallerStub = ReturnType<typeof makeInstallerStub>

function makeSettings(dshHome: string, profileName = 'web') {
  let current: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome,
    dshVersion: '0.1.0-rc.7',
    profileName,
  }
  const saveSettings = vi.fn(async (next: AppSettings) => { current = next; return current })
  const readSettings = vi.fn(async () => current)
  return { readSettings, saveSettings, get current(): AppSettings { return current } }
}

type SettingsStoreMock = ReturnType<typeof makeSettings>

interface MakeManagerOptions {
  isRuntimeRunning?: () => boolean
  isInstallerBusy?: () => boolean
}

function makeManager(
  env: Awaited<ReturnType<typeof makeEnv>>,
  installer: InstallerStub,
  store: SettingsStoreMock,
  options: MakeManagerOptions = {},
) {
  const emitEvent = vi.fn()
  const manager = createPackManager({
    readSettings: store.readSettings,
    saveSettings: store.saveSettings,
    registryPath: env.registryPath,
    snapshotRoot: env.snapshotRoot,
    pluginReceiptsPath: env.pluginReceiptsPath,
    presetReceiptsPath: env.presetReceiptsPath,
    skillReceiptsPath: env.skillReceiptsPath,
    applicationAddons: {
      list: vi.fn(async () => []),
      install: vi.fn(async () => {}),
      uninstall: vi.fn(async () => []),
    },
    installer,
    emitEvent,
    isRuntimeRunning: options.isRuntimeRunning ?? (() => false),
    isInstallerBusy: options.isInstallerBusy ?? (() => false),
    dshHome: env.dshHome,
  })
  return { manager, emitEvent }
}

function recordFor(id: string, plugins: PackRecord['plugins'] = []): PackRecord {
  return {
    id,
    name: id,
    description: '',
    version: '1.0.0',
    source: 'created',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'complete',
    plugins,
  }
}

function receipt(packageName: string, profileName: string, source: PluginInstallReceipt['source'] = 'npm'): PluginInstallReceipt {
  return {
    repository: 'demo/owner',
    packageName,
    profileName,
    source,
    subdirectory: null,
    version: '1.2.3',
    commit: 'abc1234',
    installedAt: new Date().toISOString(),
  }
}

async function writeZip(env: Awaited<ReturnType<typeof makeEnv>>, fileName: string, manifest: PackManifest, bodies: Map<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(buildPackZip({ ...manifest, dshVersion: manifest.dshVersion ?? '0.1.0-rc.7' }, bodies)))
  return zipPath
}

/** 非标准 raw zip：任意路径 → 内容的字节构建器（不经 buildPackZip，可无 dsh-pack.yaml）。 */
function rawZip(entries: Record<string, string>): Uint8Array {
  const zip = new AdmZip()
  for (const [rel, content] of Object.entries(entries)) zip.addFile(rel, Buffer.from(content))
  return zip.toBuffer()
}

async function writeRawZip(env: Awaited<ReturnType<typeof makeEnv>>, fileName: string, entries: Record<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(rawZip(entries)))
  return zipPath
}

const SKILL_DOC = '---\nname: my-skill\ndescription: A skill.\n---\nBody.\n'

function managedPlugin(packageName: string) {
  return {
    packageName,
    displayName: packageName,
    version: '1.0.0',
    description: '',
    enabled: true,
    builtin: false,
    locked: false,
    compatible: true,
    order: 1,
  }
}

// ---------------------------------------------------------------------------
// createPack
// ---------------------------------------------------------------------------

describe.skip('legacy createPack tests（独立 Profile 语义已废弃）', () => {
  it('按 receipt 重建 target，装进 pack profile（profileName = packId）', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await recordPluginInstall(env.pluginReceiptsPath, receipt('alpha', 'web', 'npm'))

    const result = await manager.createPack({ name: 'My Pack', description: 'd', packageNames: ['alpha'] })
    expect(result.installed).toEqual(['alpha'])
    expect(result.failures).toEqual([])
    expect(result.state).toBe('complete')

    expect(stub.installPluginTarget).toHaveBeenCalledTimes(1)
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.profileName).toBe('pack-my-pack')
    expect(target.packageName).toBe('alpha')
    expect(target.source).toBe('npm')
    expect(target.repository).toBe('demo/owner')

    const records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('pack-my-pack')
    expect(records[0].plugins).toEqual([{ packageName: 'alpha', enabled: true }])
  })

  it('把有来源记录的已安装 Agent 预设纳入自建包', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await recordPresetInstall(env.presetReceiptsPath, {
      name: 'router-standard',
      repository: 'demo/preset-repo',
      sourcePath: 'preset/router-standard',
      revision: 'abc1234',
      installedAt: new Date().toISOString(),
    })

    const result = await manager.createPack({ name: 'Preset Pack', packageNames: [], presetNames: ['router-standard'] })
    expect(result.installed).toEqual(['router-standard'])
    expect(result.state).toBe('complete')

    const records = await readPackRegistry(env.registryPath)
    expect(records[0].presets).toEqual([{ name: 'router-standard', enabled: true }])
    expect(stub.installPreset).not.toHaveBeenCalled()
  })

  it('github 源 receipt 重建为 github target，subdirectory 保留', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await recordPluginInstall(env.pluginReceiptsPath, {
      ...receipt('alpha', 'web', 'github'),
      subdirectory: 'packages/alpha',
    })

    const result = await manager.createPack({ name: 'G', packageNames: ['alpha'] })
    expect(result.state).toBe('complete')
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.source).toBe('github')
    expect(target.subdirectory).toBe('packages/alpha')
    expect(target.repository).toBe('demo/owner')
    // receipt 的固定 commit 保留在 target 上，供组装层转发为安装 pin。
    expect(target.commit).toBe('abc1234')
  })

  it('无来源记录的包名进 failures，state = failed', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)

    const result = await manager.createPack({ name: 'Empty', packageNames: ['ghost'] })
    expect(result.installed).toEqual([])
    expect(result.failures).toEqual([{ packageName: 'ghost', reason: '无来源记录，无法重新安装' }])
    expect(result.state).toBe('failed')
    expect(stub.installPluginTarget).not.toHaveBeenCalled()

    // 失败明细随记录持久化，列表页关闭对话框后仍可见。
    const records = await readPackRegistry(env.registryPath)
    expect(records[0].failures).toEqual([{ packageName: 'ghost', reason: '无来源记录，无法重新安装' }])
  })

  it('local 源 receipt 无法重建 → failure', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await recordPluginInstall(env.pluginReceiptsPath, receipt('local-pkg', 'web', 'local-directory'))

    const result = await manager.createPack({ name: 'L', packageNames: ['local-pkg'] })
    expect(result.state).toBe('failed')
    expect(result.failures[0].reason).toMatch(/缺少来源路径/)
    expect(stub.installPluginTarget).not.toHaveBeenCalled()
  })

  it('guard 拒绝：DSH 运行时正在运行', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store, { isRuntimeRunning: () => true })
    await expect(manager.createPack({ name: 'A', packageNames: ['alpha'] })).rejects.toThrow('DSH 运行时正在运行')
  })

  it('guard 拒绝：安装器忙', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store, { isInstallerBusy: () => true })
    await expect(manager.createPack({ name: 'A', packageNames: ['alpha'] })).rejects.toThrow('安装器忙')
  })

  it('guard 拒绝：已有整合包操作进行中', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await recordPluginInstall(env.pluginReceiptsPath, receipt('alpha', 'web'))

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    stub.installPluginTarget.mockImplementationOnce(() => gate)

    const first = manager.createPack({ name: 'Busy Pack', packageNames: ['alpha'] })
    await vi.waitFor(() => expect(stub.installPluginTarget).toHaveBeenCalled())
    await expect(manager.createPack({ name: 'Other Pack', packageNames: ['alpha'] })).rejects.toThrow('整合包操作进行中')
    release()
    await first
  })
})

// ---------------------------------------------------------------------------
// importPack
// ---------------------------------------------------------------------------

describe.skip('legacy importPack tests（独立 Profile 语义已废弃）', () => {
  it('离线分支：有 plugin-bodies 的 zip → local-directory 目标指向解压目录', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const bodyRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-body-'))
    const alphaDir = path.join(bodyRoot, 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }))

    const manifest: PackManifest = {
      name: 'Offline Pack',
      description: 'offline',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeZip(env, 'offline-pack.zip', manifest, new Map([['alpha', alphaDir]]))

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['alpha'])
    expect(result.failures).toEqual([])
    expect(stub.installPluginTarget).toHaveBeenCalledTimes(1)

    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.source).toBe('local-directory')
    expect(target.profileName).toBe('pack-offline-pack')
    expect(target.packageName).toBe('alpha')
    // 本体解到 pack profile 内的持久目录（.pack-bodies），安装后不删除，file: 引用不悬空。
    expect(target.localDirectory).toBe(path.join(env.dshHome, 'profiles', 'pack-offline-pack', '.pack-bodies', 'alpha'))
    expect(await readFile(path.join(target.localDirectory!, 'package.json'), 'utf8')).toContain('"name":"alpha"')

    await rm(bodyRoot, { recursive: true, force: true })
  })

  it('联网分支：manifest-only 包 → github 源目标', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const manifest: PackManifest = {
      name: 'Online Pack',
      description: 'online',
      version: '1.0.0',
      plugins: [{ packageName: 'beta', repository: 'demo/beta', source: 'github' }],
    }
    const zipPath = await writeZip(env, 'online-pack.zip', manifest, new Map())

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['beta'])
    expect(result.state).toBe('complete')
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.source).toBe('github')
    expect(target.repository).toBe('demo/beta')
    expect(target.profileName).toBe('pack-online-pack')
  })

  it('manifest 中的 presets 会调用 installPreset 并记入注册表', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const manifest: PackManifest = {
      name: 'Preset Import',
      description: 'preset import',
      version: '1.0.0',
      plugins: [],
      presets: [{
        name: 'router-standard',
        repository: 'demo/preset-repo',
        sourcePath: 'preset/router-standard',
        revision: 'abc1234',
      }],
    }
    const zipPath = await writeZip(env, 'preset-import.zip', manifest, new Map())

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['router-standard'])
    expect(result.state).toBe('complete')
    expect(stub.installPreset).toHaveBeenCalledTimes(1)
    expect(stub.installPreset.mock.calls[0][0]).toMatchObject({
      repository: 'demo/preset-repo',
      name: 'router-standard',
      sourcePath: 'preset/router-standard',
      revision: 'abc1234',
    })

    const records = await readPackRegistry(env.registryPath)
    expect(records[0].presets).toEqual([{ name: 'router-standard', enabled: true }])
  })

  it('指定 items 且缺 body 时回落到 manifest-only 来源', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const bodyRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-body-'))
    const alphaDir = path.join(bodyRoot, 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))

    const manifest: PackManifest = {
      name: 'Mixed',
      description: 'mixed',
      version: '1.0.0',
      plugins: [
        { packageName: 'alpha', source: 'npm' },
        { packageName: 'beta', repository: 'demo/beta', source: 'github' },
      ],
    }
    const zipPath = await writeZip(env, 'mixed.zip', manifest, new Map([['alpha', alphaDir]]))

    const result = await manager.importPack(zipPath, ['beta'])
    expect(result.installed).toEqual(['beta'])
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.source).toBe('github')
    expect(target.repository).toBe('demo/beta')

    await rm(bodyRoot, { recursive: true, force: true })
  })

  it('raw 分支：插件与技能各自离线安装，注册表记录 source=raw 且带 skills', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'raw-pack.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha', version: '1.2.3' }),
      'plugin-beta/package.json': JSON.stringify({ name: 'beta' }),
      'skills/my-skill/SKILL.md': SKILL_DOC,
    })

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['alpha', 'beta', 'my-skill'])
    expect(result.failures).toEqual([])
    expect(result.state).toBe('complete')

    // 插件 → local-directory target，本体解到 pack profile 持久目录。
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.source).toBe('local-directory')
    expect(target.profileName).toBe('pack-raw-pack')
    expect(target.localDirectory).toBe(path.join(env.dshHome, 'profiles', 'pack-raw-pack', '.pack-bodies', 'alpha'))
    expect(stub.installPluginTarget).toHaveBeenCalledTimes(2)

    // 技能 → installSkillLocal 全局安装。
    expect(stub.installSkillLocal).toHaveBeenCalledTimes(1)
    expect(stub.installSkillLocal).toHaveBeenCalledWith(
      env.dshHome,
      expect.objectContaining({ name: 'my-skill', format: 'bundle' }),
    )

    const records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].source).toBe('raw')
    expect(records[0].plugins).toEqual([
      { packageName: 'alpha', enabled: true },
      { packageName: 'beta', enabled: true },
    ])
    expect(records[0].skills).toEqual([{ name: 'my-skill', format: 'bundle', enabled: true }])
  })

  it('raw 分支：preset.yml 目录被识别并本地安装', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'raw-preset.zip', {
      'presets/router-standard/preset.yml': 'name: router-standard\n',
      'presets/router-standard/helper.js': 'export {}',
    })

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['router-standard'])
    expect(result.state).toBe('complete')
    expect(stub.installPresetLocal).toHaveBeenCalledTimes(1)
    expect(stub.installPresetLocal.mock.calls[0][1]).toMatchObject({ name: 'router-standard' })

    const records = await readPackRegistry(env.registryPath)
    expect(records[0].source).toBe('raw')
    expect(records[0].presets).toEqual([{ name: 'router-standard', enabled: true }])
  })

  it('raw 分支：items 只装选中的插件/技能', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'raw-select.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
      'plugin-beta/package.json': JSON.stringify({ name: 'beta' }),
    })

    const result = await manager.importPack(zipPath, ['beta'])
    expect(result.installed).toEqual(['beta'])
    expect(stub.installPluginTarget).toHaveBeenCalledTimes(1)
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.packageName).toBe('beta')

    const records = await readPackRegistry(env.registryPath)
    expect(records[0].plugins).toEqual([{ packageName: 'beta', enabled: true }])
  })

  it('raw 分支：options.name 覆盖包名（packId 按覆盖名派生）', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, '乱码整合包.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
    })

    const result = await manager.importPack(zipPath, undefined, { name: 'My Pack' })
    expect(result.installed).toEqual(['alpha'])
    const records = await readPackRegistry(env.registryPath)
    expect(records[0].id).toBe('pack-my-pack')
    expect(records[0].name).toBe('My Pack')
    const target = stub.installPluginTarget.mock.calls[0][0] as PackInstallTarget
    expect(target.profileName).toBe('pack-my-pack')
  })

  it('raw 分支：纯中文名无法派生有意义的包标识 → 拒绝', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, '乱码整合包.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
    })

    await expect(manager.importPack(zipPath, undefined, { name: '我的整合包' })).rejects.toThrow('需包含字母或数字')
    expect(stub.installPluginTarget).not.toHaveBeenCalled()
  })

  it('raw 分支：无可安装项抛错', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'empty.zip', {
      'readme.txt': 'just a file',
      'locales/en.pak': 'binary',
    })
    await expect(manager.importPack(zipPath)).rejects.toThrow('未在压缩包内发现可安装的插件、技能或预设')
  })

  it('raw 分支：flat 技能安装为单 .md', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'raw-flat.zip', {
      'skills/quick-ref.md': '---\nname: quick-ref\ndescription: Quick ref.\n---\nBody.\n',
    })

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['quick-ref'])
    expect(stub.installSkillLocal).toHaveBeenCalledWith(
      env.dshHome,
      expect.objectContaining({ name: 'quick-ref', format: 'flat' }),
    )
    const records = await readPackRegistry(env.registryPath)
    expect(records[0].skills).toEqual([{ name: 'quick-ref', format: 'flat', enabled: true }])
  })

  it('读文件失败（文件被并发删除）后互斥复位，后续导入可用', async () => {
    // 安全回归：beginTask 之后、try 之外的 readFile 若抛错会卡死 active，导致整合包子系统
    // 永久「进行中」。readFile 必须在 try 内，失败也要复位互斥。
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const ghostPath = path.join(env.root, 'ghost.zip')
    await expect(manager.importPack(ghostPath)).rejects.toThrow()

    // 互斥已复位：后续正常导入成功，不再报「整合包操作进行中」。
    const manifest: PackManifest = { name: 'Ok', description: 'o', version: '1.0.0', plugins: [] }
    const zipPath = await writeZip(env, 'ok.zip', manifest, new Map())
    const result = await manager.importPack(zipPath)
    expect(result.state).toBe('complete')
  })
})

// ---------------------------------------------------------------------------
// analyzeImport
// ---------------------------------------------------------------------------

describe('analyzeImport', () => {
  it('有 body 的包：按 bodyPackageNames 列出，offline = true', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const bodyRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-body-'))
    const alphaDir = path.join(bodyRoot, 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha' }))

    const manifest: PackManifest = {
      name: 'An',
      description: 'a',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeZip(env, 'an.zip', manifest, new Map([['alpha', alphaDir]]))

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.id).toBe('pack-an')
    expect(analysis.source).toBe('zip')
    expect(analysis.items).toEqual([{ packageName: 'alpha', available: true, offline: true, enabled: true }])
    await rm(bodyRoot, { recursive: true, force: true })
  })

  it('manifest-only 缺 repository 且非 npm 源标不可用', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const plugin: PackPluginEntry = { packageName: 'broken', source: 'github' }
    const manifest: PackManifest = {
      name: 'An',
      description: 'a',
      version: '1.0.0',
      plugins: [plugin],
    }
    const zipPath = await writeZip(env, 'an.zip', manifest, new Map())

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('manifest')
    expect(analysis.items).toEqual([{
      packageName: 'broken',
      available: false,
      offline: false,
      reason: '缺少来源仓库，无法联网安装',
    }])
  })

  it('无清单 zip 回退 raw：source=raw，name 取文件名清洗值，技能项带 kind=skill', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, 'raw-an.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha', version: '1.0.0' }),
      'skills/my-skill/SKILL.md': SKILL_DOC,
    })

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('raw')
    expect(analysis.id).toBe('pack-raw-an')
    expect(analysis.name).toBe('raw-an')
    expect(analysis.items).toEqual([
      { packageName: 'alpha', available: true, offline: true },
      { packageName: 'my-skill', available: true, offline: true, kind: 'skill' },
    ])
  })

  it('无清单且文件名/顶层目录名无法清洗出 ASCII 时 name 为空', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const zipPath = await writeRawZip(env, '整合包(1).zip', {
      '整合包/plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
    })

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('raw')
    expect(analysis.name).toBe('')
    expect(analysis.id).toBe('')
  })
})

// ---------------------------------------------------------------------------
// removePack
// ---------------------------------------------------------------------------

describe('removePack runtime guard', () => {
  it('allows deleting an inactive pack while DSH runtime is running', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [managedPlugin('alpha')] })
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store, { isRuntimeRunning: () => true })
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))

    const result = await manager.removePack('pack-x')
    expect(result.removed).toBe(1)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
  })

  it('still blocks deleting an active pack while DSH runtime is running', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [managedPlugin('alpha')] })
    const store = makeSettings(env.dshHome, 'web')
    store.current.activePackId = 'pack-x'
    const { manager } = makeManager(env, stub, store, { isRuntimeRunning: () => true })
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))

    await expect(manager.removePack('pack-x')).rejects.toThrow('DSH 运行时正在运行')
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// activate / deactivate
// ---------------------------------------------------------------------------

describe.skip('legacy activatePack / deactivatePack tests（独立 Profile 语义已废弃）', () => {
  it('activatePack 切到 pack profile，deactivatePack 回到默认 profile', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x'))

    const activated = await manager.activatePack('pack-x')
    expect(activated.profileName).toBe('pack-x')
    expect(store.current.profileName).toBe('pack-x')

    const deactivated = await manager.deactivatePack()
    expect(deactivated.profileName).toBe('web')
    expect(store.current.profileName).toBe('web')
  })

  it('activatePack 对不存在的包抛错', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await expect(manager.activatePack('pack-ghost')).rejects.toThrow('整合包不存在')
  })
})

// ---------------------------------------------------------------------------
// removePack
// ---------------------------------------------------------------------------

describe.skip('legacy removePack tests（独立 Profile 语义已废弃）', () => {
  it('当前启用时先 deactivate，再逐个 remove 插件并删除注册表记录', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({
      ...defaultProfile,
      plugins: [managedPlugin('alpha'), managedPlugin('beta')],
    })
    const store = makeSettings(env.dshHome, 'pack-x')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [
      { packageName: 'alpha', enabled: true },
      { packageName: 'beta', enabled: true },
    ]))

    const result = await manager.removePack('pack-x')
    expect(result.removed).toBe(2)
    expect(store.current.profileName).toBe('web')
    expect(stub.remove).toHaveBeenCalledWith('alpha', 'pack-x')
    expect(stub.remove).toHaveBeenCalledWith('beta', 'pack-x')
    expect(await readPackRegistry(env.registryPath)).toEqual([])
  })

  it('未启用时跳过 deactivate', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [] })
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x'))

    const result = await manager.removePack('pack-x')
    expect(result.removed).toBe(0)
    expect(store.current.profileName).toBe('web')
    expect(store.saveSettings).not.toHaveBeenCalled()
  })

  it('删除含 bundle 技能的包：无其它包引用时清掉 bundle 目录与 disabled 副本，保留同名 flat 技能', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [] })
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, {
      ...recordFor('pack-x'),
      skills: [{ name: 'my-skill', format: 'bundle', enabled: true }],
    })

    // 预置全局技能落盘：bundle 目录（本包安装的）+ 同名 flat 文件（用户自行安装的异形技能）。
    const skillRoot = path.join(env.dshHome, 'skills')
    await mkdir(path.join(skillRoot, 'my-skill'), { recursive: true })
    await writeFile(path.join(skillRoot, 'my-skill', 'SKILL.md'), SKILL_DOC)
    await writeFile(path.join(skillRoot, 'my-skill.md'), SKILL_DOC)
    await mkdir(path.join(skillRoot, '.disabled', 'my-skill'), { recursive: true })
    await writeFile(path.join(skillRoot, '.disabled', 'my-skill', 'SKILL.md'), 'stale')

    await manager.removePack('pack-x')

    await expect(readFile(path.join(skillRoot, 'my-skill', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(skillRoot, '.disabled', 'my-skill', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    // 同名 flat 不是本包安装的，保留。
    expect(await readFile(path.join(skillRoot, 'my-skill.md'), 'utf8')).toContain('my-skill')
  })

  it('删除含 flat 技能的包：清掉 flat 文件与 disabled 副本，保留同名 bundle 技能', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [] })
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, {
      ...recordFor('pack-x'),
      skills: [{ name: 'quick-ref', format: 'flat', enabled: true }],
    })

    const skillRoot = path.join(env.dshHome, 'skills')
    await mkdir(path.join(skillRoot, 'quick-ref'), { recursive: true })
    await writeFile(path.join(skillRoot, 'quick-ref', 'SKILL.md'), SKILL_DOC)
    await writeFile(path.join(skillRoot, 'quick-ref.md'), SKILL_DOC)
    await mkdir(path.join(skillRoot, '.disabled'), { recursive: true })
    await writeFile(path.join(skillRoot, '.disabled', 'quick-ref.md'), 'stale')

    await manager.removePack('pack-x')

    await expect(readFile(path.join(skillRoot, 'quick-ref.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(skillRoot, '.disabled', 'quick-ref.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    // 同名 bundle 不是本包安装的，保留。
    expect(await readFile(path.join(skillRoot, 'quick-ref', 'SKILL.md'), 'utf8')).toContain('my-skill')
  })

  it('删除含技能的包：有其它包引用同名技能时保留', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [] })
    const store = makeSettings(env.dshHome, 'web')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, {
      ...recordFor('pack-x'),
      skills: [{ name: 'shared', format: 'bundle', enabled: true }],
    })
    await upsertPackRecord(env.registryPath, {
      ...recordFor('pack-y'),
      skills: [{ name: 'shared', format: 'bundle', enabled: true }],
    })

    const skillRoot = path.join(env.dshHome, 'skills')
    await mkdir(path.join(skillRoot, 'shared'), { recursive: true })
    await writeFile(path.join(skillRoot, 'shared', 'SKILL.md'), '---\nname: shared\ndescription: Shared.\n---\n')

    await manager.removePack('pack-x')

    expect(await readFile(path.join(skillRoot, 'shared', 'SKILL.md'), 'utf8')).toContain('name: shared')
  })
})

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe.skip('legacy rollback tests（独立 Profile 语义已废弃）', () => {
  it('新建包失败后回滚：删除 profile 目录与注册表记录', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.installPluginTarget.mockRejectedValue(new Error('boom'))
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)

    const manifest: PackManifest = {
      name: 'Roll',
      description: 'roll',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeZip(env, 'roll.zip', manifest, new Map())

    const result = await manager.importPack(zipPath)
    expect(result.state).toBe('failed')
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1)

    const profileDir = path.join(env.dshHome, 'profiles', 'pack-roll')
    expect(await readdir(profileDir)).toBeDefined()

    const rolledBack = await manager.rollback()
    expect(rolledBack.profileName).toBe('pack-roll')
    // profile 目录与注册表记录都被清掉，等于撤销这次创建。
    await expect(readdir(profileDir)).rejects.toThrow()
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    await expect(manager.hasSnapshot()).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// exportPack
// ---------------------------------------------------------------------------

describe.skip('legacy exportPack tests（独立 Profile 语义已废弃）', () => {
  it('只收集 manifest 引用的插件本体（无来源记录的不进包）', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({
      ...defaultProfile,
      plugins: [managedPlugin('alpha'), managedPlugin('ghost')],
    })
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x'))
    await recordPluginInstall(env.pluginReceiptsPath, receipt('alpha', 'pack-x', 'npm'))

    const alphaDir = path.join(env.dshHome, 'profiles', 'pack-x', 'node_modules', 'alpha')
    await mkdir(alphaDir, { recursive: true })
    await writeFile(path.join(alphaDir, 'package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }))

    const { zipPath } = await manager.exportPack('pack-x')
    const inspection = inspectPackZip(await readFile(zipPath))
    expect(inspection.manifest.plugins).toEqual([{ packageName: 'alpha', source: 'npm', version: '1.2.3' }])
    expect(inspection.bodyPackageNames).toEqual(['alpha'])
  })

  it('导出包含 presets 清单', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [] })
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, {
      ...recordFor('pack-x'),
      presets: [{ name: 'router-standard', enabled: true }],
    })
    await recordPresetInstall(env.presetReceiptsPath, {
      name: 'router-standard',
      repository: 'demo/preset-repo',
      sourcePath: 'preset/router-standard',
      revision: 'abc1234',
      installedAt: new Date().toISOString(),
    })

    const { zipPath } = await manager.exportPack('pack-x')
    const inspection = inspectPackZip(await readFile(zipPath))
    expect(inspection.manifest.presets).toEqual([{
      name: 'router-standard',
      repository: 'demo/preset-repo',
      sourcePath: 'preset/router-standard',
      revision: 'abc1234',
    }])
  })

  it('profile 中无 source 时导出 manifest-only 包（不失败）', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    stub.readProfile.mockResolvedValue({ ...defaultProfile, plugins: [] })
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-empty'))

    const { zipPath } = await manager.exportPack('pack-empty')
    const inspection = inspectPackZip(await readFile(zipPath))
    expect(inspection.hasBodies).toBe(false)
    expect(inspection.manifest.plugins).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// togglePackItem / removePackItem
// ---------------------------------------------------------------------------

describe.skip('legacy togglePackItem / removePackItem tests（独立 Profile 语义已废弃）', () => {
  it('togglePackItem 调用 togglePlugin 并更新注册表 enabled', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: false }]))

    const status = await manager.togglePackItem('pack-x', 'alpha', true)
    expect(stub.togglePlugin).toHaveBeenCalledWith(env.dshHome, 'pack-x', 'alpha', true)
    expect(status.plugins.find(p => p.packageName === 'alpha')?.enabled).toBe(true)
  })

  it('removePackItem 调用 remove 并从注册表移除插件', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome)
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-x', [{ packageName: 'alpha', enabled: true }]))

    const status = await manager.removePackItem('pack-x', 'alpha')
    expect(stub.remove).toHaveBeenCalledWith('alpha', 'pack-x')
    expect(status.plugins).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// listPacks
// ---------------------------------------------------------------------------

describe.skip('legacy listPacks tests（独立 Profile 语义已废弃）', () => {
  it('按当前 profile 标记 enabled', async () => {
    const env = await makeEnv()
    const stub = makeInstallerStub()
    const store = makeSettings(env.dshHome, 'pack-one')
    const { manager } = makeManager(env, stub, store)
    await upsertPackRecord(env.registryPath, recordFor('pack-one'))
    await upsertPackRecord(env.registryPath, recordFor('pack-two'))

    const statuses = await manager.listPacks()
    expect(statuses.find(status => status.id === 'pack-one')?.enabled).toBe(true)
    expect(statuses.find(status => status.id === 'pack-two')?.enabled).toBe(false)
  })
})
