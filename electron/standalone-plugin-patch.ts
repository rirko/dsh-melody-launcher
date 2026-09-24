import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, stringify, type ScalarTag } from 'yaml'
import { isDshCorePackage } from './profile'

export interface StandalonePatchLayer {
  packageName: string
  sourceDirectory: string
  archiveDirectory: string
  /** Absolute or package-relative path; defaults to package.json dsh.bundle.patch. */
  patchPath?: string
}

export interface StandalonePatchOptions {
  /** Resolve using Node ESM import conditions without evaluating plugin code. */
  resolveModule: (specifier: string, layer: StandalonePatchLayer, fromFile: string) => Promise<{ archivePath: string } | { host: true }>
}

const MODULE_PREFIX = 'dsh-standalone:/'
const JS_TAG = 'tag:yaml.org,2002:js'
type Mapping = Record<string, unknown>
interface JsExpression { __jsExpr: string }
interface EntryBinding { originalName: string; relocatedName: string; group: boolean }

function isMapping(value: unknown): value is Mapping {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isExpression(value: unknown): value is JsExpression {
  return isMapping(value) && typeof value.__jsExpr === 'string'
}

const jsTag: ScalarTag = {
  tag: JS_TAG,
  identify: isExpression,
  resolve: value => ({ __jsExpr: value }),
  stringify: item => JSON.stringify((item.value as JsExpression).__jsExpr),
}

function fail(packageName: string, reason: string): never {
  throw new Error(`无法导出复合插件「${packageName}」：${reason}`)
}

function privatePath(value: string, packageName: string): string {
  if (!value.startsWith('private/packages/') || value.includes('\\') || value.includes(':') || value.includes('\0')
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(packageName, `私有模块路径无效或越界：${value}`)
  }
  return value
}

function parsePatches(content: string, packageName: string): Mapping[] {
  const document = parseDocument(content, { customTags: [jsTag], uniqueKeys: true })
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem) fail(packageName, `补丁 YAML 无法安全读取：${problem.message}`)
  let value: unknown
  try {
    // Expand aliases so relocation of one entry cannot mutate another layer.
    value = JSON.parse(JSON.stringify(document.toJS({ maxAliasCount: 50 })))
  } catch {
    fail(packageName, '补丁包含循环引用或过多 YAML 别名。')
  }
  if (!Array.isArray(value) || value.some(item => !isMapping(item))) fail(packageName, '补丁必须是由映射条目组成的 YAML 数组。')
  return value as Mapping[]
}

