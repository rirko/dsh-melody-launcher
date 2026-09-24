import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consolidatePluginPool, createProfile, createProfileService, deleteProfile, ensureProfileCoreBundles, listProfiles, migrateLegacyPacks, readProfileMetadata, switchProfile, writeProfileMetadata } from '../electron/profile-service'
import { defaultSettings } from '../electron/settings'
import { readPackRegistry, upsertPackRecord } from '../electron/pack-registry'
import { readPluginReceipts, recordPluginInstall } from '../electron/plugin-receipts'
import { writePackManifest } from '../electron/pack-manifest-store'
import { readProfile, togglePlugin } from '../electron/profile'
import type { AppSettings } from '../src/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-profile-service-'))
  roots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  await writeFile(path.join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
  let settings: AppSettings = { ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }), dshHome, profileName: 'web' }
  const options = {
    dshHome,
    readSettings: async () => settings,
    saveSettings: async (next: AppSettings) => { settings = next; return settings },
    registryPath: path.join(root, 'packs.json'),
    manifestRoot: path.join(root, 'pack-manifests'),
    isRuntimeRunning: () => false,
  }
  return { root, dshHome, options, getSettings: () => settings }
}

describe('Profile service', () => {
  it('excludes dependency folders even with legacy Profile metadata or a stored selection', async () => {
    const env = await fixture()
    const dependencyDir = path.join(env.dshHome, 'profiles', 'node_modules')
    await mkdir(dependencyDir)
    await listProfiles(env.options)
    await expect(access(path.join(dependencyDir, 'profile.yaml'))).rejects.toThrow()
    const legacyMetadata = 'name: node_modules\nsource:\n  kind: local\n'
    await writeFile(path.join(dependencyDir, 'profile.yaml'), legacyMetadata)
    await env.options.saveSettings({ ...env.getSettings(), profileName: 'node_modules' })
    expect((await listProfiles(env.options)).map(item => item.id)).toEqual(['web'])
    await expect(readFile(path.join(dependencyDir, 'profile.yaml'), 'utf8')).resolves.toBe(legacyMetadata)
  })

  it('blocks creating, switching, cloning and deleting dependency directories without touching their contents', async () => {
    const env = await fixture()
    const dependencyDir = path.join(env.dshHome, 'profiles', 'node_modules')
    await mkdir(dependencyDir)
    const sentinel = path.join(dependencyDir, 'keep.txt')
    await writeFile(sentinel, 'dependency data')
    const service = createProfileService(env.options)
    await expect(service.create({ name: 'node_modules' })).rejects.toThrow(/node_modules/)
    await expect(service.switch('node_modules')).rejects.toThrow(/node_modules/)
    await expect(service.clone('web', 'NODE_MODULES')).rejects.toThrow(/node_modules/)
    await expect(service.remove('node_modules')).rejects.toThrow(/node_modules/)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('dependency data')
  })

  it('creates, clones, lists, switches and deletes independent Profile directories', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha', description: 'Alpha', dshVersion: '0.1.0-rc.7' })
    await createProfile(env.options, { name: 'beta', cloneFrom: 'alpha' })
    const profiles = await listProfiles(env.options)
    expect(profiles.map(item => item.id)).toEqual(['alpha', 'beta', 'web'])
    expect(profiles.find(item => item.id === 'alpha')?.selected).toBe(false)
    await switchProfile(env.options, 'alpha')
    expect(env.getSettings().profileName).toBe('alpha')
    expect(env.getSettings().dshVersion).toBe('0.1.0-rc.7')
    await deleteProfile(env.options, 'beta')
    expect((await listProfiles(env.options)).some(item => item.id === 'beta')).toBe(false)
  })

  it('migrates legacy pack records to profile metadata and backs up registry files', async () => {
    const env = await fixture()
    env.options = { ...env.options, dshHome: env.dshHome }
    await upsertPackRecord(env.options.registryPath, {
      id: 'pack-alpha', name: 'Alpha', description: 'legacy', version: '1.0.0', dshVersion: '0.1.0-rc.7', source: 'created',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'complete', plugins: [],
    })
    const result = await migrateLegacyPacks(env.options)
    expect(result.migrated).toBe(1)
    expect(result.backupPath).toContain('.legacy.bak')
    await expect(readFile(path.join(env.dshHome, 'profiles', 'pack-alpha', 'profile.yaml'), 'utf8')).resolves.toContain('0.1.0-rc.7')
  })

  it('migrates manifest-only legacy packs when packs.json is absent', async () => {
    const env = await fixture()
    const manifestRoot = path.join(env.root, 'pack-manifests')
    await writePackManifest(manifestRoot, 'pack-legacy', {
      name: 'Legacy', description: 'from yaml', version: '1.0.0', dshVersion: '0.1.0-rc.7',
      plugins: [{ packageName: '@demo/plugin', source: 'npm', version: '1.0.0', enabled: true }],
    })
    const result = await migrateLegacyPacks({ ...env.options, registryPath: path.join(env.root, 'missing-packs.json'), manifestRoot })
    expect(result.migrated).toBe(1)
    await expect(readFile(path.join(env.dshHome, 'profiles', 'pack-legacy', 'package.json'), 'utf8')).resolves.toContain('@demo/plugin')
    await expect(access(`${manifestRoot}.legacy.bak`)).resolves.toBeUndefined()
  })

  it('preserves authoritative Profile fields while migrating previously untracked resources', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha', description: 'current description', dshVersion: '0.2.0' })
    await writeProfileMetadata(env.dshHome, 'alpha', {
      version: '2.0.0', source: { kind: 'github', repository: 'current/repo', commit: 'current-commit' },
      importState: 'complete', importFailures: [],
    })
    const manifestPath = path.join(env.dshHome, 'profiles', 'alpha', 'package.json')
    const originalManifest = await readFile(manifestPath, 'utf8')
    const originalMetadata = await readProfileMetadata(env.dshHome, 'alpha')
    await upsertPackRecord(env.options.registryPath, {
      id: 'alpha', name: 'Legacy Alpha', description: 'stale', version: '1.0.0', dshVersion: '0.1.0', source: 'manifest',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'failed',
      plugins: [{ packageName: '@legacy/plugin', enabled: true }],
      failures: [{ packageName: '@legacy/plugin', reason: 'old failure' }],
      presets: [{ name: 'agent', enabled: false }], skills: [{ name: 'writer', format: 'flat', enabled: true }],
      applications: [{ id: 'desktop', name: 'Desktop', enabled: false }],
    })
    await migrateLegacyPacks(env.options)
    expect(await readProfileMetadata(env.dshHome, 'alpha')).toMatchObject({
      ...originalMetadata,
      packName: 'Legacy Alpha',
      resources: {
        presets: [{ name: 'agent', enabled: false }], skills: [{ name: 'writer', format: 'flat', enabled: true }],
        applications: [{ id: 'desktop', name: 'Desktop', enabled: false }],
      },
    })
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(originalManifest)
  })

  it('retains existing Profile resource ownership rather than replaying legacy resources', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    await writeProfileMetadata(env.dshHome, 'alpha', {
      version: '2.0.0', packName: 'Current', importState: 'complete', importFailures: [],
      resources: { skills: [], presets: [], applications: [] },
    })
    const metadataPath = path.join(env.dshHome, 'profiles', 'alpha', 'profile.yaml')
    const before = await readFile(metadataPath, 'utf8')
    await upsertPackRecord(env.options.registryPath, {
      id: 'alpha', name: 'Stale', description: 'old', version: '1.0.0', source: 'manifest',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'complete', plugins: [],
      skills: [{ name: 'deleted-skill', format: 'flat', enabled: true }],
    })
    expect((await migrateLegacyPacks(env.options)).migrated).toBe(0)
    await expect(readFile(metadataPath, 'utf8')).resolves.toBe(before)
  })

  it('archives repeated legacy files without recreating a previously deleted Profile', async () => {
    const env = await fixture()
    const record = {
      id: 'alpha', name: 'Alpha', description: 'legacy', version: '1.0.0', source: 'manifest' as const,
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'partial' as const,
      plugins: [], failures: [{ packageName: '@demo/plugin', reason: 'missing' }],
      skills: [{ name: 'writer', format: 'flat' as const, enabled: true }],
    }
    await upsertPackRecord(env.options.registryPath, record)
    await writePackManifest(env.options.manifestRoot, 'alpha', { name: 'Alpha', description: '', version: '1.0.0', plugins: [] })
    await migrateLegacyPacks(env.options)
    expect(await readProfileMetadata(env.dshHome, 'alpha')).toMatchObject({
      version: '1.0.0', importState: 'partial', importFailures: ['@demo/plugin: missing'],
      resources: { skills: [{ name: 'writer', format: 'flat', enabled: true }] },
    })
    await deleteProfile(env.options, 'alpha')
    await upsertPackRecord(env.options.registryPath, record)
    await writePackManifest(env.options.manifestRoot, 'alpha', { name: 'Alpha', description: '', version: '1.0.0', plugins: [] })
    const result = await migrateLegacyPacks(env.options)
    expect(result).toEqual({ migrated: 0, backupPath: `${env.options.registryPath}.legacy.bak.1` })
    await expect(access(`${env.options.registryPath}.legacy.bak`)).resolves.toBeUndefined()
    await expect(access(`${env.options.manifestRoot}.legacy.bak.1`)).resolves.toBeUndefined()
    await expect(access(env.options.registryPath)).rejects.toThrow()
    await expect(access(env.options.manifestRoot)).rejects.toThrow()
    await expect(access(path.join(env.dshHome, 'profiles', 'alpha'))).rejects.toThrow()
    expect(await migrateLegacyPacks(env.options)).toEqual({ migrated: 0, backupPath: null })
  })

  it('preserves Profile resource and export metadata across updates and clones', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    await writeProfileMetadata(env.dshHome, 'alpha', {
      version: '3.0.0', resources: { skills: [{ name: 'writer', format: 'bundle', enabled: false }] },
      source: { kind: 'github', repository: 'author/source', commit: 'origin' },
      exportRepository: { repository: 'user/export', branch: 'main' },
    })
    await writeProfileMetadata(env.dshHome, 'alpha', { description: 'updated' })
    const metadata = await readProfileMetadata(env.dshHome, 'alpha')
    expect(metadata).toMatchObject({ version: '3.0.0', exportRepository: { repository: 'user/export', branch: 'main' } })
    await createProfile(env.options, { name: 'beta', cloneFrom: 'alpha' })
    const clone = await readProfileMetadata(env.dshHome, 'beta')
    expect(clone.resources).toEqual(metadata.resources)
    expect(clone.version).toBe('3.0.0')
    expect(clone.exportRepository).toBeUndefined()
  })

  it('migrates registry and manifest-only Profiles together without changing the selected Profile', async () => {
    const env = await fixture()
    await env.options.saveSettings({ ...env.getSettings(), activePackId: 'alpha' })
    await upsertPackRecord(env.options.registryPath, {
      id: 'alpha', name: 'Alpha', description: 'active legacy pack', version: '1.0.0', source: 'manifest',
      installedAt: '2025-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(), state: 'complete', plugins: [],
    })
    await writePackManifest(env.options.manifestRoot, 'beta', { name: 'Beta', description: 'manifest-only', version: '2.0.0', plugins: [] })
    expect((await migrateLegacyPacks(env.options)).migrated).toBe(2)
    expect(env.getSettings()).toMatchObject({ profileName: 'web', activePackId: null })
    expect(await readProfileMetadata(env.dshHome, 'web')).toMatchObject({ packName: 'Alpha', createdAt: '2025-01-01T00:00:00.000Z' })
    expect(await readProfileMetadata(env.dshHome, 'beta')).toMatchObject({ packName: 'Beta', version: '2.0.0' })
    await expect(access(path.join(env.dshHome, 'profiles', 'alpha'))).rejects.toThrow()
  })

  it('recovers old publishing destinations only for Profiles with a recorded export', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    await writeProfileMetadata(env.dshHome, 'alpha', {
      source: { kind: 'github', repository: 'author/source', branch: 'main' },
    })
    expect((await readProfileMetadata(env.dshHome, 'alpha')).exportRepository).toBeUndefined()
    await writeProfileMetadata(env.dshHome, 'alpha', { exportedAt: '2026-01-01T00:00:00.000Z' })
    expect((await readProfileMetadata(env.dshHome, 'alpha')).exportRepository).toEqual({ repository: 'author/source', branch: 'main' })
    await writeProfileMetadata(env.dshHome, 'alpha', { exportRepository: { repository: 'user/new-export' } })
    expect((await readProfileMetadata(env.dshHome, 'alpha')).exportRepository).toEqual({ repository: 'user/new-export' })
  })

  it('keeps complete metadata visible while atomic updates run', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha', dshVersion: '0.1.0' })
    await Promise.all([
      (async () => {
        for (let index = 0; index < 20; index += 1) await writeProfileMetadata(env.dshHome, 'alpha', { dshVersion: index % 2 ? '0.1.0' : '0.2.0' })
      })(),
      (async () => {
        for (let index = 0; index < 50; index += 1) expect(['0.1.0', '0.2.0']).toContain((await readProfileMetadata(env.dshHome, 'alpha')).dshVersion)
      })(),
    ])
    expect((await readdir(path.join(env.dshHome, 'profiles', 'alpha'))).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('removes temporary metadata after a failed atomic replacement without removing the target', async () => {
    const env = await fixture()
    const directory = path.join(env.dshHome, 'profiles', 'broken')
    const metadataDirectory = path.join(directory, 'profile.yaml')
    await mkdir(metadataDirectory, { recursive: true })
    await writeFile(path.join(metadataDirectory, 'keep.txt'), 'keep')
    await expect(writeProfileMetadata(env.dshHome, 'broken', { dshVersion: '0.1.0' })).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['profile.yaml'])
    await expect(readFile(path.join(metadataDirectory, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('blocks deleting the selected Profile', async () => {
    const env = await fixture()
    const service = createProfileService(env.options)
    await expect(service.remove('web')).rejects.toThrow('当前 Profile 不能删除')
  })

  it('requires explicit repair confirmation before switching to a Profile with missing links', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    const alphaPackage = path.join(env.dshHome, 'profiles', 'alpha', 'package.json')
    await writeFile(alphaPackage, JSON.stringify({
      name: 'dsh-profile-alpha',
      dependencies: { '@demo/plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@demo/plugin'] } },
    }), 'utf8')
    const service = createProfileService(env.options)
    await expect(service.switch('alpha')).rejects.toThrow('确认补齐依赖')
    await expect(service.switch('alpha', async missing => {
      expect(missing).toEqual(['@demo/plugin'])
      const manifest = path.join(env.dshHome, 'profiles', 'alpha', 'node_modules', '@demo', 'plugin', 'package.json')
      await mkdir(path.dirname(manifest), { recursive: true })
      await writeFile(manifest, JSON.stringify({ name: '@demo/plugin', version: '1.0.0' }), 'utf8')
    })).resolves.toMatchObject({ profileName: 'alpha' })
  })

  it('兄弟 Profile 已有插件时自动补当前 Profile 链接，不再报告缺失依赖', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    await writeFile(path.join(env.dshHome, 'profiles', 'alpha', 'package.json'), JSON.stringify({
      name: 'dsh-profile-alpha',
      dependencies: { '@demo/plugin': '1.0.0' },
      dsh: { profile: { bundles: [] } },
    }), 'utf8')
    const siblingPlugin = path.join(env.dshHome, 'profiles', 'web', 'node_modules', '@demo', 'plugin', 'package.json')
    await mkdir(path.dirname(siblingPlugin), { recursive: true })
    await writeFile(siblingPlugin, JSON.stringify({ name: '@demo/plugin', version: '1.0.0' }), 'utf8')
    const repairs: string[][] = []
    const service = createProfileService({
      ...env.options,
      fillMissingDependencies: async (_profileName, missing) => {
        repairs.push(missing)
        const target = path.join(env.dshHome, 'profiles', 'alpha', 'node_modules', '@demo', 'plugin', 'package.json')
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, JSON.stringify({ name: '@demo/plugin', version: '1.0.0' }), 'utf8')
      },
    })
    expect((await listProfiles({ ...env.options, fillMissingDependencies: async () => undefined })).find(item => item.id === 'alpha')?.missingDependencies).toEqual([])
    await service.switch('alpha')
    expect(repairs).toEqual([['@demo/plugin']])
  })

  it('cleans Profile-scoped receipts and offline bodies without touching the shared store', async () => {
    const env = await fixture()
    const receiptPath = path.join(env.root, 'receipts.json')
    const bodyRoot = path.join(env.dshHome, '.dsh-launcher-pack-bodies')
    const bodyFile = path.join(bodyRoot, 'alpha', 'index.js')
    await createProfile(env.options, { name: 'alpha' })
    await recordPluginInstall(receiptPath, {
      repository: 'demo/plugin', packageName: '@demo/plugin', profileName: 'alpha', source: 'github',
      subdirectory: null, version: '1.0.0', commit: 'abcdef1', installedAt: new Date().toISOString(),
    })
    await mkdir(path.dirname(bodyFile), { recursive: true })
    await writeFile(bodyFile, 'export {}\n', 'utf8')
    const sharedStore = path.join(env.root, 'plugin-store', 'keep.txt')
    await mkdir(path.dirname(sharedStore), { recursive: true })
    await writeFile(sharedStore, 'keep', 'utf8')
    const service = createProfileService({ ...env.options, pluginReceiptsPath: receiptPath, packBodiesRoot: bodyRoot })
    await service.remove('alpha')
    await expect(access(path.join(env.dshHome, 'profiles', 'alpha'))).rejects.toThrow()
    expect(await readPluginReceipts(receiptPath)).toEqual([])
    await expect(access(bodyFile)).rejects.toThrow()
    await expect(readFile(sharedStore, 'utf8')).resolves.toBe('keep')
  })

  it('归并旧整合包本体并让不同 Profile 指向同一共享来源', async () => {
    const env = await fixture()
    const legacyBody = path.join(env.dshHome, '.dsh-launcher-pack-bodies', 'pack-alpha', '@demo', 'plugin')
    await mkdir(legacyBody, { recursive: true })
    await writeFile(path.join(legacyBody, 'package.json'), JSON.stringify({ name: '@demo/plugin', version: '1.2.3' }), 'utf8')
    await createProfile(env.options, { name: 'alpha' })
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { '@demo/plugin': `file:${legacyBody}` },
      dsh: { profile: { bundles: ['@demo/plugin'] } },
    }), 'utf8')
    await writeFile(path.join(env.dshHome, 'profiles', 'alpha', 'package.json'), JSON.stringify({
      name: 'alpha',
      dependencies: { '@demo/plugin': '*' },
      dsh: { profile: { bundles: ['@demo/plugin'] } },
    }), 'utf8')

    const result = await consolidatePluginPool(env.dshHome)
    expect(result.dependencies).toBe(2)
    const shared = path.join(env.dshHome, '.dsh-launcher-plugin-bodies', '@demo', 'plugin', '1.2.3')
    await expect(access(path.join(shared, 'package.json'))).resolves.toBeUndefined()
    const web = JSON.parse(await readFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const alpha = JSON.parse(await readFile(path.join(env.dshHome, 'profiles', 'alpha', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(web.dependencies['@demo/plugin']).toBe(`file:${shared}`)
    expect(alpha.dependencies['@demo/plugin']).toBe(`file:${shared}`)
  })

  it('新 Profile 继承共享插件清单，且链接层尚未建立时仍能显示插件', async () => {
    const env = await fixture()
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { '@demo/plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@demo/plugin'] } },
    }), 'utf8')
    const webPlugin = path.join(env.dshHome, 'profiles', 'web', 'node_modules', '@demo', 'plugin', 'package.json')
    await mkdir(path.dirname(webPlugin), { recursive: true })
    await writeFile(webPlugin, JSON.stringify({ name: '@demo/plugin', version: '1.0.0', dsh: { bundle: { patch: 'package.json' } } }), 'utf8')

    await createProfile(env.options, { name: 'imported', empty: true })

    const importedManifest = JSON.parse(await readFile(path.join(env.dshHome, 'profiles', 'imported', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(importedManifest.dependencies?.['@demo/plugin']).toBeUndefined()
    const imported = await readProfile(env.dshHome, 'imported')
    expect(imported.plugins.find(plugin => plugin.packageName === '@demo/plugin')).toMatchObject({ version: '1.0.0', compatible: true, enabled: false, declaredInProfile: false })
  })

  it('未声明 Profile 可见共享插件但不报告缺失，启用时才写入来源', async () => {
    const env = await fixture()
    // The web Profile owns the dependency and its physical link. The desktop
    // Profile should see the shared inventory without inheriting the manifest.
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { '@demo/plugin': '1.0.0' },
      dsh: { profile: { bundles: [] } },
    }), 'utf8')
    const webPlugin = path.join(env.dshHome, 'profiles', 'web', 'node_modules', '@demo', 'plugin', 'package.json')
    await mkdir(path.dirname(webPlugin), { recursive: true })
    await writeFile(webPlugin, JSON.stringify({ name: '@demo/plugin', version: '1.0.0' }), 'utf8')

    await createProfile(env.options, { name: 'desktop', empty: true })

    const summaries = await listProfiles(env.options)
    const desktop = summaries.find(item => item.id === 'desktop')
    const profile = await readProfile(env.dshHome, 'desktop')
    expect(profile.plugins.find(plugin => plugin.packageName === '@demo/plugin')).toMatchObject({
      enabled: false,
      declaredInProfile: false,
    })
    expect(desktop?.missingDependencies).toEqual([])
    expect(desktop).toMatchObject({ pluginCount: 0, enabledPluginCount: 0, disabledPluginCount: 0 })
    expect(summaries.find(item => item.id === 'web')).toMatchObject({ pluginCount: 1, enabledPluginCount: 0, disabledPluginCount: 1 })

    await togglePlugin(env.dshHome, 'desktop', '@demo/plugin', true)
    const activatedManifest = JSON.parse(await readFile(path.join(env.dshHome, 'profiles', 'desktop', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(activatedManifest.dependencies?.['@demo/plugin']).toBe('1.0.0')
    expect((await listProfiles(env.options)).find(item => item.id === 'desktop')).toMatchObject({ pluginCount: 1, enabledPluginCount: 1, disabledPluginCount: 0 })
  })

  it('运行时核心包即使写入旧 Profile dependencies 也不计为缺失插件', async () => {
    const env = await fixture()
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { '@deepseek-ai/dsh-app-boot': '0.1.1-rc.1' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-app-boot'] } },
    }), 'utf8')

    const web = (await listProfiles(env.options)).find(item => item.id === 'web')
    expect(web?.pluginCount).toBe(0)
    expect(web?.missingDependencies).toEqual([])
  })

  it('当前 Profile 的 file 来源已存在时不报告缺失依赖', async () => {
    const env = await fixture()
    const source = path.join(env.root, 'plugin-source')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@demo/file-plugin', version: '1.0.0' }), 'utf8')
    await createProfile(env.options, { name: 'file-profile', empty: true })
    await writeFile(path.join(env.dshHome, 'profiles', 'file-profile', 'package.json'), JSON.stringify({
      name: 'file-profile',
      dependencies: { '@demo/file-plugin': `file:${source}` },
      dsh: { profile: { bundles: ['@demo/file-plugin'] } },
    }), 'utf8')

    const profile = (await listProfiles(env.options)).find(item => item.id === 'file-profile')
    expect(profile?.missingDependencies).toEqual([])
  })

  it('旧整合包共享本体目录存在时不报告缺失依赖', async () => {
    const env = await fixture()
    const body = path.join(env.dshHome, '.dsh-launcher-pack-bodies', 'legacy-pack', '@demo', 'plugin')
    await mkdir(body, { recursive: true })
    await writeFile(path.join(body, 'package.json'), JSON.stringify({ name: '@demo/plugin', version: '1.0.0' }), 'utf8')
    await createProfile(env.options, { name: 'legacy-profile', empty: true })
    await writeFile(path.join(env.dshHome, 'profiles', 'legacy-profile', 'package.json'), JSON.stringify({
      name: 'legacy-profile',
      dependencies: { '@demo/plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@demo/plugin'] } },
    }), 'utf8')

    const profile = (await listProfiles(env.options)).find(item => item.id === 'legacy-profile')
    expect(profile?.missingDependencies).toEqual([])
  })

  it('为旧 Profile 关闭 peer 自动安装并统一链接策略', async () => {
    const env = await fixture()
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8')
    await createProfile(env.options, { name: 'alpha' })

    await consolidatePluginPool(env.dshHome)

    const workspace = (await import('yaml')).parse(await readFile(path.join(env.dshHome, 'profiles', 'web', 'pnpm-workspace.yaml'), 'utf8')) as Record<string, unknown>
    expect(workspace.packages).toEqual(['.'])
    expect(workspace.nodeLinker).toBe('hoisted')
    expect(workspace.autoInstallPeers).toBe(false)
  })

  it('为每个 Profile 保留 DSH 核心 Bundle，但不把核心包写入插件依赖', async () => {
    const env = await fixture()
    const manifestPath = path.join(env.dshHome, 'profiles', 'web', 'package.json')
    await writeFile(manifestPath, JSON.stringify({
      name: 'web',
      dependencies: { '@demo/plugin': '1.0.0' },
      dsh: { profile: { bundles: ['@demo/plugin'] } },
    }), 'utf8')

    await ensureProfileCoreBundles(path.dirname(manifestPath))

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles.slice(0, 2)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(manifest.dependencies['@deepseek-ai/dsh-base']).toBeUndefined()
    expect(manifest.dependencies['@deepseek-ai/dsh-web-app']).toBeUndefined()
  })

  it('不把旧 Profile 中由 DSH runtime 提供的核心依赖算作插件或缺失项', async () => {
    const env = await fixture()
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: {
        '@deepseek-ai/dsh-app-boot': '0.1.0-rc.7',
        '@deepseek-ai/dsh-client-ui': '0.1.0-rc.7',
        cordis: '3.0.0',
        '@cordisjs/logger': '1.0.0',
        '@demo/plugin': '1.0.0',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@demo/plugin'] } },
    }), 'utf8')

    const summary = (await listProfiles(env.options)).find(item => item.id === 'web')
    expect(summary?.pluginCount).toBe(1)
    expect(summary?.missingDependencies).toEqual(['@demo/plugin'])
  })

  it('把当前 Profile 的 file: 源和虚拟 store 包视为本地可用', async () => {
    const env = await fixture()
    const source = path.join(env.root, 'plugin-sources', 'demo-plugin')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@demo/file-plugin', version: '1.0.0' }), 'utf8')
    const virtualPackage = path.join(env.dshHome, 'profiles', 'web', 'node_modules', '.pnpm', 'demo-virtual@1.0.0', 'node_modules', '@demo', 'virtual-plugin')
    await mkdir(virtualPackage, { recursive: true })
    await writeFile(path.join(virtualPackage, 'package.json'), JSON.stringify({ name: '@demo/virtual-plugin', version: '1.0.0' }), 'utf8')
    await writeFile(path.join(env.dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: {
        '@demo/file-plugin': `file:${source}`,
        '@demo/virtual-plugin': '1.0.0',
      },
      dsh: { profile: { bundles: ['@demo/file-plugin', '@demo/virtual-plugin'] } },
    }), 'utf8')

    const summary = (await listProfiles(env.options)).find(item => item.id === 'web')
    expect(summary?.missingDependencies).toEqual([])
  })

  it('removes legacy pack records and manifests when deleting a unified Profile', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    await upsertPackRecord(env.options.registryPath, {
      id: 'alpha', name: 'Alpha', description: 'legacy', version: '1.0.0', source: 'created',
      installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'complete', plugins: [],
    })
    await writePackManifest(env.options.manifestRoot, 'alpha', {
      name: 'Alpha', description: 'legacy', version: '1.0.0',
      plugins: [],
    })
    await deleteProfile(env.options, 'alpha')
    expect(await readPackRegistry(env.options.registryPath)).toEqual([])
    await expect(access(path.join(env.options.manifestRoot, 'alpha.yaml'))).rejects.toThrow()
  })

  it('does not create a legacy registry when deleting a Profile', async () => {
    const env = await fixture()
    await createProfile(env.options, { name: 'alpha' })
    await deleteProfile(env.options, 'alpha')
    await expect(access(env.options.registryPath)).rejects.toThrow()
  })
})
