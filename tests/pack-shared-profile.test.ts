import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, ManagedPlugin, PackStatus, ProfileState } from '../src/types'
import { createPackManager, type PackInstallTarget } from '../electron/pack'
import { inspectPackZip } from '../electron/pack-zip'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { recordPluginInstall } from '../electron/plugin-receipts'
import { defaultSettings } from '../electron/settings'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function plugin(packageName: string, builtin = false, enabled = true): ManagedPlugin {
  return { packageName, displayName: packageName, version: '1.0.0', description: '', enabled, builtin, locked: builtin, compatible: true, order: enabled ? 1 : null }
}

function cloneProfile(profile: ProfileState): ProfileState {
  return { ...profile, plugins: profile.plugins.map(item => ({ ...item })), activeBundles: [...profile.activeBundles] }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-shared-'))
  roots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  const paths = {
    dshHome,
    registryPath: path.join(root, 'packs.json'),
    manifestRoot: path.join(root, 'pack-manifests'),
    snapshotRoot: path.join(root, 'snapshots'),
    pluginReceiptsPath: path.join(root, 'plugin-receipts.json'),
    presetReceiptsPath: path.join(root, 'preset-receipts.json'),
    skillReceiptsPath: path.join(root, 'skill-receipts.json'),
  }
  let settings: AppSettings = { ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }), dshHome, dshVersion: '0.1.0-rc.7', profileName: 'web', activePackId: null }
  let profile: ProfileState = {
    initialized: true,
    profileDir: path.join(dshHome, 'profiles', 'web'),
    manifestPath: path.join(dshHome, 'profiles', 'web', 'package.json'),
    plugins: [plugin('core', true), plugin('alpha'), plugin('beta'), plugin('gamma')],
    activeBundles: ['core', 'alpha', 'beta', 'gamma'],
    dependencyCount: 3,
    disabledCount: 0,
  }
  const installer = {
    installPluginTarget: vi.fn(async (_target: PackInstallTarget) => undefined),
    installSkillLocal: vi.fn(async () => undefined),
    installSkill: vi.fn(async () => ({ installedSkill: {} as never, installedSkills: [] })),
    installSkillPinned: vi.fn(async () => ({} as never)),
    toggleSkill: vi.fn(async () => []),
    installPreset: vi.fn(async () => ({ installedPreset: {} as never, installedPresets: [] })),
    installPresetLocal: vi.fn(async () => undefined),
    togglePreset: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    readProfile: vi.fn(async () => cloneProfile(profile)),
    togglePlugin: vi.fn(async (_home: string, _profileName: string, packageName: string, enabled: boolean) => {
      profile = cloneProfile(profile)
      profile.plugins = profile.plugins.map(item => item.packageName === packageName ? { ...item, enabled } : item)
      profile.activeBundles = enabled ? [...profile.activeBundles, ...(profile.activeBundles.includes(packageName) ? [] : [packageName])] : profile.activeBundles.filter(name => name !== packageName)
      return cloneProfile(profile)
    }),
    reorderPlugins: vi.fn(async (_home: string, _profileName: string, packageNames: string[]) => {
      profile = { ...profile, activeBundles: [...packageNames] }
      return cloneProfile(profile)
    }),
  }
  const saveSettings = vi.fn(async (next: AppSettings) => { settings = next; return settings })
  const manager = createPackManager({
    readSettings: async () => settings,
    saveSettings,
    ...paths,
    installer,
    applicationAddons: { list: async () => [], install: async () => undefined, uninstall: async () => [] },
    emitEvent: () => undefined,
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    dshHome,
  })
  await recordPluginInstall(paths.pluginReceiptsPath, { repository: 'demo/alpha', packageName: 'alpha', profileName: 'web', source: 'npm', subdirectory: null, version: '1.0.0', commit: '', installedAt: new Date().toISOString() })
  await recordPluginInstall(paths.pluginReceiptsPath, { repository: 'demo/beta', packageName: 'beta', profileName: 'web', source: 'npm', subdirectory: null, version: '1.0.0', commit: '', installedAt: new Date().toISOString() })
  return { manager, paths, installer, getSettings: () => settings, getProfile: () => profile, saveSettings }
}

function record(id: string, plugins: PackRecord['plugins']): PackRecord {
  const now = new Date().toISOString()
  return { id, name: id, description: 'test', version: '1.0.0', dshVersion: '0.1.0-rc.7', source: 'created', installedAt: now, updatedAt: now, state: 'complete', plugins }
}

