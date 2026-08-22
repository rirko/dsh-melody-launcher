// 整合包（Pack）真实端到端：用「有状态的 DSH 模拟器」驱动 createPackManager，
// 在真实 fs 上把全部整合包功能串成完整生命周期跑通。
//
// 与 pack.test.ts（单元级，installer 用无状态 stub）的区别：
//  - 模拟器把 DSH CLI 的「效果」落到真实文件系统——装插件写进 profile 的
//    package.json（dependencies + bundles）+ node_modules，装技能写进
//    <dshHome>/skills/，卸载/切换都有真实可读回的 profile 状态。
//  - 链路两端用真实模块：buildPackZip/inspectPackZip/extractPackBodies
//    （pack-zip.ts）、scanRawPackZip/extractRawPluginBodies（pack-scan.ts）、
//    buildManifestFromReceipts（pack-manifest.ts）、buildPackExport（pack-export.ts）、
//    createProfileSnapshot/restoreProfileSnapshot（ai-install.ts）、
//    readProfile/togglePlugin（profile.ts）、installSkillFromDirectory（skill-install.ts）、
//    以及 pack-registry / plugin-receipts。
//  - 唯一被替换的是 DSH CLI 二进制本身（CI 无真实运行时），其落盘效果由模拟器忠实还原。
//
// 覆盖场景：
//   A 标准包完整生命周期：分析→离线导入→切换→停用/启用→导出→删除→回导再导入。
//   B raw 包导入（插件+技能）：技能全局安装、harness-backend 排除、删包技能引用计数清理。
//   C 中途失败→回滚：profile 目录 / 注册表 / 全局技能全部复原。
//   D 从已装插件创建包 + 追加插件 + 移除插件项。

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, PackManifest } from '../src/types'
import { createPackManager, type InstallInstaller, type PackInstallTarget } from '../electron/pack'
import { buildPackZip, inspectPackZip } from '../electron/pack-zip'
import { readPackRegistry } from '../electron/pack-registry'
import { readPluginReceipts, recordPluginInstall, removePluginReceipt } from '../electron/plugin-receipts'
import { readProfile, togglePlugin } from '../electron/profile'
import { installSkillFromDirectory } from '../electron/skill-install'
import { defaultSettings } from '../electron/settings'

// ---------------------------------------------------------------------------
// fixtures / 环境
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'dsh-pack-e2e-'): Promise<string> {
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

type Env = Awaited<ReturnType<typeof makeEnv>>

/** 设置存储：profileName 从 'web'（默认 profile）起步，可被激活/停用切换。 */
function makeSettingsStore(dshHome: string, profileName = 'web') {
  let current: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome,
    dshVersion: '0.1.0-rc.7',
    profileName,
  }
  return {
    readSettings: async () => current,
    saveSettings: async (next: AppSettings) => { current = next; return current },
    get current(): AppSettings { return current },
  }
}

type SettingsStore = ReturnType<typeof makeSettingsStore>

function makeManager(env: Env, installer: InstallInstaller, store: SettingsStore) {
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
      list: async () => [],
      install: async () => ({}),
      uninstall: async () => [],
    },
    installer,
    emitEvent,
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    dshHome: env.dshHome,
  })
  return { manager, emitEvent }
}

// ---------------------------------------------------------------------------
// 有状态 DSH 模拟器：把 DSH CLI 的落盘效果写到真实 fs，可被 readProfile 读回。
// ---------------------------------------------------------------------------

interface DshSimulator extends InstallInstaller {
  failOn: Set<string>
  installCalls: PackInstallTarget[]
}

