import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeNonstandardPackRepository, importNonstandardPackRepository } from '../electron/nonstandard-pack'
import { readPluginReceipts } from '../electron/plugin-receipts'
import { createProfileService } from '../electron/profile-service'
import { defaultSettings } from '../electron/settings'
import type { AppSettings } from '../src/types'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('nonstandard pack repository analysis', () => {
  it('识别 bundles.json、手动组件和仓库内 Bundle', async () => {
    const archive = new AdmZip()
    const root = 'owner-pack-main/'
    archive.addFile(`${root}package.json`, Buffer.from(JSON.stringify({ name: '@oh-dsh/desktop', description: 'test pack', dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.6' } })))
    archive.addFile(`${root}dsh-source.json`, Buffer.from(JSON.stringify({ version: '0.1.0-rc.5' })))
    archive.addFile(`${root}config/bundles.json`, Buffer.from(JSON.stringify({
      core: [{ id: 'demo-plugin', pkg: 'owner/demo-plugin', source: 'github', profile: ['web'] }],
      optional: [{ id: 'browser', pkg: 'owner/browser', source: 'github', install: 'manual' }, { id: 'notification', pkg: '@dingyi222666/dsh-session-notification', source: 'npm' }],
      presets: [{ id: 'router-standard' }],
    })))
    archive.addFile(`${root}plugins/local-plugin/package.json`, Buffer.from(JSON.stringify({ name: 'dsh-local-plugin', version: '1.0.0', dsh: { bundle: { patch: 'bundle.json' } } })))
    archive.addFile(`${root}plugins/local-plugin/bundle.json`, Buffer.from('{}'))
    const buffer = archive.toBuffer()
    const rootPath = await mkdtemp(path.join(process.cwd(), 'nonstandard-test-'))
    temporaryRoots.push(rootPath)
    const requests: string[] = []
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/commits/main')) return response({ sha: 'a'.repeat(40) })
      if (url.includes('/repos/owner/pack')) return response({ default_branch: 'main' })
      if (url.includes('codeload.github.com/owner/pack')) return new Response(new Uint8Array(buffer))
      if (url.includes('/search/repositories')) return response({ items: [{ full_name: 'dingyi222666/dsh-session-notification' }] })
      if (url.includes('registry.npmjs.org')) return response({ 'dist-tags': { latest: '1.0.0' }, repository: { type: 'git', url: 'https://github.com/dingyi222666/dsh-session-notification.git' } })
      return response({}, 404)
    }
    const preview = await analyzeNonstandardPackRepository({
      githubAuth: { fetch: fetchImpl } as never,
      installer: { analyzePlugin: async () => ({ targets: [] }), analyzeSkill: async () => ({ targets: [] }) } as never,
      dshMarket: { load: async () => ({ updated: '', count: 0, categories: {}, plugins: [] }) },
      profiles: {} as never,
      readSettings: async () => ({}) as never,
      pluginReceiptsPath: path.join(rootPath, 'receipts.json'),
      pluginSourceRoot: rootPath,
    }, 'https://github.com/owner/pack')
    expect(preview.kind).toBe('distribution')
    expect(preview.dshVersion).toBe('0.1.0-rc.6')
    expect(preview.warnings).toHaveLength(1)
    expect(preview.plugins.some(plugin => plugin.packageName === 'dsh-local-plugin' && plugin.source === 'local')).toBe(true)
    expect(preview.plugins.find(plugin => plugin.packageName === '@dingyi222666/dsh-session-notification')).toMatchObject({ repository: 'dingyi222666/dsh-session-notification', source: 'npm', declaredSource: 'npm', version: '1.0.0' })
    expect(requests.some(url => url.includes('/search/repositories'))).toBe(false)
    expect(preview.skipped.some(item => item.name === 'browser')).toBe(true)
    expect(preview.skipped.some(item => item.name === 'router-standard')).toBe(true)
  })

  it('GitHub commit 获取失败时不会使用整合包根 commit', async () => {
    const archive = new AdmZip()
    const root = 'owner-pack-main/'
    archive.addFile(`${root}package.json`, Buffer.from(JSON.stringify({ name: 'pack' })))
    archive.addFile(`${root}config/bundles.json`, Buffer.from(JSON.stringify({ core: [{ id: 'demo', pkg: 'owner/demo', source: 'github' }] })))
    const buffer = archive.toBuffer()
    const rootPath = await mkdtemp(path.join(process.cwd(), 'nonstandard-test-'))
    temporaryRoots.push(rootPath)
    const preview = await analyzeNonstandardPackRepository({
      githubAuth: { fetch: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/repos/owner/pack/commits/main')) return response({ sha: 'a'.repeat(40) })
        if (url.includes('/repos/owner/pack')) return response({ default_branch: 'main' })
        if (url.includes('codeload.github.com/owner/pack')) return new Response(new Uint8Array(buffer))
        if (url.includes('/repos/owner/demo')) return response({}, 403)
        return response({}, 404)
      } } as never,
      installer: { analyzePlugin: async () => ({ targets: [] }), analyzeSkill: async () => ({ targets: [] }) } as never,
      dshMarket: { load: async () => ({ updated: '', count: 0, categories: {}, plugins: [] }) },
      profiles: {} as never,
      readSettings: async () => ({}) as never,
      pluginReceiptsPath: path.join(rootPath, 'receipts.json'),
      pluginSourceRoot: rootPath,
    }, 'https://github.com/owner/pack')

    expect(preview.plugins[0]).toMatchObject({ repository: 'owner/demo', commit: null, source: 'unavailable', sourceLabel: '来源待重试' })
    expect(preview.plugins[0]?.reason).toContain('GitHub 请求额度暂时用尽')
  })

  it('识别 github-tarball 清单并按插件自身 tag 固定 commit', async () => {
    const archive = new AdmZip()
    const root = 'owner-pack-main/'
    archive.addFile(`${root}package.json`, Buffer.from(JSON.stringify({ name: 'pack' })))
    archive.addFile(`${root}config/bundles.json`, Buffer.from(JSON.stringify({
      core: [{ id: 'tagged-plugin', pkg: 'owner/tagged-plugin', source: 'github-tarball', version: 'v1.2.3' }],
    })))
    const buffer = archive.toBuffer()
    const rootPath = await mkdtemp(path.join(process.cwd(), 'nonstandard-test-'))
    temporaryRoots.push(rootPath)
    const pluginCommit = 'b'.repeat(40)
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('/repos/owner/pack/commits/main')) return response({ sha: 'a'.repeat(40) })
      if (url.includes('/repos/owner/pack')) return response({ default_branch: 'main' })
      if (url.includes('codeload.github.com/owner/pack')) return new Response(new Uint8Array(buffer))
      if (url.includes('/repos/owner/tagged-plugin/commits/v1.2.3')) return response({ sha: pluginCommit })
      if (url.includes('/repos/owner/tagged-plugin')) return response({ default_branch: 'main' })
      return response({}, 404)
    }

    const preview = await analyzeNonstandardPackRepository({
      githubAuth: { fetch: fetchImpl } as never,
      installer: { analyzePlugin: async () => ({ targets: [] }), analyzeSkill: async () => ({ targets: [] }) } as never,
      dshMarket: { load: async () => ({ updated: '', count: 0, categories: {}, plugins: [] }) },
      profiles: {} as never,
      readSettings: async () => ({}) as never,
      pluginReceiptsPath: path.join(rootPath, 'receipts.json'),
      pluginSourceRoot: rootPath,
    }, 'https://github.com/owner/pack')

    expect(preview.plugins[0]).toMatchObject({
      packageName: 'tagged-plugin',
      repository: 'owner/tagged-plugin',
      declaredSource: 'github-tarball',
      source: 'github',
      defaultBranch: 'v1.2.3',
      commit: pluginCommit,
    })
    expect(preview.blockers).toEqual([])
  })

  it('导入时向 Market 传入精确版本并保留完整 Profile 元数据', async () => {
    const archive = new AdmZip()
    const archiveRoot = 'owner-pack-main/'
    archive.addFile(`${archiveRoot}package.json`, Buffer.from(JSON.stringify({ name: 'demo-pack', description: 'Demo pack', dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.7' } })))
    archive.addFile(`${archiveRoot}dsh-source.json`, Buffer.from(JSON.stringify({ version: '0.1.0-rc.6' })))
    // The manifest requests a version that is unavailable; the mocked Market
    // install links 1.2.3 as the fallback latest version. The receipt must
    // retain the linked version, not the stale manifest request.
    archive.addFile(`${archiveRoot}config/bundles.json`, Buffer.from(JSON.stringify({ core: [{ id: 'demo-plugin', pkg: 'dsh-demo-plugin', source: 'npm', version: '9.9.9' }] })))
    const archiveBuffer = archive.toBuffer()
    const testRoot = await mkdtemp(path.join(os.tmpdir(), 'nonstandard-import-'))
    temporaryRoots.push(testRoot)
    const dshHome = path.join(testRoot, 'dsh-home')
    const receiptsPath = path.join(testRoot, 'receipts.json')
    await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(path.join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
    let settings: AppSettings = { ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }), dshHome, profileName: 'web' }
    const profileService = createProfileService({
      dshHome,
      readSettings: async () => settings,
      saveSettings: async next => { settings = next; return settings },
      pluginReceiptsPath: receiptsPath,
      isRuntimeRunning: () => false,
    })
    const marketInstalls: Array<{ name: string; profileName?: string; version?: string | null }> = []
    const ensuredVersions: string[] = []
    const options = {
      githubAuth: { fetch: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/repos/owner/pack/commits/main')) return response({ sha: 'b'.repeat(40) })
        if (url.includes('/repos/owner/pack')) return response({ default_branch: 'main' })
        if (url.includes('codeload.github.com/owner/pack')) return new Response(new Uint8Array(archiveBuffer))
        return response({}, 404)
      } } as never,
      installer: { analyzePlugin: async () => ({ targets: [] }), analyzeSkill: async () => ({ targets: [] }) } as never,
      dshMarket: {
        load: async () => ({ updated: '', count: 1, categories: {}, plugins: [{ name: 'demo-plugin', owner: 'owner', url: 'https://github.com/owner/demo-plugin', category: 'plugin', description: {}, npm: 'dsh-demo-plugin', stars: 0, added: '', install: '', installed: false, enabled: false, version: null, updateAvailable: false, updateVersion: null }] }),
        install: async (name: string, profileName?: string, version?: string | null) => {
          marketInstalls.push({ name, profileName, version })
          const profileDir = path.join(dshHome, 'profiles', profileName!)
          const manifestPath = path.join(profileDir, 'package.json')
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
          await writeFile(manifestPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'dsh-demo-plugin': '1.2.3' }, dsh: { profile: { bundles: [...(manifest.dsh?.profile?.bundles ?? []), 'dsh-demo-plugin'] } } }), 'utf8')
          const packageDir = path.join(profileDir, 'node_modules', 'dsh-demo-plugin')
          await mkdir(packageDir, { recursive: true })
          await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'dsh-demo-plugin', version: '1.2.3', dsh: { bundle: { patch: 'bundle.json' } } }), 'utf8')
          await writeFile(path.join(packageDir, 'bundle.json'), '{}', 'utf8')
          return []
        },
      },
      profiles: profileService,
      readSettings: async () => settings,
      pluginReceiptsPath: receiptsPath,
      pluginSourceRoot: testRoot,
      ensureDshVersion: async (version: string) => { ensuredVersions.push(version) },
    }

    const result = await importNonstandardPackRepository(options, 'https://github.com/owner/pack')
    expect(ensuredVersions).toEqual(['0.1.0-rc.7'])
    expect(marketInstalls).toEqual([{ name: 'dsh-demo-plugin', profileName: 'pack-demo-pack', version: '9.9.9' }])
    expect(result).toMatchObject({ id: 'pack-demo-pack', dshVersion: '0.1.0-rc.7', dshSourceVersion: '0.1.0-rc.6', importState: 'complete' })
    expect(result.source).toMatchObject({ kind: 'import', branch: 'main', commit: 'b'.repeat(40) })
    expect(await readPluginReceipts(receiptsPath)).toContainEqual(expect.objectContaining({ packageName: 'dsh-demo-plugin', profileName: 'pack-demo-pack', source: 'npm', version: '1.2.3', commit: '', packCommit: 'b'.repeat(40), actualSource: 'market' }))
  })

  it('GitHub 清单使用仓库分析返回的真实包名写入 Profile', async () => {
    const archive = new AdmZip()
    const archiveRoot = 'owner-pack-main/'
    archive.addFile(`${archiveRoot}package.json`, Buffer.from(JSON.stringify({ name: 'pack' })))
    archive.addFile(`${archiveRoot}config/bundles.json`, Buffer.from(JSON.stringify({
      core: [{ id: 'notification', pkg: 'owner/notification', source: 'github' }],
    })))
    const archiveBuffer = archive.toBuffer()
    const testRoot = await mkdtemp(path.join(os.tmpdir(), 'nonstandard-import-'))
    temporaryRoots.push(testRoot)
    const dshHome = path.join(testRoot, 'dsh-home')
    const receiptsPath = path.join(testRoot, 'receipts.json')
    await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(path.join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'web', dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
    let settings: AppSettings = { ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }), dshHome, profileName: 'web' }
    const profileService = createProfileService({
      dshHome,
      readSettings: async () => settings,
      saveSettings: async next => { settings = next; return settings },
      pluginReceiptsPath: receiptsPath,
      isRuntimeRunning: () => false,
    })
    const targetPackage = '@scope/notification'
    const targetId = `${targetPackage}:.`
    const pluginCommit = 'c'.repeat(40)
    const installer = {
      analyzePlugin: async () => ({ targets: [{ id: targetId, packageName: targetPackage, version: '1.0.0', source: 'github', profileName: 'web', platform: 'web', subdirectory: null, commit: pluginCommit, requiresBuild: false, buildScripts: [], nodeRange: null }], installability: 'ready', repository: 'owner/notification', defaultBranch: 'main', summary: '' }),
      analyzeSkill: async () => ({ targets: [] }),
      installPluginTarget: async (request: { targetId: string }, profileName: string) => {
        const profileDir = path.join(dshHome, 'profiles', profileName)
        const manifestPath = path.join(profileDir, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
        await writeFile(manifestPath, JSON.stringify({
          ...manifest,
          dependencies: { ...manifest.dependencies, [targetPackage]: `github:owner/notification#${pluginCommit}` },
          dsh: { profile: { bundles: [...(manifest.dsh?.profile?.bundles ?? []), targetPackage] } },
        }), 'utf8')
        const packageDir = path.join(profileDir, 'node_modules', '@scope', 'notification')
        await mkdir(packageDir, { recursive: true })
        await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: targetPackage, version: '1.0.0', dsh: { bundle: { patch: 'bundle.json' } } }), 'utf8')
        await writeFile(path.join(packageDir, 'bundle.json'), '{}', 'utf8')
        expect(request.targetId).toBe(targetId)
      },
    }
    const options = {
      githubAuth: { fetch: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/repos/owner/pack/commits/main')) return response({ sha: 'a'.repeat(40) })
        if (url.includes('/repos/owner/pack')) return response({ default_branch: 'main' })
        if (url.includes('codeload.github.com/owner/pack')) return new Response(new Uint8Array(archiveBuffer))
        if (url.includes('/repos/owner/notification/commits/main')) return response({ sha: pluginCommit })
        if (url.includes('/repos/owner/notification')) return response({ default_branch: 'main' })
        return response({}, 404)
      } } as never,
      installer: installer as never,
      dshMarket: { load: async () => ({ updated: '', count: 0, categories: {}, plugins: [] }) },
      profiles: profileService,
      readSettings: async () => settings,
      pluginReceiptsPath: receiptsPath,
      pluginSourceRoot: testRoot,
    }

    const result = await importNonstandardPackRepository(options, 'https://github.com/owner/pack')
    expect(result.importedPluginCount).toBe(1)
    expect(await readPluginReceipts(receiptsPath)).toContainEqual(expect.objectContaining({ packageName: targetPackage, targetId, commit: pluginCommit }))
    const importedManifest = JSON.parse(await readFile(path.join(dshHome, 'profiles', 'pack-pack', 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(importedManifest.dsh?.profile?.bundles).toContain(targetPackage)
  })
})
