import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consolidatePluginPool, createProfile, createProfileService, deleteProfile, ensureProfileCoreBundles, listProfiles, migrateLegacyPacks, switchProfile } from '../electron/profile-service'
import { defaultSettings } from '../electron/settings'
import { upsertPackRecord } from '../electron/pack-registry'
import { readPluginReceipts, recordPluginInstall } from '../electron/plugin-receipts'
import { writePackManifest } from '../electron/pack-manifest-store'
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
})