function createDshSimulator(dshHome: string, receiptsPath: string): DshSimulator {
  const failOn = new Set<string>()
  const installCalls: PackInstallTarget[] = []

  async function readProfileManifest(profileName: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(path.join(dshHome, 'profiles', profileName, 'package.json'), 'utf8')) as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { name: profileName, private: true, version: '0.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }
      }
      throw error
    }
  }

  async function writeProfileManifest(profileName: string, manifest: Record<string, unknown>): Promise<void> {
    const dir = path.join(dshHome, 'profiles', profileName)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const installPluginTarget: InstallInstaller['installPluginTarget'] = async (target) => {
    if (failOn.has(target.packageName)) throw new Error(`模拟安装失败：${target.packageName}`)
    installCalls.push(target)
    const profileName = target.profileName
    const pkgDir = path.join(dshHome, 'profiles', profileName, 'node_modules', ...target.packageName.split('/'))
    await mkdir(pkgDir, { recursive: true })
    if (target.source === 'local-directory' && target.localDirectory) {
      if (!existsSync(path.join(target.localDirectory, 'package.json'))) {
        throw new Error(`本地插件本体缺少 package.json：${target.localDirectory}`)
      }
      await cp(target.localDirectory, pkgDir, { recursive: true })
    } else {
      // github / npm 源在 CI 无法联网：合成一个满足 readProfile 的最小本体。
      await writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: target.packageName, version: target.version ?? '1.0.0' }, null, 2),
      )
    }
    const manifest = await readProfileManifest(profileName)
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    const spec = target.source === 'npm'
      ? `${target.packageName}@${target.version ?? '^1.0.0'}`
      : target.source === 'github'
        ? `github:${target.repository ?? 'demo/owner'}#${target.commit || 'HEAD'}`
        : `file:../.pack-bodies/${target.packageName}`
    dependencies[target.packageName] = spec
    const profile = (manifest.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile ?? { bundles: [] }
    const bundles = profile.bundles ?? []
    if (!bundles.includes(target.packageName)) bundles.push(target.packageName)
    await writeProfileManifest(profileName, {
      ...manifest,
      dependencies,
      dsh: { profile: { bundles } },
    })
    await recordPluginInstall(receiptsPath, {
      repository: target.repository ?? 'demo/owner',
      packageName: target.packageName,
      profileName,
      source: target.source,
      subdirectory: target.subdirectory ?? null,
      version: target.version ?? null,
      commit: target.commit ?? '',
      installedAt: new Date().toISOString(),
    })
    return {}
  }

  const installSkillLocal: InstallInstaller['installSkillLocal'] = (home, skill) =>
    installSkillFromDirectory(home, skill.name, skill.format, skill.sourceDir)

  const remove: InstallInstaller['remove'] = async (packageName, profileName) => {
    const profile = profileName!
    const manifest = await readProfileManifest(profile)
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    delete dependencies[packageName]
    const bundles = ((manifest.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile?.bundles ?? []).filter(name => name !== packageName)
    await writeProfileManifest(profile, {
      ...manifest,
      dependencies,
      dsh: { profile: { bundles } },
    })
    await rm(path.join(dshHome, 'profiles', profile, 'node_modules', ...packageName.split('/')), { recursive: true, force: true })
    await removePluginReceipt(receiptsPath, profile, packageName)
    return readProfile(dshHome, profile)
  }

  const installPreset: InstallInstaller['installPreset'] = async request => {
    if (failOn.has(request.name)) throw new Error(`模拟安装失败：${request.name}`)
    const presetRoot = path.join(dshHome, '.agent-presets')
    const destination = path.join(presetRoot, request.name)
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'preset.yml'), `name: ${request.name}\n`)
    return {
      installedPreset: { name: request.name, path: destination, enabled: true },
      installedPresets: [],
    }
  }

  const installPresetLocal: InstallInstaller['installPresetLocal'] = async (home, preset) => {
    if (failOn.has(preset.name)) throw new Error(`模拟安装失败：${preset.name}`)
    const destination = path.join(home, '.agent-presets', preset.name)
    await mkdir(destination, { recursive: true })
    await cp(preset.sourceDir, destination, { recursive: true })
    return {}
  }

  const installSkill: InstallInstaller['installSkill'] = async request => {
    if (failOn.has(request.targetId)) throw new Error(`模拟安装失败：${request.targetId}`)
    return {
      installedSkill: {
        name: request.targetId,
        description: '',
        path: path.join(dshHome, 'skills', request.targetId),
        format: 'bundle',
        enabled: true,
        modelInvocable: false,
        userInvocable: false,
      },
      installedSkills: [],
    }
  }

  const installSkillPinned: InstallInstaller['installSkillPinned'] = async ({ target }) => {
    if (failOn.has(target.name)) throw new Error(`模拟安装失败：${target.name}`)
    const destination = path.join(dshHome, 'skills', target.name)
    await mkdir(destination, { recursive: true })
    await writeFile(path.join(destination, 'SKILL.md'), `---\nname: ${target.name}\ndescription: x\n---\n`)
    return {
      name: target.name,
      description: '',
      path: destination,
      format: target.format,
      enabled: true,
      modelInvocable: false,
      userInvocable: false,
    }
  }

  const toggleSkill: InstallInstaller['toggleSkill'] = async () => []
  const togglePreset: InstallInstaller['togglePreset'] = async () => []

  return {
    failOn,
    installCalls,
    installPluginTarget,
    installSkillLocal,
    installSkill,
    installSkillPinned,
    toggleSkill,
    installPreset,
    installPresetLocal,
    togglePreset,
    remove,
    readProfile: (home, profileName) => readProfile(home, profileName),
    togglePlugin: (home, profileName, packageName, enabled) => togglePlugin(home, profileName, packageName, enabled),
  }
}

