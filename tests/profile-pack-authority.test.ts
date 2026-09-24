import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import type { AppSettings, PackManifest } from '../src/types'
import { createPackManager, type InstallInstaller, type PackInstallTarget } from '../electron/pack'
import { serializePackManifest } from '../electron/pack-manifest'
import { writePackManifest } from '../electron/pack-manifest-store'
import { upsertPackRecord } from '../electron/pack-registry'
import { buildPackZip, inspectPackZip } from '../electron/pack-zip'
import { recordPluginInstall } from '../electron/plugin-receipts'
import { readProfile, removePluginFromProfile, reorderPlugins, togglePlugin } from '../electron/profile'
import { readProfileMetadata, writeProfileMetadata } from '../electron/profile-service'
import { defaultSettings } from '../electron/settings'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface ProfilePackage {
  name: string
  private: boolean
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}

async function writePlugin(directory: string, packageName: string, version = '1.0.0') {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    dsh: { bundle: { patch: 'bundle.yaml' } },
  }))
  await writeFile(path.join(directory, 'bundle.yaml'), '{}\n')
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-profile-pack-authority-'))
  roots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  const paths = {
    dshHome,
    registryPath: path.join(root, 'packs.json'),
    manifestRoot: path.join(root, 'pack-manifests'),
    snapshotRoot: path.join(root, 'snapshots'),
    pluginReceiptsPath: path.join(root, 'plugin-receipts.json'),
    presetReceiptsPath: path.join(root, 'preset-receipts.json'),
    skillReceiptsPath: path.join(root, 'skill-receipts.json'),
  }
  let settings: AppSettings = {
    ...defaultSettings({ homeDirectory: root, documentsDirectory: root }),
    dshHome,
    dshVersion: '0.1.0-rc.7',
    profileName: 'web',
    activePackId: null,
  }
  const packagePath = (profileName: string) => path.join(dshHome, 'profiles', profileName, 'package.json')
  const readPackage = async (profileName: string): Promise<ProfilePackage> => JSON.parse(await readFile(packagePath(profileName), 'utf8'))
  const writeProfile = async (profileName: string, dependencies: Record<string, string>, bundles: string[]) => {
    await mkdir(path.dirname(packagePath(profileName)), { recursive: true })
    await writeFile(packagePath(profileName), JSON.stringify({ name: `profile-${profileName}`, private: true, dependencies, dsh: { profile: { bundles } } }))
    for (const [packageName, version] of Object.entries(dependencies)) {
      await writePlugin(path.join(dshHome, 'profiles', profileName, 'node_modules', ...packageName.split('/')), packageName, version)
    }
    await writeProfileMetadata(dshHome, profileName, { description: `${profileName} metadata`, dshVersion: '0.1.0-rc.7', source: { kind: 'local' } })
  }
  const receipt = async (profileName: string, packageName: string, version = '1.0.0') => {
    await recordPluginInstall(paths.pluginReceiptsPath, {
      repository: `npm:${packageName}`, packageName, profileName, source: 'npm', subdirectory: null,
      version, commit: '', installedAt: '2026-09-01T00:00:00.000Z',
    })
  }
  const beforeInstall: Array<{ profileName: string; dependencies: Record<string, string> }> = []
  const install = async (packageName: string, profileName: string, version: string) => {
    const manifest = await readPackage(profileName)
    beforeInstall.push({ profileName, dependencies: { ...manifest.dependencies } })
    manifest.dependencies = { ...manifest.dependencies, [packageName]: version }
    if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
    await writeFile(packagePath(profileName), JSON.stringify(manifest))
    await writePlugin(path.join(dshHome, 'profiles', profileName, 'node_modules', ...packageName.split('/')), packageName, version)
    await receipt(profileName, packageName, version)
  }
  const installer: InstallInstaller = {
    installPluginTarget: vi.fn(async (target: PackInstallTarget, profileOverride?: string) => {
      await install(target.packageName, profileOverride ?? target.profileName, target.version ?? '1.0.0')
    }),
    installNpmPackage: vi.fn(async (request, profileOverride) => {
      await install(request.packageName, profileOverride ?? settings.profileName, request.version ?? '1.0.0')
    }),
    readProfile: (home, name) => readProfile(home, name, paths.pluginReceiptsPath),
    togglePlugin: (home, name, packageName, enabled) => togglePlugin(home, name, packageName, enabled, paths.pluginReceiptsPath),
    reorderPlugins: (home, name, packages) => reorderPlugins(home, name, packages, paths.pluginReceiptsPath),
    installSkillLocal: async () => undefined,
    installSkill: async () => ({ installedSkill: {} as never, installedSkills: [] }),
    installSkillPinned: async () => ({} as never),
    toggleSkill: async () => [],
    installPreset: async () => ({ installedPreset: {} as never, installedPresets: [] }),
    installPresetLocal: async () => undefined,
    togglePreset: async () => [],
    remove: vi.fn(async (packageName, profileName) => removePluginFromProfile(dshHome, profileName ?? settings.profileName, packageName)),
  }
  const manager = createPackManager({
    ...paths,
    readSettings: async () => settings,
    saveSettings: async next => { settings = next; return settings },
    installer,
    applicationAddons: { list: async () => [], install: async () => undefined, uninstall: async () => [] },
    emitEvent: () => undefined,
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
  })
  await writeProfile('web', {}, [])
  return { root, paths, manager, installer, writeProfile, readPackage, receipt, beforeInstall, getSettings: () => settings }
}

