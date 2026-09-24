import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
// 真实文件系统/子进程操作在并行与慢盘环境下会超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 })
import { parse } from 'yaml'
import { buildStandalonePluginPatch, materializeStandalonePluginPatch, standalonePatchHostModules, type StandalonePatchLayer } from '../electron/standalone-plugin-patch'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function layerFixture(packageName: string, yaml: string, index = 0): Promise<StandalonePatchLayer> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-standalone-patch-'))
  roots.push(root)
  await mkdir(path.join(root, 'dist'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: packageName, dsh: { bundle: { patch: 'dist/cordis.patch.yml' } } }))
  await writeFile(path.join(root, 'dist', 'cordis.patch.yml'), yaml)
  return { packageName, sourceDirectory: root, archiveDirectory: `private/packages/p${String(index).padStart(4, '0')}` }
}

const resolveModule = vi.fn(async (_name: string, layer: StandalonePatchLayer) => ({ archivePath: `${layer.archiveDirectory}/lib/index.js` }))

describe('standalone plugin patches', () => {
  it('merges layers in order and relocates matching name assertions to the same private module', async () => {
    const first = await layerFixture('first', '- insert:\n    - id: first\n      name: first\n      config:\n        value: 1\n')
    const second = await layerFixture('second', '- id: first\n  name: first\n  config:\n    value: 2\n- insert:\n    - id: second\n      name: second\n', 1)
    const template = await buildStandalonePluginPatch([first, second], { resolveModule })
    const patches = parse(template)
    expect(patches.map((patch: { id?: string; insert?: Array<{ id: string }> }) => patch.id ?? patch.insert?.[0].id)).toEqual(['first', 'first', 'second'])
    expect(patches[0].insert[0].name).toBe('dsh-standalone:/private/packages/p0000/lib/index.js')
    expect(patches[1].name).toBe(patches[0].insert[0].name)
    expect(patches[2].insert[0].name).toBe('dsh-standalone:/private/packages/p0001/lib/index.js')
    expect(patches[1].config.value).toBe(2)
  })

  it('passes the original patch path to the resolver and expands nested group module names', async () => {
    const layer = await layerFixture('nested', '- insert:\n    - id: group\n      name: cordis:group\n      group: true\n      config:\n        - id: child\n          name: ./entry.js\n')
    const resolver = vi.fn(async () => ({ archivePath: `${layer.archiveDirectory}/dist/entry.js` }))
    const patches = parse(await buildStandalonePluginPatch([layer], { resolveModule: resolver }))
    expect(resolver).toHaveBeenCalledWith('./entry.js', layer, path.join(layer.sourceDirectory, 'dist', 'cordis.patch.yml'))
    expect(patches[0].insert[0].name).toBe('cordis:group')
    expect(patches[0].insert[0].config[0].name).toBe('dsh-standalone:/private/packages/p0000/dist/entry.js')
  })

  it('keeps runtime-owned module names unchanged when the resolver explicitly marks them as host modules', async () => {
    const layer = await layerFixture('host-user', '- insert:\n    - id: group\n      name: "@deepseek-ai/cordis-plugin-group"\n      group: true\n      config: []\n')
    const patches = parse(await buildStandalonePluginPatch([layer], { resolveModule: async () => ({ host: true }) }))
    expect(patches[0].insert[0].name).toBe('@deepseek-ai/cordis-plugin-group')
  })

  it('round-trips path-independent !!js without evaluating it', async () => {
    const layer = await layerFixture('expressions', '- insert:\n    - id: demo\n      name: demo\n      disabled: !!js "process.env.DSH_DISABLED === \'1\'"\n      config:\n        count: !!js "1 + 2"\n')
    const template = await buildStandalonePluginPatch([layer], { resolveModule })
    expect(template).toContain('!!js "process.env.DSH_DISABLED === \'1\'"')
    const materialized = materializeStandalonePluginPatch(template, path.join(layer.sourceDirectory, 'installed with spaces'))
    expect(materialized).toContain('!!js "1 + 2"')
    expect(materialized).toContain(pathToFileURL(path.join(layer.sourceDirectory, 'installed with spaces', 'private', 'packages', 'p0000', 'lib', 'index.js')).href)
    expect(materialized).not.toContain('dsh-standalone:/')
  })

  it('expands independent YAML aliases without sharing relocated state', async () => {
    const layer = await layerFixture('aliases', '- insert:\n    - &plugin\n      id: demo\n      name: demo\n    - *plugin\n')
    const patches = parse(await buildStandalonePluginPatch([layer], { resolveModule }))
    expect(patches[0].insert.map((entry: { name: string }) => entry.name)).toEqual([
      'dsh-standalone:/private/packages/p0000/lib/index.js',
      'dsh-standalone:/private/packages/p0000/lib/index.js',
    ])
  })

  it('relocates children introduced by a group config replacement', async () => {
    const layer = await layerFixture('replacement', '- insert:\n    - id: group\n      name: cordis:group\n      group: true\n      config: []\n- id: group\n  config:\n    - id: child\n      name: child\n')
    const patches = parse(await buildStandalonePluginPatch([layer], { resolveModule }))
    expect(patches[1].config[0].name).toBe('dsh-standalone:/private/packages/p0000/lib/index.js')
  })

  it('requires explicit group typing when replacing an inherited target with an entry array', async () => {
    const ambiguous = '- id: inherited-group\n  config:\n    - id: child\n      name: child\n'
    const layer = await layerFixture('inherited', ambiguous)
    await expect(buildStandalonePluginPatch([layer], { resolveModule })).rejects.toThrow('显式声明 group: true')
    expect(() => materializeStandalonePluginPatch(ambiguous, layer.sourceDirectory)).toThrow('显式声明 group: true')
    const explicit = ambiguous.replace('  config:', '  group: true\n  config:')
    await writeFile(path.join(layer.sourceDirectory, 'dist', 'cordis.patch.yml'), explicit)
    const template = await buildStandalonePluginPatch([layer], { resolveModule })
    expect(parse(materializeStandalonePluginPatch(template, layer.sourceDirectory))[0].config[0].name).toMatch(/^file:/)
  })

  it.each([
    ['dynamic name', '- insert:\n    - id: demo\n      name: !!js "process.env.PLUGIN"\n', '静态模块名称'],
    ['nested include', '- insert:\n    - id: nested\n      name: cordis:include\n      config:\n        path: ./plugins.yml\n', '嵌套 include'],
    ['relative config', '- insert:\n    - id: demo\n      name: demo\n      config:\n        asset: ./assets/icon.png\n', '配置含路径'],
    ['dynamic imports', '- insert:\n    - id: demo\n      name: demo\n      config: !!js "import(\'./config.js\')"\n', '无法可靠迁移'],
    ['module-name guards', '- insert:\n    - id: demo\n      name: demo\n      disabled: !!js "ctx.loader.entries().some(e => e.options.name === \'demo\')"\n', '原始模块名称'],
    ['relative name assertions', '- insert:\n    - id: demo\n      name: ./entry.js\n- id: demo\n  name: ./entry.js\n  disabled: true\n', 'name 断言使用本地路径'],
    ['unknown tag', '- insert: !custom []\n', 'YAML 无法安全读取'],
    ['non-array document', 'name: demo\n', 'YAML 数组'],
  ])('rejects %s with an actionable plugin-scoped error', async (_label, yaml, message) => {
    const layer = await layerFixture('problematic-plugin', yaml)
    await expect(buildStandalonePluginPatch([layer], { resolveModule })).rejects.toThrow(`无法导出复合插件「problematic-plugin」`)
    await expect(buildStandalonePluginPatch([layer], { resolveModule })).rejects.toThrow(message)
  })

  it('rejects patch files outside the copied package', async () => {
    const layer = await layerFixture('escape', '[]\n')
    const other = await layerFixture('other', '[]\n')
    await expect(buildStandalonePluginPatch([{ ...layer, patchPath: path.join(other.sourceDirectory, 'dist', 'cordis.patch.yml') }], { resolveModule })).rejects.toThrow('插件本体之外')
  })

  it('rejects resolved modules outside the artifact private package tree', async () => {
    const layer = await layerFixture('escape', '- insert:\n    - name: demo\n')
    await expect(buildStandalonePluginPatch([layer], { resolveModule: async () => ({ archivePath: 'private/packages/../../external.js' }) })).rejects.toThrow('越界')
  })

  it('rejects a private relative module resolved as a host module', async () => {
    const layer = await layerFixture('private', '- insert:\n    - name: ./entry.js\n')
    await expect(buildStandalonePluginPatch([layer], { resolveModule: async () => ({ host: true }) })).rejects.toThrow('不能回退到宿主')
  })

  it('rejects tampered traversal tokens at materialization', () => {
    expect(() => materializeStandalonePluginPatch('- insert:\n    - name: dsh-standalone:/private/packages/../../escape.js\n', path.resolve('fixture'))).toThrow('越界')
  })

  it('requires template module entries to exist in the verified archive file list', () => {
    const template = '- insert:\n    - name: dsh-standalone:/private/packages/p00000/lib/missing.js\n'
    expect(() => materializeStandalonePluginPatch(template, path.resolve('fixture'), new Set(['private/packages/p00000/package.json']))).toThrow('私有模块文件未包含在制品中')
    expect(materializeStandalonePluginPatch(template, path.resolve('fixture'), new Set(['private/packages/p00000/lib/missing.js']))).toContain('file:')
  })

  it.each(['file:///C:/outside/plugin.js', 'outside-plugin', '../outside.js'])('rejects unbound imported module names: %s', name => {
    expect(() => materializeStandalonePluginPatch(`- insert:\n    - name: ${JSON.stringify(name)}\n`, path.resolve('fixture'))).toThrow('未固定到私有本体或宿主')
  })

  it('rejects unsafe imported expressions without evaluating them', () => {
    expect(() => materializeStandalonePluginPatch('- insert:\n    - name: cordis:group\n      disabled: !!js "import(\'file:///outside.js\')"\n', path.resolve('fixture'))).toThrow('无法可靠迁移')
  })

  it('lists deduplicated host imports from entries, nested groups and assertions without evaluating expressions', () => {
    const template = '- insert:\n    - id: group\n      name: cordis:group\n      group: true\n      config:\n        - id: host\n          name: "@deepseek-ai/host/subpath"\n          disabled: !!js "process.env.DISABLED"\n        - id: private\n          name: dsh-standalone:/private/packages/p00000/index.js\n- id: host\n  name: "@deepseek-ai/host/subpath"\n  disabled: true\n- id: group\n  config:\n    - id: other\n      name: "@cordisjs/logger"\n'
    expect(standalonePatchHostModules(template)).toEqual(['@deepseek-ai/host/subpath', '@cordisjs/logger'])
  })

  it.skipIf(!process.env.DSH_STANDALONE_PATCH_RUNTIME)('composes materialized patches with an installed DSH runtime without booting a Profile', async () => {
    const first = await layerFixture('first', '- insert:\n    - id: first\n      name: first\n      disabled: !!js "false"\n      config:\n        value: 1\n')
    const second = await layerFixture('second', '- id: first\n  name: first\n  config:\n    value: 2\n', 1)
    const template = await buildStandalonePluginPatch([first, second], { resolveModule })
    const patchPath = path.join(first.sourceDirectory, 'compiled.patch.yml')
    await writeFile(patchPath, materializeStandalonePluginPatch(template, first.sourceDirectory))
    const script = 'const boot = await import(process.argv[1]); process.stdout.write(JSON.stringify(boot.composeEntries([boot.loadOverlayPatches("standalone-test", process.argv[2])])));'
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module', '-e', script, pathToFileURL(process.env.DSH_STANDALONE_PATCH_RUNTIME!).href, patchPath,
    ], { timeout: 10_000, windowsHide: true })
    expect(JSON.parse(stdout)).toEqual([{
      id: 'first', name: pathToFileURL(path.join(first.sourceDirectory, 'private', 'packages', 'p0000', 'lib', 'index.js')).href,
      disabled: { __jsExpr: 'false' }, config: { value: 2 },
    }])
  })
})