// ---------------------------------------------------------------------------
// zip 构建器
// ---------------------------------------------------------------------------

async function writeStandardZip(env: Env, fileName: string, manifest: PackManifest, bodies: Map<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(buildPackZip({ ...manifest, dshVersion: manifest.dshVersion ?? '0.1.0-rc.7' }, bodies)))
  return zipPath
}

/** 非标准 raw zip：任意路径 → 内容（不经 buildPackZip，可无 dsh-pack.yaml）。 */
function rawZip(entries: Record<string, string>): Uint8Array {
  const zip = new AdmZip()
  for (const [rel, content] of Object.entries(entries)) zip.addFile(rel, Buffer.from(content))
  return zip.toBuffer()
}

async function writeRawZip(env: Env, fileName: string, entries: Record<string, string>): Promise<string> {
  const zipPath = path.join(env.root, fileName)
  await writeFile(zipPath, Buffer.from(rawZip(entries)))
  return zipPath
}

/** 真实插件本体目录：package.json + 一个标记文件。 */
async function makePluginBody(env: Env, packageName: string, version = '1.2.3'): Promise<string> {
  const dir = path.join(env.root, 'bodies', ...packageName.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: packageName, version }, null, 2))
  await writeFile(path.join(dir, 'notes.txt'), `hello from ${packageName}`)
  return dir
}

const SKILL_DOC = '---\nname: my-skill\ndescription: A skill.\n---\nBody.\n'

const profileDir = (env: Env, packId: string) => path.join(env.dshHome, 'profiles', packId)

// ===========================================================================
// 场景 A：标准包完整生命周期
// ===========================================================================