const incoming: PackManifest = {
  name: 'Incoming', description: 'Imported Profile', version: '2.0.0', dshVersion: '0.1.0-rc.7',
  plugins: [{ packageName: 'incoming-plugin', source: 'npm', version: '1.0.0', enabled: false }],
}

describe('unified Profile is the pack configuration authority', () => {
  it('ignores conflicting and deleted legacy pack records when listing and exporting', async () => {
    const env = await fixture()
    await env.writeProfile('web', { alpha: '1.0.0' }, ['alpha'])
    await env.receipt('web', 'alpha')
    const stale = {
      id: 'web', name: 'Stale label', description: 'Stale description', version: '0.0.1', dshVersion: '0.0.1-rc.1',
      source: 'created' as const, installedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
      state: 'complete' as const, plugins: [{ packageName: 'stale-plugin', enabled: true }],
    }
    await upsertPackRecord(env.paths.registryPath, stale)
    await upsertPackRecord(env.paths.registryPath, { ...stale, id: 'pack-deleted' })
    await writePackManifest(env.paths.manifestRoot, 'web', { ...incoming, name: 'Stale label', plugins: [{ packageName: 'stale-plugin', source: 'npm', version: '1.0.0' }] })
    const legacyBefore = await readFile(env.paths.registryPath, 'utf8')

    const packs = await env.manager.listPacks()
    expect(packs.map(pack => pack.id)).toEqual(['web'])
    expect(packs[0]).toMatchObject({ description: 'web metadata', dshVersion: '0.1.0-rc.7', plugins: [{ packageName: 'alpha', enabled: true }] })
    const { zipPath } = await env.manager.exportPack('web')
    const exported = inspectPackZip(await readFile(zipPath)).manifest
    expect(exported.plugins.map(plugin => plugin.packageName)).toEqual(['alpha'])
    expect(exported.dshVersion).toBe('0.1.0-rc.7')
    expect(exported.name).not.toBe('Stale label')
    await expect(readFile(env.paths.registryPath, 'utf8')).resolves.toBe(legacyBefore)
  })

  it('exports current dependencies and activation order without exporting sibling-only inventory', async () => {
    const env = await fixture()
    await env.writeProfile('web', { alpha: '1.0.0', beta: '1.0.0', disabled: '1.0.0' }, ['beta', 'alpha'])
    await env.writeProfile('desktop', { sibling: '1.0.0' }, ['sibling'])
    for (const packageName of ['disabled', 'alpha', 'beta']) await env.receipt('web', packageName)
    await env.receipt('desktop', 'sibling')
    const inventory = await readProfile(env.paths.dshHome, 'web', env.paths.pluginReceiptsPath)
    expect(inventory.plugins.some(plugin => plugin.packageName === 'sibling')).toBe(true)

    const { zipPath } = await env.manager.exportPack('web')
    const exported = inspectPackZip(await readFile(zipPath)).manifest.plugins
    expect(exported.map(plugin => [plugin.packageName, plugin.enabled])).toEqual([
      ['beta', true], ['alpha', true], ['disabled', false],
    ])
    await expect(access(env.paths.registryPath)).rejects.toThrow()
    await expect(access(env.paths.manifestRoot)).rejects.toThrow()
  })

  it('keeps mixed receipt/body order and disabled state when an unpinned Git source becomes a local body', async () => {
    const env = await fixture()
    await env.writeProfile('web', {
      'local-first': '1.0.0', 'remote-next': '1.0.0', 'local-last': '1.0.0', 'unpinned-disabled': '1.0.0',
    }, ['local-first', 'remote-next', 'local-last'])
    const profileManifest = await env.readPackage('web')
    for (const packageName of ['local-first', 'local-last']) {
      profileManifest.dependencies[packageName] = `file:${path.join(env.paths.dshHome, 'profiles', 'web', 'node_modules', packageName).replace(/\\/g, '/')}`
    }
    profileManifest.dependencies['unpinned-disabled'] = 'github:demo/unpinned#main'
    await writeFile(path.join(env.paths.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify(profileManifest))
    await env.receipt('web', 'remote-next')
    await recordPluginInstall(env.paths.pluginReceiptsPath, {
      repository: 'demo/unpinned', packageName: 'unpinned-disabled', profileName: 'web',
      source: 'github', subdirectory: null, version: '1.0.0', commit: '', installedAt: '2026-09-01T00:00:00.000Z',
    })

    const { zipPath } = await env.manager.exportPack('web')
    const exported = inspectPackZip(await readFile(zipPath))
    expect(exported.manifest.plugins.map(plugin => [plugin.packageName, plugin.source, plugin.enabled])).toEqual([
      ['local-first', 'local', true],
      ['remote-next', 'npm', true],
      ['local-last', 'local', true],
      ['unpinned-disabled', 'local', false],
    ])
    expect(exported.bodyPackageNames.sort()).toEqual(['local-first', 'local-last', 'unpinned-disabled'])
  })

  it.each(['npm', 'github'] as const)('exports the exact Profile npm pin instead of a stale %s receipt', async source => {
    const env = await fixture()
    await env.writeProfile('web', { alpha: '2.1.0' }, ['alpha'])
    await recordPluginInstall(env.paths.pluginReceiptsPath, {
      repository: source === 'npm' ? 'npm:alpha' : 'old/alpha', packageName: 'alpha', profileName: 'web',
      source, subdirectory: source === 'github' ? 'packages/alpha' : null, version: '0.5.0',
      commit: source === 'github' ? 'a'.repeat(40) : '', installedAt: '2020-01-01T00:00:00.000Z',
    })

    const { zipPath } = await env.manager.exportPack('web')
    const exported = inspectPackZip(await readFile(zipPath))
    expect(exported.manifest.plugins).toEqual([{ packageName: 'alpha', source: 'npm', version: '2.1.0', enabled: true }])
    expect(exported.bodyPackageNames).toEqual([])
  })

  it.each(['add', 'enable', 'disable', 'remove'] as const)('applies %s to the non-current Profile without changing sibling Profiles', async operation => {
    const env = await fixture()
    await env.writeProfile('web', { alpha: '1.0.0' }, ['alpha'])
    await env.writeProfile('sibling', { alpha: '1.0.0' }, ['alpha'])
    await env.writeProfile('desktop', operation === 'add' ? { beta: '1.0.0' } : { alpha: '1.0.0', beta: '1.0.0' }, operation === 'add' || operation === 'enable' ? ['beta'] : ['beta', 'alpha'])
    await env.receipt('web', 'alpha')
    await env.receipt('sibling', 'alpha')
    const currentBefore = await env.readPackage('web')
    const siblingBefore = await env.readPackage('sibling')

    const result = operation === 'add'
      ? await env.manager.addPackPlugin('desktop', 'alpha')
      : operation === 'remove'
        ? await env.manager.removePackItem('desktop', 'alpha')
        : await env.manager.togglePackItem('desktop', 'alpha', operation === 'enable')
    const target = await env.readPackage('desktop')
    if (operation === 'add' || operation === 'enable') {
      expect(target.dsh.profile.bundles).toContain('alpha')
      expect(target.dependencies).toHaveProperty('alpha')
      expect(result.plugins).toContainEqual(expect.objectContaining({ packageName: 'alpha', enabled: true }))
    } else {
      expect(target.dsh.profile.bundles).not.toContain('alpha')
      if (operation === 'disable') {
        expect(target.dependencies).toHaveProperty('alpha')
        expect(result.plugins).toContainEqual(expect.objectContaining({ packageName: 'alpha', enabled: false }))
      } else {
        expect(target.dependencies).not.toHaveProperty('alpha')
        expect(result.plugins.some(plugin => plugin.packageName === 'alpha')).toBe(false)
      }
    }
    expect(target.dsh.profile.bundles).toContain('beta')
    await expect(env.readPackage('web')).resolves.toEqual(currentBefore)
    await expect(env.readPackage('sibling')).resolves.toEqual(siblingBefore)
    expect(env.getSettings().profileName).toBe('web')
    await expect(access(path.join(env.paths.dshHome, 'profiles', 'web', 'node_modules', 'alpha', 'package.json'))).resolves.toBeUndefined()
    await expect(access(path.join(env.paths.dshHome, 'profiles', 'sibling', 'node_modules', 'alpha', 'package.json'))).resolves.toBeUndefined()
    await expect(access(env.paths.registryPath)).rejects.toThrow()
    await expect(access(env.paths.manifestRoot)).rejects.toThrow()
  })

  it('imports standard YAML from empty dependencies and persists only Profile metadata', async () => {
    const env = await fixture()
    await env.writeProfile('web', { unrelated: '1.0.0' }, ['unrelated'])
    const selectedBefore = await env.readPackage('web')
    const filePath = path.join(env.root, 'incoming.yaml')
    await writeFile(filePath, serializePackManifest(incoming))

    const result = await env.manager.importPack(filePath)
    expect(result.state).toBe('complete')
    expect(result.installed).toEqual(['incoming-plugin'])
    expect(env.beforeInstall[0].dependencies).toEqual({})
    const imported = await env.readPackage(result.id)
    expect(imported.dependencies).toEqual({ 'incoming-plugin': '1.0.0' })
    expect(imported.dsh.profile.bundles).not.toContain('incoming-plugin')
    expect(imported.dsh.profile.bundles).not.toContain('unrelated')
    await expect(env.readPackage('web')).resolves.toEqual(selectedBefore)
    expect(env.getSettings().profileName).toBe('web')
    const metadata = await readProfileMetadata(env.paths.dshHome, result.id)
    expect(metadata).toMatchObject({ description: incoming.description, dshVersion: incoming.dshVersion, importState: 'complete' })
    const persisted = parse(await readFile(path.join(env.paths.dshHome, 'profiles', result.id, 'profile.yaml'), 'utf8'))
    expect(persisted).toMatchObject({ packName: incoming.name, version: incoming.version })
    await expect(access(env.paths.registryPath)).rejects.toThrow()
    await expect(access(env.paths.manifestRoot)).rejects.toThrow()
  })

  it.each(['yaml', 'zip'] as const)('snapshots the original Profile before a clean %s overwrite and restores it on rollback', async format => {
    const env = await fixture()
    await env.writeProfile('web', { current: '1.0.0' }, ['current'])
    await env.writeProfile('pack-incoming', { unwanted: '1.0.0' }, ['unwanted'])
    await writeProfileMetadata(env.paths.dshHome, 'pack-incoming', {
      packName: 'Original title', description: 'Original description', version: '8.0.0',
      dshVersion: '0.0.1-rc.1', source: { kind: 'github', repository: 'original/profile', branch: 'old', commit: 'a'.repeat(40) },
      importState: 'partial', importFailures: ['old failure'],
    })
    const targetDirectory = path.join(env.paths.dshHome, 'profiles', 'pack-incoming')
    const packageBefore = await readFile(path.join(targetDirectory, 'package.json'), 'utf8')
    const metadataBefore = await readFile(path.join(targetDirectory, 'profile.yaml'), 'utf8')
    const currentBefore = await env.readPackage('web')
    const filePath = path.join(env.root, `overwrite.${format}`)
    await writeFile(filePath, format === 'yaml' ? serializePackManifest(incoming) : buildPackZip(incoming, new Map()))

    const result = await env.manager.importPack(filePath, undefined, { overwrite: true })
    expect(result.id).toBe('pack-incoming')
    expect(result.state).toBe('complete')
    expect(env.beforeInstall[0].dependencies).toEqual({})
    expect((await env.readPackage(result.id)).dependencies).toEqual({ 'incoming-plugin': '1.0.0' })
    expect(await env.manager.hasSnapshot()).toBe(true)
    const rollback = await env.manager.rollback()
    expect(rollback.profileName).toBe('pack-incoming')
    await expect(readFile(path.join(targetDirectory, 'package.json'), 'utf8')).resolves.toBe(packageBefore)
    await expect(readFile(path.join(targetDirectory, 'profile.yaml'), 'utf8')).resolves.toBe(metadataBefore)
    await expect(env.readPackage('web')).resolves.toEqual(currentBefore)
    expect(env.getSettings().profileName).toBe('web')
    await expect(access(env.paths.registryPath)).rejects.toThrow()
    await expect(access(env.paths.manifestRoot)).rejects.toThrow()
  })

  it('creates a Profile from only selected shared plugins while preserving disabled state', async () => {
    const env = await fixture()
    await env.writeProfile('web', { enabled: '1.0.0', disabled: '1.0.0', unselected: '1.0.0' }, ['enabled', 'unselected'])
    await env.writeProfile('desktop', { shared: '1.0.0', 'sibling-unselected': '1.0.0' }, ['shared', 'sibling-unselected'])
    const currentBefore = await env.readPackage('web')
    const siblingBefore = await env.readPackage('desktop')

    const result = await env.manager.createPack({ name: 'Selected', packageNames: ['disabled', 'enabled', 'shared'] })
    expect(result.state).toBe('complete')
    expect(result.installed).toEqual(['disabled', 'enabled', 'shared'])
    const created = await env.readPackage(result.id)
    expect(Object.keys(created.dependencies).sort()).toEqual(['disabled', 'enabled', 'shared'])
    expect(created.dsh.profile.bundles).toContain('enabled')
    expect(created.dsh.profile.bundles).not.toContain('disabled')
    expect(created.dsh.profile.bundles).not.toContain('shared')
    expect(created.dsh.profile.bundles).not.toContain('unselected')
    await expect(env.readPackage('web')).resolves.toEqual(currentBefore)
    await expect(env.readPackage('desktop')).resolves.toEqual(siblingBefore)
    expect(env.installer.installNpmPackage).not.toHaveBeenCalled()
    expect(env.installer.installPluginTarget).not.toHaveBeenCalled()
    expect(env.getSettings().profileName).toBe('web')
    await expect(access(env.paths.registryPath)).rejects.toThrow()
    await expect(access(env.paths.manifestRoot)).rejects.toThrow()
  })

  it.each(['preview selection', 'default selection'] as const)('imports mixed lightweight ZIP bodies and remote plugins with %s', async selection => {
    const env = await fixture()
    const body = path.join(env.root, 'local-body')
    await writePlugin(body, 'local-plugin')
    const manifest: PackManifest = {
      ...incoming, name: 'Mixed',
      plugins: [
        { packageName: 'remote-plugin', source: 'npm', version: '1.0.0', enabled: true },
        { packageName: 'local-plugin', source: 'local', version: '1.0.0', enabled: false },
      ],
    }
    const filePath = path.join(env.root, 'mixed.zip')
    await writeFile(filePath, buildPackZip(manifest, new Map([['local-plugin', body]])))

    const preview = await env.manager.analyzeImport(filePath)
    expect(preview.items.map(item => [item.packageName, item.offline, item.available])).toEqual([
      ['remote-plugin', false, true], ['local-plugin', true, true],
    ])
    const selected = selection === 'preview selection'
      ? preview.items.filter(item => item.available).map(item => item.packageName)
      : undefined
    const result = await env.manager.importPack(filePath, selected)
    expect(result.state).toBe('complete')
    expect(result.installed).toEqual(['remote-plugin', 'local-plugin'])
    expect(env.installer.installNpmPackage).toHaveBeenCalledWith(expect.objectContaining({ packageName: 'remote-plugin', version: '1.0.0' }), result.id)
    expect(env.installer.installPluginTarget).toHaveBeenCalledWith(expect.objectContaining({ packageName: 'local-plugin', source: 'local-directory' }), result.id)
    const imported = await env.readPackage(result.id)
    expect(imported.dsh.profile.bundles).toContain('remote-plugin')
    expect(imported.dsh.profile.bundles).not.toContain('local-plugin')
    await expect(access(env.paths.registryPath)).rejects.toThrow()
    await expect(access(env.paths.manifestRoot)).rejects.toThrow()
  })
})
