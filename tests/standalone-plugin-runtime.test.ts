import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 真实文件系统/子进程操作在并行与慢盘环境下会超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 })
import { assertStandalonePluginRuntime } from '../electron/standalone-plugin-runtime'
import { createRuntimeController } from '../electron/runtime'
import { defaultSettings } from '../electron/settings'
import type { StandaloneNativeRuntime } from '../electron/standalone-plugin-native'

const mocks = vi.hoisted(() => ({ inspectNode: vi.fn() }))
vi.mock('../electron/standalone-plugin-native', async importOriginal => ({
  ...await importOriginal<typeof import('../electron/standalone-plugin-native')>(),
  inspectStandaloneNodeRuntime: mocks.inspectNode,
}))

const nativeRuntime: StandaloneNativeRuntime = { node: '24.19.0', modules: '137', napi: '10', platform: 'win32', arch: 'x64' }
const nativeMarker = { schemaVersion: 1, dshVersion: '0.1.6-alpha.2', nativeRuntime }
beforeEach(() => { vi.clearAllMocks(); mocks.inspectNode.mockResolvedValue(nativeRuntime) })

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(enabled = true, standalone: unknown = { schemaVersion: 1, dshVersion: '0.1.6-alpha.2' }) {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-standalone-runtime-'))
  roots.push(dshHome)
  const directory = path.join(dshHome, 'profiles', 'web')
  const pluginDirectory = path.join(directory, 'node_modules', 'dsh-suite-demo')
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-suite-demo': '1.0.0' }, dsh: { profile: { bundles: enabled ? ['dsh-suite-demo'] : [] } },
  }))
  await writeFile(path.join(pluginDirectory, 'package.json'), JSON.stringify({
    name: 'dsh-suite-demo', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' }, standalone },
  }))
  return { dshHome, directory }
}