function assertPortableConfig(value: unknown, packageName: string): void {
  if (isExpression(value)) {
    // These expressions depend on source location or on names changed by relocation.
    if (/\b(?:import|require|__dirname|__filename)\b|\bctx\s*\.\s*baseUrl\b|\.\s*options\s*\.\s*name\b|["'`]\.{1,2}[\\/]/.test(value.__jsExpr)) {
      fail(packageName, '!!js 表达式依赖模块、相对路径或原始模块名称，无法可靠迁移。')
    }
    return
  }
  if (typeof value === 'string' && (value.startsWith(MODULE_PREFIX) || /^(?:\.{1,2}[\\/]|file:|[A-Za-z]:[\\/]|\\\\|\/)/.test(value))) {
    fail(packageName, `配置含路径「${value}」，无法确定它属于插件目录还是用户工作目录。`)
  }
  if (Array.isArray(value)) value.forEach(item => assertPortableConfig(item, packageName))
  else if (isMapping(value)) Object.values(value).forEach(item => assertPortableConfig(item, packageName))
}

function checkEntryName(name: unknown, packageName: string): asserts name is string {
  if (typeof name !== 'string' || !name.trim()) fail(packageName, '加载条目的 name 必须是静态模块名称，不支持动态名称。')
  if (name === 'cordis:include' || name === '@deepseek-ai/cordis-plugin-include') {
    fail(packageName, '包含嵌套 include 配置，首版无法保证其路径及补丁作用域一致。')
  }
  if (/^(?:https?|data):/i.test(name)) fail(packageName, `模块必须来自私有本体或宿主运行时：${name}`)
}

async function patchFile(layer: StandalonePatchLayer): Promise<string> {
  let declared = layer.patchPath
  if (declared === undefined) {
    const manifest = JSON.parse(await readFile(path.join(layer.sourceDirectory, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
    if (typeof manifest.dsh?.bundle?.patch !== 'string') fail(layer.packageName, 'package.json 未声明有效的 dsh.bundle.patch。')
    declared = manifest.dsh.bundle.patch
  }
  // 越界检查用 realpath 的规范形式；传给 resolver 的保持声明时的原始路径，
  // 因为 sourceDirectory 可能是 8.3 短名而 realpath 会换写法，调用方需要一致的形式。
  const root = await realpath(layer.sourceDirectory)
  const file = path.resolve(layer.sourceDirectory, declared)
  const canonical = await realpath(file)
  const relative = path.relative(root, canonical)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail(layer.packageName, '补丁文件位于插件本体之外。')
  return file
}

/** Keep all source layers in one ordered patch list, matching DSH's single-pass composition. */
export async function buildStandalonePluginPatch(layers: StandalonePatchLayer[], options: StandalonePatchOptions): Promise<string> {
  const merged: Mapping[] = []
  const bindings = new Map<string, EntryBinding>()
  for (const layer of layers) {
    privatePath(layer.archiveDirectory, layer.packageName)
    let file: string
    let patches: Mapping[]
    try {
      file = await patchFile(layer)
      patches = parsePatches(await readFile(file, 'utf8'), layer.packageName)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('无法导出复合插件')) throw error
      fail(layer.packageName, `无法读取插件补丁：${error instanceof Error ? error.message : String(error)}`)
    }
    const relocate = async (name: string): Promise<string> => {
      if (name.startsWith('cordis:')) return name
      let resolved: Awaited<ReturnType<StandalonePatchOptions['resolveModule']>>
      try { resolved = await options.resolveModule(name, layer, file) } catch (error) {
        fail(layer.packageName, `无法固定模块「${name}」：${error instanceof Error ? error.message : String(error)}`)
      }
      if ('host' in resolved) {
        if (/^(?:\.|file:|[A-Za-z]:|[\\/])/.test(name)) fail(layer.packageName, `本地模块不能回退到宿主：${name}`)
        return name
      }
      return MODULE_PREFIX + privatePath(resolved.archivePath, layer.packageName)
    }
    const visitEntries = async (entries: unknown, indexed: boolean): Promise<void> => {
      if (!Array.isArray(entries)) fail(layer.packageName, 'group 或 insert 中的加载条目必须是静态数组。')
      for (const entry of entries) {
        if (!isMapping(entry)) fail(layer.packageName, '加载条目必须是映射。')
        checkEntryName(entry.name, layer.packageName)
        const originalName = entry.name
        entry.name = await relocate(originalName)
        if (entry.group !== undefined && typeof entry.group !== 'boolean') fail(layer.packageName, '不支持动态 group 设置。')
        if (indexed && typeof entry.id === 'string') bindings.set(entry.id, { originalName, relocatedName: entry.name as string, group: entry.group === true })
        if (entry.group === true && entry.config !== undefined) await visitEntries(entry.config, indexed)
        for (const [key, value] of Object.entries(entry)) {
          if (key === 'name' || (key === 'config' && entry.group === true)) continue
          assertPortableConfig(value, layer.packageName)
        }
      }
    }
    for (const patch of patches) {
      if (patch.insert !== undefined) {
        await visitEntries(patch.insert, true)
      } else {
        const binding = typeof patch.id === 'string' ? bindings.get(patch.id) : undefined
        if (Array.isArray(patch.config) && !binding && patch.group !== true) fail(layer.packageName, '数组 config 的目标条目类型未知，请显式声明 group: true 后再导出。')
        if (patch.name !== undefined) {
          checkEntryName(patch.name, layer.packageName)
          if (/^(?:\.|[A-Za-z]:[\\/]|[\\/])/.test(patch.name)) {
            fail(layer.packageName, 'name 断言使用本地路径，不同 DSH 版本的锚定规则不同，无法可靠迁移。')
          }
          if (binding && patch.name === binding.originalName) patch.name = binding.relocatedName
          else if (binding && !patch.name.startsWith('cordis:') && !isDshCorePackage(patch.name)) fail(layer.packageName, 'name 断言与原始加载条目不一致，无法保留其失配语义。')
          else if (!binding) patch.name = await relocate(patch.name)
        }
        if (patch.config !== undefined && (patch.group === true || binding?.group)) {
          // DSH's patch algorithm does not index children introduced by config replacement.
          await visitEntries(patch.config, false)
        } else assertPortableConfig(patch.config, layer.packageName)
        for (const [key, value] of Object.entries(patch)) {
          if (key !== 'name' && key !== 'config') assertPortableConfig(value, layer.packageName)
        }
      }
      merged.push(patch)
    }
  }
  return stringify(merged, { customTags: [jsTag], lineWidth: 0, aliasDuplicateObjects: false })
}

/** Resolve only controlled template tokens after the private artifact has its final location. */
export function materializeStandalonePluginPatch(template: string, artifactRoot: string, knownFiles?: ReadonlySet<string>): string {
  if (!path.isAbsolute(artifactRoot)) throw new Error('复合插件安装目录必须使用绝对路径。')
  const patches = parsePatches(template, '复合插件模板')
  const groups = new Set<string>()
  const targets = new Set<string>()
  const materializeName = (value: unknown): string => {
    checkEntryName(value, '复合插件模板')
    if (value.startsWith(MODULE_PREFIX)) {
      const relative = privatePath(value.slice(MODULE_PREFIX.length), '复合插件模板')
      if (knownFiles && !knownFiles.has(relative)) fail('复合插件模板', `私有模块文件未包含在制品中：${relative}`)
      return pathToFileURL(path.join(artifactRoot, ...relative.split('/'))).href
    }
    if (value.startsWith('cordis:') || isDshCorePackage(value)) return value
    return fail('复合插件模板', `模块未固定到私有本体或宿主运行时：${value}`)
  }
  const visitEntries = (entries: unknown, indexed: boolean): void => {
    if (!Array.isArray(entries)) fail('复合插件模板', 'group 或 insert 中的加载条目必须是静态数组。')
    for (const entry of entries) {
      if (!isMapping(entry)) fail('复合插件模板', '加载条目必须是映射。')
      entry.name = materializeName(entry.name)
      if (entry.group !== undefined && typeof entry.group !== 'boolean') fail('复合插件模板', '不支持动态 group 设置。')
      if (indexed && typeof entry.id === 'string') {
        targets.add(entry.id)
        if (entry.group === true) groups.add(entry.id)
        else groups.delete(entry.id)
      }
      if (entry.group === true && entry.config !== undefined) visitEntries(entry.config, indexed)
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'name' || (key === 'config' && entry.group === true)) continue
        assertPortableConfig(value, '复合插件模板')
      }
    }
  }
  for (const patch of patches) {
    if (patch.insert !== undefined) visitEntries(patch.insert, true)
    else {
      if (Array.isArray(patch.config) && !targets.has(String(patch.id)) && patch.group !== true) fail('复合插件模板', '数组 config 的目标条目类型未知，请显式声明 group: true 后再导出。')
      if (patch.name !== undefined) patch.name = materializeName(patch.name)
      if (patch.config !== undefined && (patch.group === true || (typeof patch.id === 'string' && groups.has(patch.id)))) visitEntries(patch.config, false)
      else assertPortableConfig(patch.config, '复合插件模板')
      for (const [key, value] of Object.entries(patch)) {
        if (key !== 'name' && key !== 'config') assertPortableConfig(value, '复合插件模板')
      }
    }
  }
  return stringify(patches, { customTags: [jsTag], lineWidth: 0, aliasDuplicateObjects: false })
}

/** Enumerate runtime-owned package imports without evaluating expressions or loading modules. */
export function standalonePatchHostModules(template: string): string[] {
  const modules = new Set<string>()
  const groups = new Set<string>()
  const targets = new Set<string>()
  const collectName = (name: unknown): void => {
    checkEntryName(name, '复合插件模板')
    if (name.startsWith(MODULE_PREFIX)) privatePath(name.slice(MODULE_PREFIX.length), '复合插件模板')
    else if (name.startsWith('cordis:')) return
    else if (isDshCorePackage(name)) modules.add(name)
    else fail('复合插件模板', `模块未固定到私有本体或宿主运行时：${name}`)
  }
  const visitEntries = (entries: unknown, indexed: boolean): void => {
    if (!Array.isArray(entries)) fail('复合插件模板', 'group 或 insert 中的加载条目必须是静态数组。')
    for (const entry of entries) {
      if (!isMapping(entry)) fail('复合插件模板', '加载条目必须是映射。')
      collectName(entry.name)
      if (indexed && typeof entry.id === 'string') {
        targets.add(entry.id)
        if (entry.group === true) groups.add(entry.id)
        else groups.delete(entry.id)
      }
      if (entry.group === true && entry.config !== undefined) visitEntries(entry.config, indexed)
    }
  }
  for (const patch of parsePatches(template, '复合插件模板')) {
    if (patch.insert !== undefined) visitEntries(patch.insert, true)
    else {
      if (Array.isArray(patch.config) && !targets.has(String(patch.id)) && patch.group !== true) fail('复合插件模板', '数组 config 的目标条目类型未知，请显式声明 group: true 后再导出。')
      if (patch.name !== undefined) collectName(patch.name)
      if (patch.config !== undefined && (patch.group === true || (typeof patch.id === 'string' && groups.has(patch.id)))) visitEntries(patch.config, false)
    }
  }
  return [...modules]
}
