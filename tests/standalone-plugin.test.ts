import childProcess, { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
// 真实文件系统/子进程操作在并行与慢盘环境下会超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 })
import { parse } from 'yaml'
import { exportStandalonePlugin, importStandalonePlugin } from '../electron/standalone-plugin'
import { STANDALONE_PLUGIN_DIRECTORY, standalonePluginPackageRoot } from '../electron/standalone-plugin-links'
import { readPluginReceipts } from '../electron/plugin-receipts'
import { inspectStandaloneNodeRuntime, type StandaloneNativeRuntime } from '../electron/standalone-plugin-native'

const roots: string[] = []
const runNode = promisify(execFile)
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface ArtifactManifest {
  name: string
  nativeRuntime?: StandaloneNativeRuntime
  members: string[]
  packages: Array<{ id: string; name: string; version: string; dependencies: Record<string, { package: string } | { host: string; version: string }> }>
  files: Record<string, { sha256: string; mode: number }>
}

async function packageAt(directory: string, name: string, version: string, fields: Record<string, unknown> = {}, code = `export default '${name}@${version}';`) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module', exports: './index.js', ...fields }))
  await writeFile(path.join(directory, 'index.js'), code)
  return directory
}

async function link(target: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true })
  await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-standalone-e2e-'))
  roots.push(root)
  const sourceStore = path.join(root, 'source-store')
  const profileDirectory = path.join(root, 'source-profile')
  const dshHome = path.join(root, 'recipient')
  const profileName = 'target'
  const profileFile = path.join(dshHome, 'profiles', profileName, 'package.json')
  const pluginReceiptsPath = path.join(root, 'receipts.json')
  const hostPath = path.join(root, 'host', 'node_modules')
  const host = await packageAt(path.join(hostPath, '@deepseek-ai', 'dsh-base'), '@deepseek-ai/dsh-base', '1.0.0', {}, 'export default "host-core";')
  const shared1 = await packageAt(path.join(sourceStore, '.pnpm', 'shared@1', 'node_modules', 'suite-shared-dep'), 'suite-shared-dep', '1.0.0')
  const shared2 = await packageAt(path.join(sourceStore, '.pnpm', 'shared@2', 'node_modules', 'suite-shared-dep'), 'suite-shared-dep', '2.0.0')
  const packages: Record<string, string> = {}
  for (const [name, version, shared] of [['alpha', '1.0.0', shared1], ['beta', '2.0.0', shared2]] as const) {
    const directory = path.join(sourceStore, '.pnpm', `${name}@${version}`, 'node_modules', name)
    await packageAt(directory, name, version, {
      dependencies: { 'suite-shared-dep': version, '@deepseek-ai/dsh-base': '1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      scripts: { postinstall: 'node -e "throw new Error(\'unexpected lifecycle\')"' },
    }, `import shared from 'suite-shared-dep'; import host from '@deepseek-ai/dsh-base'; export default '${name}:' + shared + ':' + host;`)
    await writeFile(path.join(directory, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`)
    await link(shared, path.join(path.dirname(directory), 'suite-shared-dep'))
    await link(host, path.join(path.dirname(directory), '@deepseek-ai', 'dsh-base'))
    await link(directory, path.join(profileDirectory, 'node_modules', name))
    packages[name] = directory
  }
  const inactive = await packageAt(path.join(sourceStore, 'inactive'), 'inactive', '1.0.0', { dsh: { bundle: { patch: './cordis.patch.yml' } } }, 'throw new Error("inactive member must not load");')
  await writeFile(path.join(inactive, 'cordis.patch.yml'), '- insert:\n    - id: inactive\n      name: inactive\n')
  await link(inactive, path.join(profileDirectory, 'node_modules', 'inactive'))
  await writeFile(path.join(profileDirectory, 'package.json'), JSON.stringify({
    name: 'source-profile', private: true,
    dependencies: { alpha: '1.0.0', beta: '2.0.0', inactive: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'beta', 'alpha'] } },
  }))
  await mkdir(path.dirname(profileFile), { recursive: true })
  const previousProfile = `${JSON.stringify({ name: 'target', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`
  await writeFile(profileFile, previousProfile)
  const archivePath = path.join(root, 'fixture.dsh-plugin.zip')
  const exportOptions = { profileDirectory, dshVersion: '1.0.0', version: '1.0.0', outputPath: archivePath }
  const importOptions = { archivePath, dshHome, profileName, pluginReceiptsPath, hostNodeModules: vi.fn(async () => hostPath) }
  return { root, sourceStore, profileDirectory, profileFile, previousProfile, packages, archivePath, exportOptions, importOptions, hostPath }
}

function manifestIn(zip: AdmZip): ArtifactManifest {
  return JSON.parse(zip.readAsText('standalone.json')) as ArtifactManifest
}

async function assertUnchanged(env: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(env.profileFile, 'utf8')).toBe(env.previousProfile)
  expect(await readPluginReceipts(env.importOptions.pluginReceiptsPath)).toEqual([])
  await expect(stat(path.join(path.dirname(env.profileFile), 'node_modules', 'dsh-suite-source-profile'))).rejects.toMatchObject({ code: 'ENOENT' })
  const root = standalonePluginPackageRoot(env.importOptions.dshHome, 'dsh-suite-source-profile')
  expect(await readdir(root).catch(() => [])).toEqual([])
}

async function anotherRecipient(env: Awaited<ReturnType<typeof fixture>>, profileName = 'second') {
  const directory = path.join(env.importOptions.dshHome, 'profiles', profileName)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), env.previousProfile)
  return { directory, options: { ...env.importOptions, profileName } }
}

describe('standalone plugin artifacts', () => {
  const nativeRuntime = (): StandaloneNativeRuntime => ({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi ?? null, platform: process.platform, arch: process.arch })

  it('copies native binaries unchanged and records the selected Node runtime, without executing them', async () => {
    const env = await fixture()
    const binary = Buffer.from([0x4d, 0x5a, 0, 255, 7, 12])
    await writeFile(path.join(env.packages.alpha, 'addon.node'), binary)
    const resolveRuntime = vi.fn(async () => nativeRuntime())
    await exportStandalonePlugin({ ...env.exportOptions, nativeRuntime: resolveRuntime })
    expect(resolveRuntime).toHaveBeenCalledTimes(1)
    const zip = new AdmZip(env.archivePath)
    const manifest = manifestIn(zip)
    expect(manifest.nativeRuntime).toEqual(nativeRuntime())
    expect(JSON.parse(zip.readAsText('package.json')).dsh.standalone.nativeRuntime).toEqual(nativeRuntime())
    const filename = Object.keys(manifest.files).find(name => name.endsWith('/addon.node'))!
    expect(zip.readFile(filename)).toEqual(binary)
    await rm(env.sourceStore, { recursive: true, force: true })
    const fetch = vi.fn(() => { throw new Error('unexpected network') })
    vi.stubGlobal('fetch', fetch)
    const execute = vi.spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('must not load binary or build') })
    await importStandalonePlugin({ ...env.importOptions, nativeRuntime: resolveRuntime })
    const installed = await realpath(path.join(path.dirname(env.profileFile), 'node_modules', manifest.name))
    expect(await readFile(path.join(installed, filename))).toEqual(binary)
    expect(resolveRuntime).toHaveBeenCalledTimes(2)
    expect(fetch).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['missing resolver', 'different ABI', 'missing metadata', 'inconsistent metadata'])('rejects native artifacts with %s before changing the Profile', async problem => {
    const env = await fixture()
    await writeFile(path.join(env.packages.alpha, 'addon.node'), 'not executed during validation')
    await exportStandalonePlugin({ ...env.exportOptions, nativeRuntime: async () => nativeRuntime() })
    const zip = new AdmZip(env.archivePath)
    const manifest = manifestIn(zip)
    if (problem === 'missing metadata') delete manifest.nativeRuntime
    if (problem === 'inconsistent metadata') manifest.nativeRuntime = { ...nativeRuntime(), node: `${process.versions.node.split('.')[0]}.0.0` }
    zip.updateFile('standalone.json', Buffer.from(JSON.stringify(manifest)))
    await writeFile(env.archivePath, zip.toBuffer())
    const runtime = problem === 'missing resolver' ? undefined : async () => ({ ...nativeRuntime(), ...(problem === 'different ABI' ? { modules: '1' } : {}) })
    await expect(importStandalonePlugin({ ...env.importOptions, nativeRuntime: runtime })).rejects.toThrow(/Node|原生/)
    await assertUnchanged(env)
  })

  it('exports and loads the actual lightningcss native dependency from the private artifact', async () => {
    const env = await fixture()
    const lightningcss = path.resolve('node_modules/lightningcss')
    const nativeVersion = JSON.parse(await readFile(path.join(lightningcss, 'package.json'), 'utf8')).version
    const sourceManifest = JSON.parse(await readFile(path.join(env.packages.alpha, 'package.json'), 'utf8'))
    sourceManifest.dependencies.lightningcss = nativeVersion
    await writeFile(path.join(env.packages.alpha, 'package.json'), JSON.stringify(sourceManifest))
    await writeFile(path.join(env.packages.alpha, 'index.js'), `import { transform } from 'lightningcss'; export default transform({filename:'a.css', code:Buffer.from('.x { color: #ff0000; }'), minify:true}).code.toString();`)
    await link(lightningcss, path.join(env.packages.alpha, 'node_modules', 'lightningcss'))
    const selectedRuntime = await inspectStandaloneNodeRuntime(process.execPath)
    await exportStandalonePlugin({ ...env.exportOptions, nativeRuntime: async () => selectedRuntime })
    const manifest = manifestIn(new AdmZip(env.archivePath))
    expect(manifest.packages.some(item => item.name.startsWith('lightningcss-'))).toBe(true)
    expect(Object.keys(manifest.files).some(filename => filename.endsWith('.node'))).toBe(true)
    await rm(env.sourceStore, { recursive: true, force: true })
    await rm(env.profileDirectory, { recursive: true, force: true })
    await importStandalonePlugin({ ...env.importOptions, nativeRuntime: async () => selectedRuntime })
    const installed = await realpath(path.join(path.dirname(env.profileFile), 'node_modules', manifest.name))
    const patches = parse(await readFile(path.join(installed, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    const entry = patches.flatMap(patch => patch.insert).find(item => item.id === 'alpha')!.name
    const { stdout } = await runNode(process.execPath, ['--input-type=module', '-e', `import { createRequire } from 'node:module'; const css = (await import(process.argv[1])).default; const binaries = Object.keys(createRequire(import.meta.url).cache).filter(file => file.endsWith('.node')); process.stdout.write(JSON.stringify({css,binaries}));`, entry], { cwd: env.root, timeout: 10_000, windowsHide: true })
    const result = JSON.parse(stdout) as { css: string; binaries: string[] }
    expect(result.css).toBe('.x{color:red}')
    expect(result.binaries.length).toBeGreaterThan(0)
    expect(result.binaries.every(file => file.startsWith(`${installed}${path.sep}`))).toBe(true)
  })

  it('preserves member order and conflicting private dependency versions after removing all original sources, without invoking a package manager', async () => {
    const env = await fixture()
    const fetch = vi.fn(async () => { throw new Error('unexpected network request') })
    vi.stubGlobal('fetch', fetch)
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('unexpected package manager') })
    const execute = vi.spyOn(childProcess, 'execFile').mockImplementation(() => { throw new Error('unexpected command') })
    await exportStandalonePlugin(env.exportOptions)
    const zip = new AdmZip(env.archivePath)
    const manifest = manifestIn(zip)
    expect(manifest.packages.filter(item => item.name === 'suite-shared-dep').map(item => item.version).sort()).toEqual(['1.0.0', '2.0.0'])
    expect(manifest.members.map(id => manifest.packages.find(item => item.id === id)?.name)).toEqual(['beta', 'alpha'])
    expect(manifest.packages.some(item => item.name === 'inactive' || item.name === '@deepseek-ai/dsh-base')).toBe(false)
    expect(zip.getEntries().some(entry => entry.entryName.includes('/node_modules/'))).toBe(false)
    await rm(env.sourceStore, { recursive: true, force: true })
    await rm(env.profileDirectory, { recursive: true, force: true })
    const imported = await importStandalonePlugin(env.importOptions)
    const current = JSON.parse(await readFile(env.profileFile, 'utf8'))
    expect(Object.keys(current.dependencies)).toEqual(['dsh-suite-source-profile'])
    expect(current.dsh.profile.bundles).toEqual(['dsh-suite-source-profile'])
    expect(imported.plugins.filter(plugin => !plugin.builtin).map(plugin => plugin.packageName)).toEqual(['dsh-suite-source-profile'])
    expect(env.importOptions.hostNodeModules).toHaveBeenCalledWith('1.0.0')
    expect(fetch).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    spawn.mockRestore()
    execute.mockRestore()
    const installedDirectory = await realpath(path.join(path.dirname(env.profileFile), 'node_modules', 'dsh-suite-source-profile'))
    const patches = parse(await readFile(path.join(installedDirectory, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(patches.map(item => item.insert[0].id)).toEqual(['beta', 'alpha'])
    const entries = patches.map(item => item.insert[0].name)
    expect(entries.every(entry => entry.startsWith('file:'))).toBe(true)
    const { stdout } = await runNode(process.execPath, [
      '--input-type=module', '-e', 'const result = []; for (const file of JSON.parse(process.argv[1])) result.push((await import(file)).default); process.stdout.write(JSON.stringify(result));',
      JSON.stringify(entries),
    ], { timeout: 10_000, windowsHide: true })
    expect(JSON.parse(stdout)).toEqual(['beta:suite-shared-dep@2.0.0:host-core', 'alpha:suite-shared-dep@1.0.0:host-core'])
    expect(await readPluginReceipts(env.importOptions.pluginReceiptsPath)).toEqual([expect.objectContaining({ packageName: 'dsh-suite-source-profile', source: 'local-directory', actualSource: 'local', version: '1.0.0' })])
  })

  it('refuses export when a required dependency is missing', async () => {
    const env = await fixture()
    await rm(path.join(path.dirname(env.packages.alpha), 'suite-shared-dep'), { recursive: true, force: true })
    await expect(exportStandalonePlugin(env.exportOptions)).rejects.toThrow('缺少依赖 suite-shared-dep')
    await expect(stat(env.archivePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await assertUnchanged(env)
  })

  it.each(['tampered hash', 'missing dependency file', 'missing dependency target', 'missing dependency edge'])('rejects %s without registering a partial plugin', async problem => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    const zip = new AdmZip(env.archivePath)
    const manifest = manifestIn(zip)
    const dependency = manifest.packages.find(item => item.name === 'suite-shared-dep')!
    const filename = `private/packages/${dependency.id}/index.js`
    if (problem === 'tampered hash') zip.updateFile(filename, Buffer.from('export default "tampered";'))
    else if (problem === 'missing dependency file') zip.deleteFile(filename)
    else {
      if (problem === 'missing dependency edge') delete manifest.packages.find(item => item.name === 'alpha')!.dependencies['suite-shared-dep']
      else manifest.packages = manifest.packages.filter(item => item.id !== dependency.id)
      zip.updateFile('standalone.json', Buffer.from(JSON.stringify(manifest)))
    }
    await writeFile(env.archivePath, zip.toBuffer())
    await expect(importStandalonePlugin(env.importOptions)).rejects.toThrow(problem === 'tampered hash' ? '校验失败' : problem === 'missing dependency file' ? '缺少清单声明' : /依赖/)
    await assertUnchanged(env)
  })

  it('rejects ZIP traversal before modifying the destination Profile', async () => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    const zip = new AdmZip(env.archivePath)
    // Rewrite equal-length filenames in local/central headers; ZIP builders sanitize traversal inputs.
    zip.addFile('xxxoutside.txt', Buffer.from('unsafe'))
    const bytes = zip.toBuffer()
    const original = Buffer.from('xxxoutside.txt')
    const unsafe = Buffer.from('../outside.txt')
    expect(unsafe.length).toBe(original.length)
    let replacements = 0
    for (let offset = bytes.indexOf(original); offset >= 0; offset = bytes.indexOf(original, offset + unsafe.length)) {
      unsafe.copy(bytes, offset)
      replacements++
    }
    expect(replacements).toBe(2)
    await writeFile(env.archivePath, bytes)
    await expect(importStandalonePlugin(env.importOptions)).rejects.toThrow()
    await assertUnchanged(env)
    await expect(stat(path.join(env.root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back extracted private packages when required host dependencies cannot be provided', async () => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    await rm(path.join(env.hostPath, '@deepseek-ai', 'dsh-base'), { recursive: true, force: true })
    await expect(importStandalonePlugin(env.importOptions)).rejects.toThrow('未提供兼容的宿主依赖')
    await assertUnchanged(env)
  })

  it.each(['missing package', 'missing subpath'])('validates YAML-only host imports with a %s before registering the plugin', async problem => {
    const env = await fixture()
    const specifier = problem === 'missing package' ? '@deepseek-ai/dsh-absent' : '@deepseek-ai/dsh-base/absent'
    await writeFile(path.join(env.packages.alpha, 'cordis.patch.yml'), `- insert:\n    - id: host-only\n      name: "${specifier}"\n`)
    await exportStandalonePlugin(env.exportOptions)
    await expect(importStandalonePlugin(env.importOptions)).rejects.toThrow(/宿主依赖|宿主模块/)
    await assertUnchanged(env)
  })

  it('finds YAML-only host modules through the installed DSH boot dependency graph', async () => {
    const env = await fixture()
    const dsh = await packageAt(path.join(env.hostPath, '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', '1.0.0')
    const boot = await packageAt(path.join(dsh, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), '@deepseek-ai/dsh-app-boot', '1.0.0')
    await packageAt(path.join(boot, 'node_modules', '@deepseek-ai', 'dsh-host-only'), '@deepseek-ai/dsh-host-only', '1.0.0')
    await writeFile(path.join(env.packages.alpha, 'cordis.patch.yml'), '- insert:\n    - id: host-only\n      name: "@deepseek-ai/dsh-host-only"\n')
    await exportStandalonePlugin(env.exportOptions)
    await importStandalonePlugin(env.importOptions)
    expect(JSON.parse(await readFile(env.profileFile, 'utf8')).dsh.profile.bundles).toEqual(['dsh-suite-source-profile'])
  })

  it('preserves an existing output archive when export fails while collecting package files', async () => {
    const env = await fixture()
    const previous = Buffer.from('existing export must survive')
    await writeFile(env.archivePath, previous)
    await writeFile(path.join(env.packages.alpha, 'unsupported.node'), 'not portable')
    await expect(exportStandalonePlugin(env.exportOptions)).rejects.toThrow('原生 Node 模块')
    expect(await readFile(env.archivePath)).toEqual(previous)
    expect((await readdir(env.root)).some(name => name.startsWith('standalone-export-'))).toBe(false)
  })

  it('reuses a validated artifact in another Profile without exposing internal members', async () => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    await importStandalonePlugin(env.importOptions)
    const firstProfile = await readFile(env.profileFile, 'utf8')
    const second = await anotherRecipient(env)
    const imported = await importStandalonePlugin(second.options)
    const secondProfile = JSON.parse(await readFile(path.join(second.directory, 'package.json'), 'utf8'))
    expect(Object.keys(secondProfile.dependencies)).toEqual(['dsh-suite-source-profile'])
    expect(secondProfile.dsh.profile.bundles).toEqual(['dsh-suite-source-profile'])
    expect(imported.plugins.filter(plugin => !plugin.builtin).map(plugin => plugin.packageName)).toEqual(['dsh-suite-source-profile'])
    expect(await realpath(path.join(second.directory, 'node_modules', 'dsh-suite-source-profile'))).toBe(
      await realpath(path.join(path.dirname(env.profileFile), 'node_modules', 'dsh-suite-source-profile')),
    )
    expect(await readFile(env.profileFile, 'utf8')).toBe(firstProfile)
    expect((await readPluginReceipts(env.importOptions.pluginReceiptsPath)).map(receipt => receipt.profileName).sort()).toEqual(['second', 'target'])
  })

  it('refuses a corrupted existing artifact without registering it in another Profile', async () => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    await importStandalonePlugin(env.importOptions)
    const firstProfile = await readFile(env.profileFile, 'utf8')
    const installedDirectory = await realpath(path.join(path.dirname(env.profileFile), 'node_modules', 'dsh-suite-source-profile'))
    const manifest = manifestIn(new AdmZip(env.archivePath))
    const member = manifest.packages.find(item => item.name === 'alpha')!
    await writeFile(path.join(installedDirectory, 'private', 'packages', member.id, 'index.js'), 'export default "changed";')
    const second = await anotherRecipient(env)
    await expect(importStandalonePlugin(second.options)).rejects.toThrow('内容不一致')
    expect(await readFile(path.join(second.directory, 'package.json'), 'utf8')).toBe(env.previousProfile)
    await expect(stat(path.join(second.directory, 'node_modules', 'dsh-suite-source-profile'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(env.profileFile, 'utf8')).toBe(firstProfile)
    expect((await readPluginReceipts(env.importOptions.pluginReceiptsPath)).map(receipt => receipt.profileName)).toEqual(['target'])
  })

  it('refuses a redirected materialized patch on artifact reuse without writing through its symlink', async context => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    await importStandalonePlugin(env.importOptions)
    const firstProfile = await readFile(env.profileFile, 'utf8')
    const directory = await realpath(path.join(path.dirname(env.profileFile), 'node_modules', 'dsh-suite-source-profile'))
    const patch = path.join(directory, 'cordis.patch.yml')
    const external = path.join(env.root, 'external-patch.yml')
    const original = 'external file must remain unchanged\n'
    await writeFile(external, original)
    await rm(patch)
    try {
      await symlink(external, patch, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip('File symlinks require Windows Developer Mode or elevation.')
      throw error
    }
    const second = await anotherRecipient(env)
    const error = await importStandalonePlugin(second.options).then(() => null, error => error)
    expect(await readFile(external, 'utf8')).toBe(original)
    expect(error).toBeInstanceOf(Error)
    expect(await readFile(path.join(second.directory, 'package.json'), 'utf8')).toBe(env.previousProfile)
    await expect(stat(path.join(second.directory, 'node_modules', 'dsh-suite-source-profile'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(env.profileFile, 'utf8')).toBe(firstProfile)
    expect((await readPluginReceipts(env.importOptions.pluginReceiptsPath)).map(receipt => receipt.profileName)).toEqual(['target'])
  })

  it('rejects inconsistent outer runtime metadata even when its file checksum is valid', async () => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    const zip = new AdmZip(env.archivePath)
    const manifest = manifestIn(zip)
    const outer = JSON.parse(zip.readAsText('package.json'))
    outer.dsh.standalone.dshVersion = '2.0.0'
    const outerBytes = Buffer.from(JSON.stringify(outer))
    manifest.files['package.json'].sha256 = createHash('sha256').update(outerBytes).digest('hex')
    zip.updateFile('package.json', outerBytes)
    zip.updateFile('standalone.json', Buffer.from(JSON.stringify(manifest)))
    await writeFile(env.archivePath, zip.toBuffer())
    await expect(importStandalonePlugin(env.importOptions)).rejects.toThrow(/不一致|版本/)
    await assertUnchanged(env)
  })

  it('refuses a redirected dedicated root without creating anything in its external target', async () => {
    const env = await fixture()
    await exportStandalonePlugin(env.exportOptions)
    const external = path.join(env.root, 'external')
    await mkdir(external)
    await link(external, path.join(env.importOptions.dshHome, STANDALONE_PLUGIN_DIRECTORY))
    await expect(importStandalonePlugin(env.importOptions)).rejects.toThrow('重定向')
    expect(await readdir(external)).toEqual([])
    await assertUnchanged(env)
  })

  it('resolves conditional package exports with import conditions instead of require conditions', async () => {
    const env = await fixture()
    const manifestFile = path.join(env.packages.alpha, 'package.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.exports = { import: './esm.js', require: './cjs.cjs' }
    await writeFile(manifestFile, JSON.stringify(manifest))
    await writeFile(path.join(env.packages.alpha, 'esm.js'), 'import shared from "suite-shared-dep"; export default "esm:" + shared;')
    await writeFile(path.join(env.packages.alpha, 'cjs.cjs'), 'throw new Error("require condition must not load");')
    await exportStandalonePlugin(env.exportOptions)
    const zip = new AdmZip(env.archivePath)
    const template = parse(zip.readAsText('patch-template.yaml')) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(template.find(item => item.insert[0].id === 'alpha')!.insert[0].name).toMatch(/\/esm\.js$/)
    await importStandalonePlugin(env.importOptions)
    const directory = await realpath(path.join(path.dirname(env.profileFile), 'node_modules', 'dsh-suite-source-profile'))
    const patches = parse(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string }> }>
    const entry = patches.find(item => item.insert[0].id === 'alpha')!.insert[0].name
    const { stdout } = await runNode(process.execPath, [
      '--input-type=module', '-e', 'process.stdout.write((await import(process.argv[1])).default);', entry,
    ], { timeout: 10_000, windowsHide: true })
    expect(stdout).toBe('esm:suite-shared-dep@1.0.0')
  })
})
