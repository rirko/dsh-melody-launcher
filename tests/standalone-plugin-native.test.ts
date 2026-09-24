import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
// 真实文件系统/子进程操作在并行与慢盘环境下会超过默认 5 秒。
vi.setConfig({ testTimeout: 30_000 })
import { assertStandaloneNativeCompatibility, inspectStandaloneNodeRuntime, validateStandaloneNativeRuntime, type StandaloneNativeRuntime } from '../electron/standalone-plugin-native'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const runtime: StandaloneNativeRuntime = { node: '24.19.0', modules: '137', napi: '10', platform: 'win32', arch: 'x64' }
const mockedExecFile = vi.mocked(execFile)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); mockedExecFile.mockReset() })

function probeResponse(output: string, error: Error | null = null) {
  mockedExecFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    callback(error, output, '')
    return {} as ReturnType<typeof execFile>
  })
}

describe('standalone native runtime metadata', () => {
  it('accepts complete runtime metadata, including an absent N-API capability', () => {
    expect(() => validateStandaloneNativeRuntime(runtime)).not.toThrow()
    expect(() => validateStandaloneNativeRuntime({ ...runtime, napi: null })).not.toThrow()
    expect(() => validateStandaloneNativeRuntime({ ...runtime, node: '26.0.0-nightly20250920.1' })).not.toThrow()
  })

  it.each(['node', 'modules', 'napi', 'platform', 'arch'])('requires the %s field', field => {
    const incomplete: Record<string, unknown> = { ...runtime }
    delete incomplete[field]
    expect(() => validateStandaloneNativeRuntime(incomplete)).toThrow(field)
  })

  it.each([null, undefined, [], '24.19.0'])('rejects a nonobject runtime: %s', value => {
    expect(() => validateStandaloneNativeRuntime(value)).toThrow('完整的运行时对象')
  })

  it.each([
    ['node', '24'], ['node', 'v24.19.0'], ['node', '024.19.0'], ['node', '24.19.0 '], ['node', '9007199254740992.0.0'],
    ['modules', 137], ['modules', '0'], ['modules', '-1'], ['modules', '137.5'], ['modules', '0137'], ['modules', '9007199254740992'],
    ['napi', 10], ['napi', '0'], ['napi', '10 '], ['platform', 'windows'], ['arch', 'amd64'],
  ])('rejects malformed %s = %s', (field, value) => {
    expect(() => validateStandaloneNativeRuntime({ ...runtime, [field]: value })).toThrow(field)
  })
})

describe('selected Node runtime inspection', () => {
  it('probes only the selected executable, with bounded hidden execution and no user preloads', async () => {
    vi.stubEnv('NODE_OPTIONS', '--require malicious.js')
    vi.stubEnv('NODE_PATH', 'untrusted-modules')
    probeResponse(JSON.stringify({ ...runtime, electron: null }))
    await expect(inspectStandaloneNodeRuntime('C:\\Runtime With Spaces\\node.exe')).resolves.toEqual(runtime)
    const [executable, args, options] = mockedExecFile.mock.calls[0]
    expect(executable).toBe('C:\\Runtime With Spaces\\node.exe')
    expect(args).toEqual(['-p', expect.stringContaining('JSON.stringify({node:process.versions.node')])
    expect(args?.[1]).not.toMatch(/require\(|import\(/)
    expect(options).toMatchObject({ windowsHide: true, shell: false, timeout: 5_000, maxBuffer: 16 * 1024, encoding: 'utf8' })
    expect(options?.env?.NODE_OPTIONS).toBeUndefined()
    expect(options?.env?.NODE_PATH).toBeUndefined()
    expect(options?.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('reads the actual Node binary instead of assuming the launcher ABI', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    mockedExecFile.mockImplementationOnce(actual.execFile)
    await expect(inspectStandaloneNodeRuntime(process.execPath)).resolves.toEqual({
      node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi ?? null, platform: process.platform, arch: process.arch,
    })
  })

  it('rejects an Electron runtime even when it reports an otherwise compatible Node ABI', async () => {
    probeResponse(JSON.stringify({ ...runtime, electron: '43.4.0' }))
    await expect(inspectStandaloneNodeRuntime('electron.exe')).rejects.toThrow('不能使用 Electron')
  })

  it.each(['', '  ', 'node\0.exe'])('rejects an invalid executable without spawning: %s', async executable => {
    await expect(inspectStandaloneNodeRuntime(executable)).rejects.toThrow('有效的 Node 可执行文件')
    expect(mockedExecFile).not.toHaveBeenCalled()
  })

  it('reports timeout and process failure clearly', async () => {
    probeResponse('', Object.assign(new Error('killed'), { killed: true }))
    await expect(inspectStandaloneNodeRuntime('node')).rejects.toThrow('超时')
    probeResponse('', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    await expect(inspectStandaloneNodeRuntime('missing-node')).rejects.toThrow('spawn ENOENT')
  })

  it('rejects malformed output and incomplete runtime fields', async () => {
    probeResponse('hello\n{}')
    await expect(inspectStandaloneNodeRuntime('node')).rejects.toThrow('JSON')
    probeResponse(JSON.stringify({ node: '24.19.0' }))
    await expect(inspectStandaloneNodeRuntime('node')).rejects.toThrow('modules')
  })
})

describe('standalone native compatibility', () => {
  it('permits patch/minor version changes with an identical ABI and sufficient N-API', () => {
    expect(() => assertStandaloneNativeCompatibility(runtime, { ...runtime, node: '24.20.1', napi: '11' })).not.toThrow()
    expect(() => assertStandaloneNativeCompatibility({ ...runtime, napi: null }, { ...runtime, napi: null })).not.toThrow()
  })

  it.each([
    [{ platform: 'linux' }, '操作系统'], [{ arch: 'arm64' }, '处理器架构'],
    [{ node: '25.0.0' }, 'Node 主版本'], [{ modules: '138' }, 'Node ABI'],
    [{ napi: '9' }, 'N-API'], [{ napi: null }, 'N-API'],
  ])('rejects incompatible runtime fields: %j', (changes, reason) => {
    expect(() => assertStandaloneNativeCompatibility(runtime, { ...runtime, ...changes })).toThrow(reason)
  })

  it('validates both required and actual metadata before comparing', () => {
    expect(() => assertStandaloneNativeCompatibility({ ...runtime, modules: '' }, runtime)).toThrow('modules')
    expect(() => assertStandaloneNativeCompatibility(runtime, { ...runtime, arch: 'other' })).toThrow('arch')
  })
})