describe.skip('legacy pack E2E · 标准包完整生命周期（独立 Profile 语义已废弃）', () => {
  it('分析→离线导入→切换→停用/启用→导出→删除→回导再导入', async () => {
    const env = await makeEnv()
    const sim = createDshSimulator(env.dshHome, env.pluginReceiptsPath)
    const store = makeSettingsStore(env.dshHome)
    const { manager } = makeManager(env, sim, store)

    // 1. 构建并分析一个标准包（带 plugin-bodies）。
    const alphaBody = await makePluginBody(env, 'alpha')
    const manifest: PackManifest = {
      name: 'Alpha Pack',
      description: 'alpha pack',
      version: '1.0.0',
      plugins: [{ packageName: 'alpha', source: 'npm' }],
    }
    const zipPath = await writeStandardZip(env, 'alpha-pack.zip', manifest, new Map([['alpha', alphaBody]]))

    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('zip')
    expect(analysis.id).toBe('pack-alpha-pack')
    expect(analysis.items).toEqual([{ packageName: 'alpha', available: true, offline: true }])

    // 2. 离线导入：本体落到 profile 持久目录，模拟器把它装进 node_modules + 记录 receipt。
    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['alpha'])
    expect(result.state).toBe('complete')
    expect(sim.installCalls).toHaveLength(1)
    expect(sim.installCalls[0].source).toBe('local-directory')

    const packDir = profileDir(env, 'pack-alpha-pack')
    expect(await readFile(path.join(packDir, 'node_modules', 'alpha', 'package.json'), 'utf8')).toContain('"alpha"')
    expect(await readFile(path.join(packDir, 'node_modules', 'alpha', 'notes.txt'), 'utf8')).toBe('hello from alpha')
    // 本体目录持久保留（file: 引用不悬空），且含原始标记文件。
    expect(await readFile(path.join(packDir, '.pack-bodies', 'alpha', 'notes.txt'), 'utf8')).toBe('hello from alpha')

    // profile 状态可被 readProfile 读回：alpha 在 activeBundles。
    const installedProfile = await sim.readProfile(env.dshHome, 'pack-alpha-pack')
    expect(installedProfile.initialized).toBe(true)
    expect(installedProfile.activeBundles).toEqual(['alpha'])

    let records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].source).toBe('zip')
    expect(records[0].plugins).toEqual([{ packageName: 'alpha', enabled: true }])

    // 3. 切换：激活 → 停用 → 再激活。listPacks 反映 enabled。
    expect((await manager.listPacks())[0].enabled).toBe(false)
    await manager.activatePack('pack-alpha-pack')
    expect(store.current.profileName).toBe('pack-alpha-pack')
    expect((await manager.listPacks())[0].enabled).toBe(true)
    await manager.deactivatePack()
    expect(store.current.profileName).toBe('web')
    await manager.activatePack('pack-alpha-pack')

    // 4. 停用/启用单项。
    const disabled = await manager.togglePackItem('pack-alpha-pack', 'alpha', false)
    expect(disabled.plugins.find(p => p.packageName === 'alpha')?.enabled).toBe(false)
    expect((await sim.readProfile(env.dshHome, 'pack-alpha-pack')).activeBundles).toEqual([])
    const reEnabled = await manager.togglePackItem('pack-alpha-pack', 'alpha', true)
    expect(reEnabled.plugins.find(p => p.packageName === 'alpha')?.enabled).toBe(true)
    expect((await sim.readProfile(env.dshHome, 'pack-alpha-pack')).activeBundles).toEqual(['alpha'])

    // 5. 导出：manifest 引用 alpha（local 源），本体进包。
    const { zipPath: exportedZipPath } = await manager.exportPack('pack-alpha-pack')
    const exportedBytes = await readFile(exportedZipPath)
    const inspection = inspectPackZip(exportedBytes)
    expect(inspection.manifest.plugins).toEqual([{ packageName: 'alpha', source: 'local' }])
    expect(inspection.hasBodies).toBe(true)
    expect(inspection.bodyPackageNames).toEqual(['alpha'])
    const exportedZip = new AdmZip(Buffer.from(exportedBytes))
    expect(exportedZip.getEntry('dsh-pack.yaml')!.getData().toString('utf8')).toContain('name: alpha-pack')
    expect(exportedZip.getEntry('plugin-bodies/alpha/notes.txt')!.getData().toString('utf8')).toBe('hello from alpha')

    // 6. 删除当前启用的包：自动停用回 'web'，profile / 注册表 / receipts 全清。
    const removed = await manager.removePack('pack-alpha-pack')
    expect(removed.removed).toBe(1)
    expect(store.current.profileName).toBe('web')
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(existsSync(packDir)).toBe(false)
    expect((await readPluginReceipts(env.pluginReceiptsPath)).filter(r => r.profileName === 'pack-alpha-pack')).toEqual([])

    // 7. 把导出的 zip 写盘回导：包重建、插件可再读回。
    const exportedPath = path.join(env.root, 'roundtrip.zip')
    await writeFile(exportedPath, exportedBytes)
    const reimported = await manager.importPack(exportedPath)
    expect(reimported.installed).toEqual(['alpha'])
    records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('pack-alpha-pack')
    expect((await sim.readProfile(env.dshHome, 'pack-alpha-pack')).activeBundles).toEqual(['alpha'])
  })
})

