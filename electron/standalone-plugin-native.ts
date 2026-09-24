import { execFile } from 'node:child_process'

export interface StandaloneNativeRuntime {
  node: string
  modules: string
  napi: string | null
  platform: string
  arch: string
}

const NODE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PLATFORMS = new Set(['aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32'])
const ARCHITECTURES = new Set(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'mips64el', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'])
const PROBE = 'JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi??null,platform:process.platform,arch:process.arch,electron:process.versions.electron??null})'
const PROBE_TIMEOUT_MS = 5_000

function positiveInteger(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
}

export function validateStandaloneNativeRuntime(value: unknown): asserts value is StandaloneNativeRuntime {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('原生依赖的 Node 运行时信息无效：必须提供完整的运行时对象。')
  }
  const runtime = value as Record<string, unknown>
  const version = typeof runtime.node === 'string' ? NODE_VERSION.exec(runtime.node) : null
  if (!version || !version.slice(1, 4).every(part => Number.isSafeInteger(Number(part))) || Number(version[1]) < 1) {
    throw new Error('原生依赖的 Node 运行时信息无效：node 必须是完整的 Node 版本号。')
  }
  if (!positiveInteger(runtime.modules)) {
    throw new Error('原生依赖的 Node 运行时信息无效：modules 必须是有效的 Node ABI 编号。')
  }
  if (runtime.napi !== null && !positiveInteger(runtime.napi)) {
    throw new Error('原生依赖的 Node 运行时信息无效：napi 必须是有效的 N-API 编号或 null。')
  }
  if (typeof runtime.platform !== 'string' || !PLATFORMS.has(runtime.platform)) {
    throw new Error('原生依赖的 Node 运行时信息无效：platform 不是受支持的操作系统。')
  }
  if (typeof runtime.arch !== 'string' || !ARCHITECTURES.has(runtime.arch)) {
    throw new Error('原生依赖的 Node 运行时信息无效：arch 不是受支持的处理器架构。')
  }
}

/** Probe the selected executable without loading user preloads or plugin code. */
export async function inspectStandaloneNodeRuntime(executable: string): Promise<StandaloneNativeRuntime> {
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) {
    throw new Error('无法检测原生依赖的 Node 运行时：未提供有效的 Node 可执行文件。')
  }
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete env[key]
  }
  // An accidentally selected Electron binary must report itself without opening its GUI.
  env.ELECTRON_RUN_AS_NODE = '1'
  const output = await new Promise<string>((resolve, reject) => {
    execFile(executable, ['-p', PROBE], {
      env, encoding: 'utf8', windowsHide: true, shell: false, timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.killed || String(error.code) === 'ETIMEDOUT'
          ? '检测原生依赖的 Node 运行时超时，请检查选中的 Node 可执行文件。'
          : `无法检测原生依赖的 Node 运行时：${error.message}`))
      } else resolve(stdout)
    })
  })
  let result: unknown
  try { result = JSON.parse(output.trim()) } catch {
    throw new Error('无法检测原生依赖的 Node 运行时：可执行文件没有返回有效的运行时 JSON。')
  }
  if (result && typeof result === 'object' && 'electron' in result && result.electron !== null && result.electron !== undefined) {
    throw new Error('原生依赖必须使用独立 Node 运行时，不能使用 Electron 的 Node ABI。请重新选择 Node。')
  }
  validateStandaloneNativeRuntime(result)
  return { node: result.node, modules: result.modules, napi: result.napi, platform: result.platform, arch: result.arch }
}

export function assertStandaloneNativeCompatibility(required: StandaloneNativeRuntime, actual: StandaloneNativeRuntime): void {
  validateStandaloneNativeRuntime(required)
  validateStandaloneNativeRuntime(actual)
  const mismatches: string[] = []
  if (required.platform !== actual.platform) mismatches.push(`操作系统要求 ${required.platform}，当前 ${actual.platform}`)
  if (required.arch !== actual.arch) mismatches.push(`处理器架构要求 ${required.arch}，当前 ${actual.arch}`)
  if (required.node.split('.')[0] !== actual.node.split('.')[0]) mismatches.push(`Node 主版本要求 ${required.node}，当前 ${actual.node}`)
  if (required.modules !== actual.modules) mismatches.push(`Node ABI 要求 ${required.modules}，当前 ${actual.modules}`)
  if (required.napi !== null && (actual.napi === null || Number(actual.napi) < Number(required.napi))) {
    mismatches.push(`N-API 至少要求 ${required.napi}，当前 ${actual.napi ?? '不支持'}`)
  }
  if (mismatches.length) {
    throw new Error(`独立复合插件的原生依赖与选中的 Node 运行时不兼容：${mismatches.join('；')}。请使用匹配的 Node 运行时或重新导出插件。`)
  }
}