describe('standalone runtime guard', () => {
  it('accepts the exact managed host version', async () => {
    const env = await fixture()
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', '0.1.6-alpha.2')).resolves.toBeUndefined()
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', 'v0.1.6-alpha.2')).resolves.toBeUndefined()
  })

  it.each([null, '0.1.5-rc.2'])('rejects an unproven or different host version: %s', async version => {
    const env = await fixture()
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', version)).rejects.toThrow('要求 DSH 0.1.6-alpha.2')
  })

  it('rejects replacement hosts even when the selected launcher runtime matches', async () => {
    const env = await fixture()
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', '0.1.6-alpha.2', true)).rejects.toThrow('无法验证替代宿主')
  })

  it('does not restrict disabled standalone plugins or normal plugins', async () => {
    const disabled = await fixture(false)
    await expect(assertStandalonePluginRuntime(disabled.dshHome, 'web', null, true)).resolves.toBeUndefined()
    const ordinary = await fixture(true, undefined)
    await writeFile(path.join(ordinary.directory, 'node_modules', 'dsh-suite-demo', 'package.json'), JSON.stringify({ name: 'dsh-suite-demo', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    await expect(assertStandalonePluginRuntime(ordinary.dshHome, 'web', null, true)).resolves.toBeUndefined()
    await expect(assertStandalonePluginRuntime(ordinary.dshHome, 'absent', null)).resolves.toBeUndefined()
  })

  it('rejects malformed standalone runtime metadata', async () => {
    const env = await fixture(true, { schemaVersion: 1 })
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', '0.1.6-alpha.2')).rejects.toThrow('宿主版本信息无效')
  })

  it('checks the artifact marker even if its Profile link is not materialized yet', async () => {
    const env = await fixture()
    const digest = 'a'.repeat(64)
    const artifact = path.join(env.dshHome, '.dsh-launcher-standalone-plugins', 'dsh-suite-demo', digest)
    await mkdir(artifact, { recursive: true })
    await writeFile(path.join(artifact, 'package.json'), JSON.stringify({ name: 'dsh-suite-demo', dsh: { standalone: { schemaVersion: 1, dshVersion: '0.1.6-alpha.2' } } }))
    await rm(path.join(env.directory, 'node_modules', 'dsh-suite-demo'), { recursive: true })
    await writeFile(path.join(env.directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-suite-demo': `link:${artifact}` }, dsh: { profile: { bundles: ['dsh-suite-demo'] } } }))
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', null)).rejects.toThrow('要求 DSH 0.1.6-alpha.2')
  })

  it('prevents runtime preparation and process creation before a mismatched standalone launch', async () => {
    const env = await fixture()
    const settings = { ...defaultSettings({ homeDirectory: env.dshHome, documentsDirectory: env.dshHome }), dshHome: env.dshHome, dshVersion: '0.1.5-rc.2' }
    const prepareNodeRuntime = vi.fn(async () => { throw new Error('must not prepare') })
    const spawnProcess = vi.fn(() => { throw new Error('must not start') })
    const runtime = createRuntimeController({
      readSettings: async () => settings, prepareNodeRuntime, spawnProcess,
      fallbackWorkspace: () => env.dshHome, emitOutput: () => {}, emitState: () => {}, openExternal: async () => {},
    })
    await expect(runtime.start()).rejects.toThrow('要求 DSH 0.1.6-alpha.2')
    expect(prepareNodeRuntime).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('checks all enabled native plugins with a single lazy runtime resolution', async () => {
    const env = await fixture(true, nativeMarker)
    const second = path.join(env.directory, 'node_modules', 'dsh-suite-second')
    await mkdir(second, { recursive: true })
    await writeFile(path.join(second, 'package.json'), JSON.stringify({ name: 'dsh-suite-second', dsh: { standalone: nativeMarker } }))
    await writeFile(path.join(env.directory, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['dsh-suite-demo', 'dsh-suite-second'] } },
    }))
    const resolveNative = vi.fn(async () => nativeRuntime)
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', '0.1.6-alpha.2', false, resolveNative)).resolves.toBeUndefined()
    expect(resolveNative).toHaveBeenCalledOnce()
  })

  it('does not probe Node for JavaScript-only or disabled native plugins', async () => {
    const resolveNative = vi.fn(async () => nativeRuntime)
    const js = await fixture()
    const disabled = await fixture(false, nativeMarker)
    await assertStandalonePluginRuntime(js.dshHome, 'web', '0.1.6-alpha.2', false, resolveNative)
    await assertStandalonePluginRuntime(disabled.dshHome, 'web', null, false, resolveNative)
    expect(resolveNative).not.toHaveBeenCalled()
  })

  it('rejects native metadata without a resolver and invalid native metadata before probing', async () => {
    const env = await fixture(true, nativeMarker)
    await expect(assertStandalonePluginRuntime(env.dshHome, 'web', '0.1.6-alpha.2')).rejects.toThrow('原生依赖兼容性')
    const malformed = await fixture(true, { ...nativeMarker, nativeRuntime: { modules: '137' } })
    const resolveNative = vi.fn(async () => nativeRuntime)
    await expect(assertStandalonePluginRuntime(malformed.dshHome, 'web', '0.1.6-alpha.2', false, resolveNative)).rejects.toThrow('运行时信息无效')
    expect(resolveNative).not.toHaveBeenCalled()
  })

  it('prevents process creation when the selected Node ABI changed after import', async () => {
    const env = await fixture(true, nativeMarker)
    const settings = { ...defaultSettings({ homeDirectory: env.dshHome, documentsDirectory: env.dshHome }), dshHome: env.dshHome, dshVersion: '0.1.6-alpha.2', launchExecutable: 'node', launchArgs: ['entry.js'] }
    const selectedNode = { root: env.dshHome, node: path.join(env.dshHome, 'node.exe'), npm: 'npm', npx: 'npx', managed: true }
    const prepareNodeRuntime = vi.fn(async () => selectedNode)
    const spawnProcess = vi.fn(() => { throw new Error('must not start') })
    mocks.inspectNode.mockResolvedValue({ ...nativeRuntime, modules: '127', node: '22.15.0' })
    const runtime = createRuntimeController({
      readSettings: async () => settings, prepareNodeRuntime, spawnProcess,
      fallbackWorkspace: () => env.dshHome, emitOutput: () => {}, emitState: () => {}, openExternal: async () => {},
    })
    await expect(runtime.start()).rejects.toThrow('Node ABI')
    expect(prepareNodeRuntime).toHaveBeenCalledOnce()
    expect(mocks.inspectNode).toHaveBeenCalledExactlyOnceWith(selectedNode.node)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(runtime.isRunning()).toBe(false)
  })

  it.each([true, false])('shares Node preparation with a compatible launch (native=%s)', async native => {
    const env = await fixture(true, native ? nativeMarker : undefined)
    const settings = { ...defaultSettings({ homeDirectory: env.dshHome, documentsDirectory: env.dshHome }), dshHome: env.dshHome, dshVersion: '0.1.6-alpha.2', launchExecutable: 'node', launchArgs: ['entry.js'] }
    const selectedNode = { root: env.dshHome, node: path.join(env.dshHome, 'node.exe'), npm: 'npm', npx: 'npx', managed: true }
    const prepareNodeRuntime = vi.fn(async () => selectedNode)
    const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams
    const spawnProcess = vi.fn(() => child)
    const runtime = createRuntimeController({
      readSettings: async () => settings, prepareNodeRuntime, spawnProcess, stopProcess: async () => {},
      fallbackWorkspace: () => env.dshHome, emitOutput: () => {}, emitState: () => {}, openExternal: async () => {},
    })
    try {
      await expect(runtime.start()).resolves.toMatchObject({ running: true })
      expect(prepareNodeRuntime).toHaveBeenCalledOnce()
      expect(mocks.inspectNode).toHaveBeenCalledTimes(native ? 1 : 0)
      expect(spawnProcess).toHaveBeenCalledWith(selectedNode.node, ['entry.js'], expect.any(Object))
    } finally { await runtime.stop() }
  })
})
