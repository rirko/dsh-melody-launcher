import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 真实文件系统/子进程操作在并行与慢盘环境下会超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 })
import { createInstaller } from '../electron/installer'
import { readPluginReceipts, recordPluginInstall } from '../electron/plugin-receipts'
import { readProfile, removePluginFromProfile, removeUnusedSharedPluginBodies, togglePlugin } from '../electron/profile'
import { createProfileService } from '../electron/profile-service'
import {
  ensureStandalonePluginLink,
  findStandalonePluginDirectories,
  isStandalonePluginReference,
  repairStandalonePluginLinks,
  resolveStandalonePluginDirectory,
  standalonePluginPackageRoot,
} from '../electron/standalone-plugin-links'
import type { AppSettings } from '../src/types'

const PACKAGE = '@demo/standalone'
const HASH = 'a'.repeat(64)
let home = ''

async function seedBody(hash = HASH, manifest: object = {}): Promise<string> {
  const directory = path.join(standalonePluginPackageRoot(home, PACKAGE), hash)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: PACKAGE, version: '1.0.0',
    dsh: { standalone: { schemaVersion: 1 }, bundle: { patch: './cordis.patch.yml' } },
    ...manifest,
  }))
  await writeFile(path.join(directory, 'cordis.patch.yml'), '[]\n')
  return directory
}

async function seedProfile(name: string, directory?: string): Promise<string> {
  const profile = path.join(home, 'profiles', name)
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    dependencies: directory ? { [PACKAGE]: `link:${directory}` } : {},
    dsh: { profile: { bundles: directory ? [PACKAGE] : [] } },
  }, null, 2))
  await writeFile(path.join(profile, 'profile.yaml'), `name: ${name}\ndescription: unchanged\n`)
  return profile
}

async function receipt(profileName: string, directory: string): Promise<void> {
  await recordPluginInstall(path.join(home, 'receipts.json'), {
    packageName: PACKAGE, profileName, source: 'local-directory', repository: `file:${directory}`,
    version: '1.0.0', commit: '', subdirectory: null, installedAt: new Date().toISOString(),
  })
}

function linkPath(profileName: string): string {
  return path.join(home, 'profiles', profileName, 'node_modules', ...PACKAGE.split('/'))
}