describe('shared Profile Pack switching', () => {
  it('creates only a local manifest and does not create profiles/pack-*', async () => {
    const env = await fixture()
    const result = await env.manager.createPack({ name: 'Alpha Pack', packageNames: ['alpha', 'beta'] })
    expect(result.installed).toEqual(['alpha', 'beta'])
    expect(env.installer.installPluginTarget).not.toHaveBeenCalled()
    await expect(readFile(path.join(env.paths.manifestRoot, 'pack-alpha-pack.yaml'), 'utf8')).resolves.toContain('alpha')
    await expect(readFile(path.join(env.paths.manifestRoot, 'pack-alpha-pack.yaml'), 'utf8')).resolves.toContain('beta')
    await expect(readFile(path.join(env.paths.manifestRoot, 'pack-alpha-pack.yaml'), 'utf8')).resolves.toBeTruthy()
  })

  it('creates a pack from installed plugins even without receipts and skips builtin bundles', async () => {
    const env = await fixture()
    const result = await env.manager.createPack({ name: 'Offline Plugins', packageNames: ['core', 'gamma'] })
    expect(result.installed).toEqual(['gamma'])
    expect(result.failures).toEqual([])
    const records = await readPackRegistry(env.paths.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].plugins).toEqual([{ packageName: 'gamma', enabled: true }])
  })

  it('creates a pack from an installed preset even without a source receipt', async () => {
    const env = await fixture()
    const presetDir = path.join(env.paths.dshHome, '.agent-presets', 'my-preset')
    await mkdir(presetDir, { recursive: true })
    await writeFile(path.join(presetDir, 'preset.yml'), 'name: my-preset\n', 'utf8')

    const result = await env.manager.createPack({ name: 'Offline Preset', packageNames: [], presetNames: ['my-preset'] })
    expect(result.installed).toEqual(['my-preset'])
    expect(result.failures).toEqual([])
    const records = await readPackRegistry(env.paths.registryPath)
    expect(records[0].presets).toEqual([{ name: 'my-preset', enabled: true }])
  })

  it('exports plugins and presets without receipts as offline local bodies', async () => {
    const env = await fixture()
    const dshHome = env.paths.dshHome
    const profileDir = path.join(dshHome, 'profiles', 'web')
    const pluginDir = path.join(profileDir, 'node_modules', 'gamma')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'gamma', version: '1.0.0' }), 'utf8')
    const presetDir = path.join(dshHome, '.agent-presets', 'my-preset')
    await mkdir(presetDir, { recursive: true })
    await writeFile(path.join(presetDir, 'preset.yml'), 'name: my-preset\n', 'utf8')
    await upsertPackRecord(env.paths.registryPath, {
      ...record('pack-local', [
        { packageName: 'gamma', enabled: true },
      ]),
      presets: [{ name: 'my-preset', enabled: true }],
    })

    const { zipPath } = await env.manager.exportPack('pack-local')
    const inspection = inspectPackZip(await readFile(zipPath))
    expect(inspection.manifest.plugins).toContainEqual({ packageName: 'gamma', source: 'local', version: '1.0.0', enabled: true })
    expect(inspection.manifest.presets).toContainEqual({ name: 'my-preset' })
    expect(inspection.bodyPackageNames).toEqual(['gamma'])
    expect(inspection.presetBodyNames).toEqual(['my-preset'])
  })

  it('activates in the shared Profile, applies manifest order, and restores the baseline', async () => {
    const env = await fixture()
    await upsertPackRecord(env.paths.registryPath, record('pack-a', [
      { packageName: 'beta', enabled: true },
      { packageName: 'alpha', enabled: false },
    ]))
    await upsertPackRecord(env.paths.registryPath, record('pack-b', [
      { packageName: 'gamma', enabled: true },
    ]))

    const activated = await env.manager.activatePack('pack-a')
    expect(activated.profileName).toBe('web')
    expect(activated.activePackId).toBe('pack-a')
    expect(env.getProfile().activeBundles).toEqual(['core', 'beta'])

    await env.manager.activatePack('pack-b')
    expect(env.getSettings().activePackId).toBe('pack-b')
    expect(env.getProfile().activeBundles).toEqual(['core', 'gamma'])

    await env.manager.deactivatePack()
    expect(env.getSettings().activePackId).toBeNull()
    expect(env.getProfile().activeBundles).toEqual(['core', 'alpha', 'beta', 'gamma'])
  })

  it('edits inactive packs without changing the active shared Profile', async () => {
    const env = await fixture()
    await upsertPackRecord(env.paths.registryPath, record('pack-a', [{ packageName: 'alpha', enabled: true }]))
    await upsertPackRecord(env.paths.registryPath, record('pack-b', [{ packageName: 'beta', enabled: true }]))
    await env.manager.activatePack('pack-a')
    const before = env.getProfile().activeBundles
    await env.manager.togglePackItem('pack-b', 'beta', false)
    expect(env.getProfile().activeBundles).toEqual(before)
    expect(env.installer.togglePlugin).toHaveBeenCalledTimes(2)
  })

  it('imports a YAML manifest into the shared Profile', async () => {
    const env = await fixture()
    const manifestPath = path.join(env.paths.manifestRoot, 'incoming.yaml')
    await mkdir(env.paths.manifestRoot, { recursive: true })
    await writeFile(manifestPath, [
      'name: Incoming Pack',
      'description: A shared profile manifest',
      'version: 1.0.0',
      'dshVersion: 0.1.0-rc.7',
      'plugins:',
      '  - packageName: alpha',
      '    source: npm',
      '    enabled: true',
    ].join('\n'), 'utf8')
    const result = await env.manager.importPack(manifestPath)
    expect(result.state).toBe('complete')
    expect(env.installer.installPluginTarget).toHaveBeenCalledWith(expect.objectContaining({ profileName: 'web', packageName: 'alpha' }))
    await expect(readFile(path.join(env.paths.manifestRoot, 'pack-incoming-pack.yaml'), 'utf8')).resolves.toContain('alpha')
  })
})