// ===========================================================================
// 场景 B：raw 包导入（插件 + 技能）与删包技能引用计数
// ===========================================================================

describe.skip('legacy pack E2E · raw 包导入与技能清理（独立 Profile 语义已废弃）', () => {
  it('raw 包插件+技能全局安装、harness-backend 排除、删包按引用计数清理技能', async () => {
    const env = await makeEnv()
    const sim = createDshSimulator(env.dshHome, env.pluginReceiptsPath)
    const store = makeSettingsStore(env.dshHome)
    const { manager } = makeManager(env, sim, store)

    // 非标准包：顶层包裹一层目录；内含两个插件、一个技能、一个含 node_modules 的分发包（应排除）。
    const zipPath = await writeRawZip(env, 'game-pack.zip', {
      'Gaming Pack/plugin-alpha/package.json': JSON.stringify({ name: 'alpha', version: '1.2.3' }),
      'Gaming Pack/plugin-beta/package.json': JSON.stringify({ name: 'beta' }),
      'Gaming Pack/skills/my-skill/SKILL.md': SKILL_DOC,
      'Gaming Pack/harness-backend/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh' }),
      'Gaming Pack/DeepSeek Harness.exe': 'binary',
    })

    // 1. 分析：raw 源，文件名清洗出 name hint，技能项带 kind。
    const analysis = await manager.analyzeImport(zipPath)
    expect(analysis.source).toBe('raw')
    expect(analysis.name).toBe('game-pack')
    expect(analysis.items).toEqual([
      { packageName: 'alpha', available: true, offline: true },
      { packageName: 'beta', available: true, offline: true },
      { packageName: 'my-skill', available: true, offline: true, kind: 'skill' },
    ])

    // 2. 导入（包名覆盖）：插件进 profile，技能全局安装进 <dshHome>/skills/。
    const result = await manager.importPack(zipPath, undefined, { name: 'Game Pack' })
    expect(result.installed).toEqual(['alpha', 'beta', 'my-skill'])
    expect(result.state).toBe('complete')

    const packDir = profileDir(env, 'pack-game-pack')
    expect(await readFile(path.join(packDir, 'node_modules', 'alpha', 'package.json'), 'utf8')).toContain('"alpha"')
    expect(await readFile(path.join(packDir, '.pack-bodies', 'beta', 'package.json'), 'utf8')).toContain('"beta"')
    // 技能真实落盘（经 installSkillFromDirectory）。
    expect(await readFile(path.join(env.dshHome, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('my-skill')

    let records = await readPackRegistry(env.registryPath)
    expect(records).toHaveLength(1)
    expect(records[0].id).toBe('pack-game-pack')
    expect(records[0].source).toBe('raw')
    expect(records[0].plugins).toEqual([
      { packageName: 'alpha', enabled: true },
      { packageName: 'beta', enabled: true },
    ])
    expect(records[0].skills).toEqual([{ name: 'my-skill', format: 'bundle', enabled: true }])

    // 3. 第二个包也引用同名技能 → 删第一个包时技能保留。
    // 注意：单目录 zip 会把唯一顶层目录当包裹层剥离 → 必须放一个同级文件（README）使包裹判定失效。
    const secondZip = await writeRawZip(env, 'second.zip', {
      'README.txt': 'marker to avoid wrapper detection',
      'my-skill/SKILL.md': SKILL_DOC,
    })
    const second = await manager.importPack(secondZip, undefined, { name: 'Second' })
    expect(second.installed).toEqual(['my-skill'])

    await manager.removePack('pack-game-pack')
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1) // 只剩 pack-second
    expect(await readFile(path.join(env.dshHome, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('my-skill')

    // 4. 第二个包删除 → 无其它引用，技能被清理。
    await manager.removePack('pack-second')
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(existsSync(path.join(env.dshHome, 'skills', 'my-skill'))).toBe(false)
    expect(existsSync(profileDir(env, 'pack-second'))).toBe(false)
  })

  it('raw 包 flat 技能装成单 .md，删包清理 .disabled 副本', async () => {
    const env = await makeEnv()
    const sim = createDshSimulator(env.dshHome, env.pluginReceiptsPath)
    const store = makeSettingsStore(env.dshHome)
    const { manager } = makeManager(env, sim, store)

    const zipPath = await writeRawZip(env, 'flat-pack.zip', {
      'quick-ref.md': '---\nname: quick-ref\ndescription: Quick ref.\n---\nBody.\n',
    })
    const result = await manager.importPack(zipPath, undefined, { name: 'Flat Pack' })
    expect(result.installed).toEqual(['quick-ref'])
    const skillFile = path.join(env.dshHome, 'skills', 'quick-ref.md')
    expect(await readFile(skillFile, 'utf8')).toContain('quick-ref')

    await manager.removePack('pack-flat-pack')
    expect(existsSync(skillFile)).toBe(false)
  })
})

// ===========================================================================
// 场景 C：中途失败 → 回滚
// ===========================================================================

describe.skip('legacy pack E2E · 中途失败回滚（独立 Profile 语义已废弃）', () => {
  it('raw 导入单项失败：state=partial，回滚后 profile / 注册表 / 全局技能全部复原', async () => {
    const env = await makeEnv()
    const sim = createDshSimulator(env.dshHome, env.pluginReceiptsPath)
    sim.failOn.add('beta')
    const store = makeSettingsStore(env.dshHome)
    const { manager } = makeManager(env, sim, store)

    const zipPath = await writeRawZip(env, 'partial-pack.zip', {
      'plugin-alpha/package.json': JSON.stringify({ name: 'alpha' }),
      'plugin-beta/package.json': JSON.stringify({ name: 'beta' }),
      'skills/my-skill/SKILL.md': SKILL_DOC,
    })

    // 单项失败不阻断：alpha 与技能装成功，beta 记入 failures → partial。
    const result = await manager.importPack(zipPath, undefined, { name: 'Partial Pack' })
    expect(result.state).toBe('partial')
    expect(result.installed).toEqual(['alpha', 'my-skill'])
    expect(result.failures).toEqual([{ packageName: 'beta', reason: '模拟安装失败：beta' }])
    expect(await readFile(path.join(env.dshHome, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('my-skill')

    const packDir = profileDir(env, 'pack-partial-pack')
    expect(existsSync(packDir)).toBe(true)
    expect(await readPackRegistry(env.registryPath)).toHaveLength(1)
    await expect(manager.hasSnapshot()).resolves.toBe(true)

    // 回滚：profile 目录、注册表记录、全局技能（快照前为空）全部还原。
    const rolledBack = await manager.rollback()
    expect(rolledBack.profileName).toBe('pack-partial-pack')
    expect(existsSync(packDir)).toBe(false)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    expect(existsSync(path.join(env.dshHome, 'skills'))).toBe(false)
    await expect(manager.hasSnapshot()).resolves.toBe(false)
  })
})

// ===========================================================================
// 场景 D：从已装插件创建包 + 追加 / 移除插件项
// ===========================================================================

describe.skip('legacy pack E2E · 从已装插件创建包（独立 Profile 语义已废弃）', () => {
  it('createPack 重建 target、addPackPlugin 追加、removePackItem 移除、removePack 清理', async () => {
    const env = await makeEnv()
    const sim = createDshSimulator(env.dshHome, env.pluginReceiptsPath)
    const store = makeSettingsStore(env.dshHome, 'web')
    const { manager } = makeManager(env, sim, store)

    // 当前 profile 'web' 已装 gamma、delta（有 receipt，npm 源）。
    await recordPluginInstall(env.pluginReceiptsPath, {
      repository: 'demo/owner', packageName: 'gamma', profileName: 'web', source: 'npm',
      subdirectory: null, version: '1.2.3', commit: '', installedAt: new Date().toISOString(),
    })
    await recordPluginInstall(env.pluginReceiptsPath, {
      repository: 'demo/owner', packageName: 'delta', profileName: 'web', source: 'npm',
      subdirectory: null, version: '2.0.0', commit: '', installedAt: new Date().toISOString(),
    })

    // 1. createPack：从 'web' 的 receipt 重建 npm target，装进 pack profile。
    const created = await manager.createPack({ name: 'Built Pack', packageNames: ['gamma'] })
    expect(created.installed).toEqual(['gamma'])
    const gammaTarget = sim.installCalls[0]
    expect(gammaTarget.profileName).toBe('pack-built-pack')
    expect(gammaTarget.source).toBe('npm')
    const builtDir = profileDir(env, 'pack-built-pack')
    expect(await readFile(path.join(builtDir, 'node_modules', 'gamma', 'package.json'), 'utf8')).toContain('"1.2.3"')
    expect((await sim.readProfile(env.dshHome, 'pack-built-pack')).activeBundles).toEqual(['gamma'])

    let records = await readPackRegistry(env.registryPath)
    expect(records[0].source).toBe('created')
    expect(records[0].plugins).toEqual([{ packageName: 'gamma', enabled: true }])

    // 2. addPackPlugin：从当前 'web' profile 的 delta receipt 追加进包。
    const afterAdd = await manager.addPackPlugin('pack-built-pack', 'delta')
    expect(afterAdd.plugins.map(p => p.packageName)).toEqual(['gamma', 'delta'])
    expect((await sim.readProfile(env.dshHome, 'pack-built-pack')).activeBundles).toEqual(['gamma', 'delta'])

    // 3. removePackItem：从包移除 delta（node_modules + 注册表都清）。
    const afterRemove = await manager.removePackItem('pack-built-pack', 'delta')
    expect(afterRemove.plugins.map(p => p.packageName)).toEqual(['gamma'])
    expect((await sim.readProfile(env.dshHome, 'pack-built-pack')).activeBundles).toEqual(['gamma'])
    expect(existsSync(path.join(builtDir, 'node_modules', 'delta'))).toBe(false)

    // 4. removePack：清 profile 目录 + 注册表 + 该包 receipts（'web' 的 receipt 保留）。
    await manager.removePack('pack-built-pack')
    expect(existsSync(builtDir)).toBe(false)
    expect(await readPackRegistry(env.registryPath)).toEqual([])
    const receipts = await readPluginReceipts(env.pluginReceiptsPath)
    expect(receipts.filter(r => r.profileName === 'pack-built-pack')).toEqual([])
    expect(receipts.filter(r => r.profileName === 'web').map(r => r.packageName).sort()).toEqual(['delta', 'gamma'])
  })
})

describe.skip('legacy pack E2E · Agent 预设（独立 Profile 语义已废弃）', () => {
  it('导入含预设的整合包后记录预设，删除包时清理全局预设', async () => {
    const env = await makeEnv()
    const sim = createDshSimulator(env.dshHome, env.pluginReceiptsPath)
    const store = makeSettingsStore(env.dshHome)
    const { manager } = makeManager(env, sim, store)

    const manifest: PackManifest = {
      name: 'Preset E2E',
      description: 'preset e2e',
      version: '1.0.0',
      plugins: [],
      presets: [{
        name: 'router-standard',
        repository: 'demo/preset-repo',
        sourcePath: 'preset/router-standard',
        revision: 'abc1234',
      }],
    }
    const zipPath = await writeStandardZip(env, 'preset-e2e.zip', manifest, new Map())

    const result = await manager.importPack(zipPath)
    expect(result.installed).toEqual(['router-standard'])
    expect(result.state).toBe('complete')
    const presetDir = path.join(env.dshHome, '.agent-presets', 'router-standard')
    expect(existsSync(path.join(presetDir, 'preset.yml'))).toBe(true)

    let records = await readPackRegistry(env.registryPath)
    expect(records[0].presets).toEqual([{ name: 'router-standard', enabled: true }])

    await manager.removePack('pack-preset-e2e')
    expect(existsSync(presetDir)).toBe(false)
    records = await readPackRegistry(env.registryPath)
    expect(records).toEqual([])
  })
})