function profileService() {
  let settings: AppSettings = {
    dshHome: home, dshInstallPath: path.join(home, 'runtime'), profileName: 'web', workspace: home,
    launchExecutable: 'dsh', launchArgs: ['web'], webPort: 3090, openAfterLaunch: false,
  }
  const repairs = vi.fn(async (profileName: string, missing: string[]) => {
    await repairStandalonePluginLinks(home, profileName, missing)
  })
  const service = createProfileService({
    dshHome: home, readSettings: async () => settings,
    saveSettings: async next => { settings = next; return settings },
    pluginReceiptsPath: path.join(home, 'receipts.json'), fillMissingDependencies: repairs,
  })
  return { service, repairs, settings: () => settings }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'dsh-standalone-links-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('standalone plugin links', () => {
  it('repairs only the outer link without changing dependencies, activation or metadata', async () => {
    const directory = await seedBody()
    const profile = await seedProfile('web', directory)
    const before = await readFile(path.join(profile, 'package.json'), 'utf8')
    const metadata = await readFile(path.join(profile, 'profile.yaml'), 'utf8')

    expect(await repairStandalonePluginLinks(home, 'web', [PACKAGE, 'ordinary-plugin'])).toEqual([PACKAGE])
    expect(await realpath(linkPath('web'))).toBe(await realpath(directory))
    expect((await lstat(linkPath('web'))).isSymbolicLink()).toBe(true)
    expect(await readFile(path.join(profile, 'package.json'), 'utf8')).toBe(before)
    expect(await readFile(path.join(profile, 'profile.yaml'), 'utf8')).toBe(metadata)

    await ensureStandalonePluginLink(home, 'web', PACKAGE, directory)
    await unlink(linkPath('web'))
    await repairStandalonePluginLinks(home, 'web', [PACKAGE])
    expect(await realpath(linkPath('web'))).toBe(await realpath(directory))
  })

  it('recognizes relative link and file references but rejects unmanaged paths and invalid layouts', async () => {
    const directory = await seedBody()
    const profile = await seedProfile('web')
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, `link:${path.relative(profile, directory)}`, profile)).toBe(directory)
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, `file:${directory}`)).toBe(directory)
    expect(isStandalonePluginReference(home, PACKAGE, path.join(standalonePluginPackageRoot(home, PACKAGE), '1.0.0'))).toBe(false)
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, home)).toBeNull()
    expect(() => standalonePluginPackageRoot(home, '../outside')).toThrow()
    await expect(repairStandalonePluginLinks(home, '../outside', [PACKAGE])).rejects.toThrow(/Profile name/)
  })

  it.each([
    ['missing marker', { dsh: { bundle: { patch: './cordis.patch.yml' } } }],
    ['wrong package name', { name: '@other/standalone' }],
    ['unsupported schema', { dsh: { standalone: { schemaVersion: 2 } } }],
  ])('rejects %s instead of silently falling back to pnpm', async (_name, manifest) => {
    const directory = await seedBody(HASH, manifest)
    const profile = await seedProfile('web', directory)
    const before = await readFile(path.join(profile, 'package.json'), 'utf8')
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, directory)).toBeNull()
    await expect(repairStandalonePluginLinks(home, 'web', [PACKAGE])).rejects.toThrow(/missing or invalid/)
    expect(await readFile(path.join(profile, 'package.json'), 'utf8')).toBe(before)
    expect(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  })

  it('rejects a redirected body without touching its target', async () => {
    const foreign = path.join(home, 'foreign-body')
    await mkdir(foreign)
    await writeFile(path.join(foreign, 'package.json'), JSON.stringify({ name: PACKAGE, dsh: { standalone: { schemaVersion: 1 } } }))
    const root = standalonePluginPackageRoot(home, PACKAGE)
    await mkdir(root, { recursive: true })
    const directory = path.join(root, HASH)
    await symlink(foreign, directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, directory)).toBeNull()
    expect(await findStandalonePluginDirectories(home, PACKAGE)).toEqual([])
    expect(await removeUnusedSharedPluginBodies(home, PACKAGE)).toBe(false)
    expect(await readFile(path.join(foreign, 'package.json'), 'utf8')).toContain(PACKAGE)
  })

  it('does not write through a redirected node_modules parent', async () => {
    const directory = await seedBody()
    const profile = await seedProfile('web')
    const foreign = path.join(home, 'foreign-modules')
    await mkdir(foreign)
    await symlink(foreign, path.join(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ensureStandalonePluginLink(home, 'web', PACKAGE, directory)).rejects.toThrow(/redirects/)
    await expect(lstat(path.join(foreign, '@demo'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not replace a physical plugin directory', async () => {
    const directory = await seedBody()
    await seedProfile('web')
    await mkdir(linkPath('web'), { recursive: true })
    await writeFile(path.join(linkPath('web'), 'user.txt'), 'untouched')
    await expect(ensureStandalonePluginLink(home, 'web', PACKAGE, directory)).rejects.toThrow(/existing plugin directory/)
    expect(await readFile(path.join(linkPath('web'), 'user.txt'), 'utf8')).toBe('untouched')
  })

  it('exposes only the outer plugin and enables it independently through its local receipt', async () => {
    const directory = await seedBody()
    const privatePackage = path.join(directory, 'node_modules', 'private-plugin')
    await mkdir(privatePackage, { recursive: true })
    await writeFile(path.join(privatePackage, 'package.json'), JSON.stringify({
      name: 'private-plugin', version: '4.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(path.join(privatePackage, 'cordis.patch.yml'), '[]\n')
    await seedProfile('web')
    const desktop = await seedProfile('desktop')
    const before = await readFile(path.join(desktop, 'package.json'), 'utf8')
    await receipt('web', directory)
    const receipts = path.join(home, 'receipts.json')

    const visible = await readProfile(home, 'desktop', receipts)
    expect(visible.plugins.map(item => item.packageName)).toEqual([PACKAGE])
    expect(visible.plugins[0]).toMatchObject({ enabled: false, declaredInProfile: false, compatible: true })

    const enabled = await togglePlugin(home, 'web', PACKAGE, true, receipts)
    expect(enabled.activeBundles).toEqual([PACKAGE])
    const manifest = JSON.parse(await readFile(path.join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    expect(manifest.dependencies[PACKAGE]).toBe(`link:${directory}`)
    expect(await realpath(linkPath('web'))).toBe(await realpath(directory))
    expect(await readFile(path.join(desktop, 'package.json'), 'utf8')).toBe(before)
    expect((await readProfile(home, 'desktop', receipts)).activeBundles).toEqual([])
    expect((await togglePlugin(home, 'web', PACKAGE, false, receipts)).activeBundles).toEqual([])
    expect(await readFile(path.join(privatePackage, 'package.json'), 'utf8')).toContain('private-plugin')
  })

  it('keeps marked bodies while referenced and removes only valid bodies after the final unlink', async () => {
    const directory = await seedBody()
    const foreign = await seedBody('b'.repeat(64), { dsh: {} })
    await seedProfile('web', directory)
    await seedProfile('desktop', directory)
    await ensureStandalonePluginLink(home, 'web', PACKAGE, directory)
    await ensureStandalonePluginLink(home, 'desktop', PACKAGE, directory)

    await removePluginFromProfile(home, 'web', PACKAGE)
    expect(await removeUnusedSharedPluginBodies(home, PACKAGE)).toBe(false)
    expect(await realpath(linkPath('desktop'))).toBe(await realpath(directory))
    await removePluginFromProfile(home, 'desktop', PACKAGE)
    expect(await removeUnusedSharedPluginBodies(home, PACKAGE)).toBe(true)
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(foreign, 'package.json'), 'utf8')).toContain(PACKAGE)
  })

  it('reclaims the final deleted Profile standalone artifact without touching ordinary shared bodies', async () => {
    const directory = await seedBody()
    const unmarked = await seedBody('b'.repeat(64), { dsh: {} })
    await seedProfile('web')
    await seedProfile('alpha', directory)
    await seedProfile('beta', directory)
    await receipt('alpha', directory)
    await receipt('beta', directory)
    const shared = path.join(home, '.dsh-launcher-plugin-bodies', ...PACKAGE.split('/'), '1.0.0')
    await mkdir(shared, { recursive: true })
    await writeFile(path.join(shared, 'keep.txt'), 'ordinary shared package')
    const { service } = profileService()

    await service.remove('alpha')
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, directory)).toBe(directory)
    expect((await readPluginReceipts(path.join(home, 'receipts.json'))).map(item => item.profileName)).toEqual(['beta'])

    await service.remove('beta')
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readPluginReceipts(path.join(home, 'receipts.json'))).toEqual([])
    expect(await readFile(path.join(shared, 'keep.txt'), 'utf8')).toBe('ordinary shared package')
    expect(await readFile(path.join(unmarked, 'package.json'), 'utf8')).toContain(PACKAGE)
  })

  it('retains standalone artifacts when another Profile has only a remaining link', async () => {
    const directory = await seedBody()
    await seedProfile('web')
    await seedProfile('alpha', directory)
    await ensureStandalonePluginLink(home, 'web', PACKAGE, directory)
    await profileService().service.remove('alpha')
    expect(await realpath(linkPath('web'))).toBe(await realpath(directory))
  })

  it('retains standalone artifacts when a sibling manifest cannot be read safely', async () => {
    const directory = await seedBody()
    const web = await seedProfile('web')
    await seedProfile('alpha', directory)
    await writeFile(path.join(web, 'package.json'), '{ invalid')
    await profileService().service.remove('alpha')
    expect(await resolveStandalonePluginDirectory(home, PACKAGE, directory)).toBe(directory)
  })

  it('clones standalone declarations and repairs independent links offline on switch', async () => {
    const directory = await seedBody()
    await seedProfile('web', directory)
    await ensureStandalonePluginLink(home, 'web', PACKAGE, directory)
    const { service, repairs, settings } = profileService()
    await service.clone('web', 'clone')
    expect(repairs).not.toHaveBeenCalled()
    await expect(lstat(linkPath('clone'))).rejects.toMatchObject({ code: 'ENOENT' })

    await service.switch('clone')
    expect(repairs).toHaveBeenCalledExactlyOnceWith('clone', [PACKAGE])
    expect(settings().profileName).toBe('clone')
    expect(await realpath(linkPath('clone'))).toBe(await realpath(linkPath('web')))
    await togglePlugin(home, 'clone', PACKAGE, false)
    expect((await readProfile(home, 'web')).activeBundles).toContain(PACKAGE)
    expect((await readProfile(home, 'clone')).activeBundles).not.toContain(PACKAGE)
  })

  it('purges all outer references and bodies without preparing runtime, running commands or pruning pnpm', async () => {
    const directory = await seedBody()
    await seedProfile('web', directory)
    await seedProfile('desktop', directory)
    const unrelated = await seedProfile('unrelated')
    const before = await readFile(path.join(unrelated, 'package.json'), 'utf8')
    for (const name of ['web', 'desktop']) {
      await ensureStandalonePluginLink(home, name, PACKAGE, directory)
      await receipt(name, directory)
    }
    const settings: AppSettings = {
      dshHome: home, dshInstallPath: path.join(home, 'runtime'), profileName: 'web', workspace: home,
      launchExecutable: 'dsh', launchArgs: ['web'], webPort: 3090, openAfterLaunch: false,
    }
    const prepare = vi.fn(async () => { throw new Error('Must remain offline') })
    const command = vi.fn(async () => { throw new Error('Must not execute commands') })
    const prune = vi.fn(async () => {})
    const installer = createInstaller({
      readSettings: async () => settings, saveSettings: async value => value,
      prepareNodeRuntime: prepare, preparePnpmRuntime: prepare, runCommand: command,
      pluginSourceRoot: path.join(home, 'sources'), pluginReceiptsPath: path.join(home, 'receipts.json'),
      presetReceiptsPath: path.join(home, 'presets.json'), skillReceiptsPath: path.join(home, 'skills.json'),
      skillSourceRoot: path.join(home, 'skills'), purgePnpmStore: prune,
      emitOutput: () => {}, emitProgress: () => {}, isRuntimeRunning: () => false,
    })

    const result = await installer.remove(PACKAGE, 'desktop', { purgeStore: true })
    expect(result.plugins).toEqual([])
    expect(await readPluginReceipts(path.join(home, 'receipts.json'))).toEqual([])
    expect(await readFile(path.join(unrelated, 'package.json'), 'utf8')).toBe(before)
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(prepare).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    expect(prune).not.toHaveBeenCalled()
  })
})
