import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as resolveImport } from 'import-meta-resolve'
import * as yazl from 'yazl'
import { isDshCorePackage, isSafePackageName, isSafeProfileName, readProfile } from './profile'
import { openZipPathFromFile } from './pack-zip'
import { recordPluginInstall, removePluginReceipt } from './plugin-receipts'
import { buildStandalonePluginPatch, materializeStandalonePluginPatch, standalonePatchHostModules } from './standalone-plugin-patch'
import { ensureStandalonePluginLink, standalonePluginPackageRoot } from './standalone-plugin-links'
import { assertStandaloneNativeCompatibility, validateStandaloneNativeRuntime, type StandaloneNativeRuntime } from './standalone-plugin-native'

const FORMAT = 'dsh-standalone-plugin'
const LIMITS = { maxArchiveBytes: 1024 ** 3, maxFiles: 100_000, maxUnpackedBytes: 2 * 1024 ** 3 }
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ID = /^p\d{5}$/
type PackageJson = { name: string; version: string; description?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; bundledDependencies?: string[]; dsh?: { bundle?: { patch?: string }; standalone?: { schemaVersion?: number; dshVersion?: string; members?: string[]; nativeRuntime?: StandaloneNativeRuntime } }; [key: string]: unknown }
type Edge = { package: string } | { host: string; version: string | null }
interface PrivatePackage { id: string; name: string; version: string; dependencies: Record<string, Edge> }
interface StandaloneManifest {
  format: typeof FORMAT
  schemaVersion: 1
  name: string
  version: string
  dshVersion: string
  platform: string
  arch: string
  nativeRuntime?: StandaloneNativeRuntime
  sourceProfile: string
  members: string[]
  packages: PrivatePackage[]
  files: Record<string, { sha256: string; mode: number }>
}
interface SourcePackage extends PrivatePackage { directory: string; manifest: PackageJson }
export interface StandaloneExportOptions {
  profileDirectory: string
  dshVersion: string
  version: string
  outputPath: string
  packageName?: string
  nativeRuntime?: () => Promise<StandaloneNativeRuntime>
  onProgress?: (message: string) => void
}

function safeRelative(value: string): boolean {
  return Boolean(value) && !value.includes('\\') && !value.includes(':') && !value.includes('\0')
    && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && !/[<>"|?*]|[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T }
async function exists(file: string): Promise<boolean> { return stat(file).then(() => true, () => false) }
function samePath(left: string, right: string): boolean { return path.relative(left, right) === '' }
async function managedPackageRoot(dshHome: string, packageName: string): Promise<string> {
  let directory = await realpath(dshHome)
  const segments = path.relative(dshHome, standalonePluginPackageRoot(dshHome, packageName)).split(path.sep)
  for (const segment of segments) {
    const next = path.join(directory, segment)
    await mkdir(next).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    if (!(await lstat(next)).isDirectory() || !samePath(await realpath(next), next)) throw new Error('独立插件安装目录不能包含重定向链接。')
    directory = next
  }
  return directory
}
function modulePackage(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
}
async function dependencyDirectory(from: string, name: string): Promise<string | null> {
  if (!isSafePackageName(name)) throw new Error(`依赖包名无效：${name}`)
  let directory = from
  while (true) {
    const candidate = path.join(directory, 'node_modules', ...name.split('/'))
    if (await exists(path.join(candidate, 'package.json'))) return realpath(candidate)
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/** Copies a resolved dependency graph, never pnpm's links or content-store files. */
export async function exportStandalonePlugin(options: StandaloneExportOptions): Promise<void> {
  if (!VERSION.test(options.dshVersion) || !VERSION.test(options.version)) throw new Error('导出独立插件需要有效的插件版本和 DSH 版本。')
  const profile = await json<PackageJson & { dsh?: { profile?: { bundles?: string[] } } }>(path.join(options.profileDirectory, 'package.json'))
  const members = (profile.dsh?.profile?.bundles ?? []).filter(name => !isDshCorePackage(name))
  if (!members.length) throw new Error('当前 Profile 没有启用的第三方插件。')
  const name = options.packageName ?? `dsh-suite-${path.basename(options.profileDirectory).toLowerCase()}`
  if (!isSafePackageName(name) || isDshCorePackage(name) || members.includes(name)) throw new Error('独立插件包名无效或与内部插件冲突。')
  const graph = new Map<string, SourcePackage>()
  async function addPackage(directory: string): Promise<SourcePackage> {
    directory = await realpath(directory)
    const existing = graph.get(directory)
    if (existing) return existing
    const manifest = await json<PackageJson>(path.join(directory, 'package.json'))
    if (!isSafePackageName(manifest.name) || !VERSION.test(manifest.version)) throw new Error(`插件依赖缺少有效包名或版本：${directory}`)
    if (manifest.dsh?.standalone) throw new Error(`暂不支持把独立复合插件再次嵌套导出：${manifest.name}`)
    const result: SourcePackage = { id: `p${String(graph.size).padStart(5, '0')}`, name: manifest.name, version: manifest.version, dependencies: {}, directory, manifest }
    graph.set(directory, result)
    if (graph.size > 5000) throw new Error('独立插件的依赖数量超过安全限制。')
    const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const bundled of manifest.bundledDependencies ?? []) dependencies[bundled] ??= '*'
    for (const dependency of Object.keys(dependencies)) {
      const found = await dependencyDirectory(directory, dependency)
      if (isDshCorePackage(dependency)) {
        result.dependencies[dependency] = { host: dependency, version: found ? (await json<PackageJson>(path.join(found, 'package.json'))).version : null }
      } else if (found) {
        result.dependencies[dependency] = { package: (await addPackage(found)).id }
      } else if (!(dependency in (manifest.optionalDependencies ?? {})) && !manifest.peerDependenciesMeta?.[dependency]?.optional) {
        throw new Error(`${manifest.name} 缺少依赖 ${dependency}，请先补齐后再导出。`)
      }
    }
    return result
  }
  const layers = []
  for (const packageName of members) {
    if (!isSafePackageName(packageName)) throw new Error(`插件包名无效：${packageName}`)
    options.onProgress?.(`正在收集 ${packageName} 及私有依赖`)
    const source = await addPackage(path.join(options.profileDirectory, 'node_modules', ...packageName.split('/')))
    if (source.name !== packageName) throw new Error(`插件实际包名与 Profile 不一致：${packageName}`)
    layers.push({ packageName, sourceDirectory: source.directory, archiveDirectory: `private/packages/${source.id}`, patchPath: source.manifest.dsh?.bundle?.patch })
  }
  const template = await buildStandalonePluginPatch(layers, {
    resolveModule: async (specifier, layer, fromFile) => {
      if (isDshCorePackage(modulePackage(specifier))) return { host: true }
      const url = resolveImport(specifier, pathToFileURL(fromFile).href)
      if (!url.startsWith('file:')) throw new Error(`不支持外部模块：${specifier}`)
      const resolved = await realpath(fileURLToPath(url))
      const owner = [...graph.values()].sort((a, b) => b.directory.length - a.directory.length).find(item => inside(item.directory, resolved))
      if (!owner) throw new Error(`${layer.packageName} 引用了未声明依赖或包外模块：${specifier}`)
      return { archivePath: `private/packages/${owner.id}/${path.relative(owner.directory, resolved).split(path.sep).join('/')}` }
    },
  })
  await mkdir(path.dirname(options.outputPath), { recursive: true })
  const staging = await mkdtemp(path.join(path.dirname(options.outputPath), 'standalone-export-'))
  const temporaryArchive = path.join(staging, `archive-${randomUUID()}.zip`)
  try {
    const files: StandaloneManifest['files'] = {}
    let bytes = 0
    let fileCount = 0
    let nativeRuntime: StandaloneNativeRuntime | undefined
    async function copyPackage(source: SourcePackage, directory: string, relative = '', ancestors = new Set<string>()): Promise<void> {
      const canonical = await realpath(directory)
      if (!inside(source.directory, canonical) || ancestors.has(canonical)) throw new Error(`${source.name} 包含包外链接或循环目录，无法便携导出。`)
      const nextAncestors = new Set([...ancestors, canonical])
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['node_modules', '.git', '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml', 'package-lock.json'].includes(entry.name) || entry.name === '.env' || entry.name.startsWith('.env.')) continue
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        const sourceFile = path.join(directory, entry.name)
        const resolved = await realpath(sourceFile)
        if (!inside(source.directory, resolved)) throw new Error(`${source.name} 的文件指向包外：${rel}`)
        const info = await stat(sourceFile)
        if (info.isDirectory()) { await copyPackage(source, sourceFile, rel, nextAncestors); continue }
        if (!info.isFile() || !safeRelative(rel)) throw new Error(`不能导出特殊文件：${source.name}/${rel}`)
        if (rel.toLowerCase().endsWith('.node') && !nativeRuntime) {
          if (!options.nativeRuntime) throw new Error(`${source.name} 含原生 Node 模块，请先配置并安装 DSH 使用的 Node.js 运行时：${rel}`)
          nativeRuntime = await options.nativeRuntime()
          validateStandaloneNativeRuntime(nativeRuntime)
          if (nativeRuntime.platform !== process.platform || nativeRuntime.arch !== process.arch) throw new Error('原生插件导出要求所选 Node.js 与当前系统、架构一致。')
          options.onProgress?.(`正在携带原生依赖，要求 ${nativeRuntime.platform}/${nativeRuntime.arch}、Node ${nativeRuntime.node}（ABI ${nativeRuntime.modules}）兼容环境`)
        }
        bytes += info.size
        if (bytes > LIMITS.maxUnpackedBytes || ++fileCount >= LIMITS.maxFiles - 4) throw new Error('独立插件体积或文件数量超过安全限制。')
        const archivePath = `private/packages/${source.id}/${rel}`
        const target = path.join(staging, archivePath)
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(sourceFile, target)
        files[archivePath] = { sha256: await hashFile(target), mode: info.mode & 0o111 ? 0o755 : 0o644 }
      }
    }
    for (const source of graph.values()) await copyPackage(source, source.directory)
    const nativeRequirement = nativeRuntime ? { nativeRuntime } : {}
    const manifest: StandaloneManifest = { format: FORMAT, schemaVersion: 1, name, version: options.version, dshVersion: options.dshVersion, platform: process.platform, arch: process.arch, ...nativeRequirement, sourceProfile: path.basename(options.profileDirectory), members: layers.map(layer => layer.archiveDirectory.split('/').at(-1)!), packages: [...graph.values()].map(({ directory: _directory, manifest: _manifest, ...entry }) => entry), files }
    const outer = { name, version: options.version, private: true, description: profile.description ?? `DSH Profile ${manifest.sourceProfile}`, dsh: { bundle: { patch: './cordis.patch.yml' }, standalone: { schemaVersion: 1, dshVersion: options.dshVersion, members, ...nativeRequirement } } }
    for (const [filename, content] of Object.entries({ 'package.json': `${JSON.stringify(outer, null, 2)}\n`, 'patch-template.yaml': template })) {
      await writeFile(path.join(staging, filename), content)
      files[filename] = { sha256: await hashFile(path.join(staging, filename)), mode: 0o644 }
    }
    materializeStandalonePluginPatch(template, staging, new Set(Object.keys(files)))
    await writeFile(path.join(staging, 'standalone.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const zip = new yazl.ZipFile()
    for (const [filename, file] of Object.entries(files)) zip.addFile(path.join(staging, filename), filename, { mode: file.mode })
    zip.addFile(path.join(staging, 'standalone.json'), 'standalone.json')
    const writing = pipeline(zip.outputStream, createWriteStream(temporaryArchive))
    zip.end()
    await writing
    if ((await stat(temporaryArchive)).size > LIMITS.maxArchiveBytes) throw new Error('独立插件压缩包超过 1 GiB。')
    await rename(temporaryArchive, options.outputPath)
    options.onProgress?.(`独立插件已生成：${members.length} 个成员，${graph.size} 个私有包`)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

function validateManifest(value: StandaloneManifest): void {
  if (!value || value.format !== FORMAT || value.schemaVersion !== 1 || !isSafePackageName(value.name) || isDshCorePackage(value.name) || !VERSION.test(value.version) || !VERSION.test(value.dshVersion)) throw new Error('不是有效的独立插件制品。')
  if (value.platform !== process.platform || value.arch !== process.arch) throw new Error(`独立插件需要 ${value.platform}/${value.arch}，与当前系统不一致。`)
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 5000 || !Array.isArray(value.members) || !value.members.length || !value.files || typeof value.files !== 'object') throw new Error('独立插件依赖清单无效。')
  const ids = new Set<string>()
  for (const entry of value.packages) {
    if (!entry || !ID.test(entry.id) || ids.has(entry.id) || !isSafePackageName(entry.name) || isDshCorePackage(entry.name) || !VERSION.test(entry.version) || !entry.dependencies || typeof entry.dependencies !== 'object') throw new Error('独立插件包含无效或重复的私有包。')
    ids.add(entry.id)
  }
  if (new Set(value.members).size !== value.members.length || value.members.some(id => !ids.has(id))) throw new Error('独立插件的成员列表不完整。')
  for (const entry of value.packages) for (const [name, edge] of Object.entries(entry.dependencies)) {
    if (!isSafePackageName(name) || !edge || (('package' in edge) ? !ids.has(edge.package) : edge.host !== name || !isDshCorePackage(name) || (edge.version !== null && !VERSION.test(edge.version)))) throw new Error(`独立插件依赖目标无效：${name}`)
  }
  for (const [filename, info] of Object.entries(value.files)) {
    const match = /^private\/packages\/(p\d{5})\/(.+)$/.exec(filename)
    const privateFile = match && ids.has(match[1]) && !match[2].split('/').some(segment => segment.toLowerCase() === 'node_modules')
    if (!safeRelative(filename) || !info || !/^[a-f0-9]{64}$/.test(info.sha256) || ![0o644, 0o755].includes(info.mode)
      || (!['package.json', 'patch-template.yaml'].includes(filename) && !privateFile)) throw new Error(`独立插件文件清单无效：${filename}`)
  }
  for (const required of ['package.json', 'patch-template.yaml', ...value.packages.map(entry => `private/packages/${entry.id}/package.json`)]) {
    if (!Object.hasOwn(value.files, required)) throw new Error(`独立插件缺少 ${required}`)
  }
  const hasNativeFiles = Object.keys(value.files).some(filename => filename.toLowerCase().endsWith('.node'))
  if (hasNativeFiles || value.nativeRuntime !== undefined) {
    validateStandaloneNativeRuntime(value.nativeRuntime)
    if (!hasNativeFiles || value.nativeRuntime.platform !== value.platform || value.nativeRuntime.arch !== value.arch) throw new Error('独立插件的原生运行时声明与文件清单不一致。')
  }
}

export interface StandaloneImportOptions {
  archivePath: string
  dshHome: string
  profileName: string
  pluginReceiptsPath: string
  hostNodeModules: (dshVersion: string) => Promise<string>
  nativeRuntime?: () => Promise<StandaloneNativeRuntime>
  onProgress?: (message: string) => void
}

async function linkDirectory(target: string, link: string): Promise<void> {
  await mkdir(path.dirname(link), { recursive: true })
  const previous = await lstat(link).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (previous) {
    if (previous.isSymbolicLink() && await realpath(link) === await realpath(target)) return
    throw new Error(`独立插件私有依赖链接不一致：${link}`)
  }
  await symlink(process.platform === 'win32' ? target : path.relative(path.dirname(link), target), link, process.platform === 'win32' ? 'junction' : 'dir')
}

/** No build scripts, package-manager resolution or shared-store operations. */
export async function importStandalonePlugin(options: StandaloneImportOptions) {
  if (!isSafeProfileName(options.profileName)) throw new Error('Profile 名称无效。')
  const archive = await openZipPathFromFile(options.archivePath, LIMITS)
  let staging: string | null = null
  let installedDirectory: string | null = null
  let attached = false
  try {
    const manifestEntry = archive.entries.find(entry => entry.entryName === 'standalone.json')
    if (!manifestEntry) throw new Error('请选择通过“导出为独立插件”生成的 .dsh-plugin.zip。')
    const manifest = JSON.parse((await archive.readEntryData(manifestEntry, 16 * 1024 ** 2)).toString('utf8')) as StandaloneManifest
    validateManifest(manifest)
    const hostRoot = await options.hostNodeModules(manifest.dshVersion)
    if (manifest.nativeRuntime) {
      if (!options.nativeRuntime) throw new Error('独立插件包含原生依赖，请先配置并安装兼容的 Node.js 运行时。')
      assertStandaloneNativeCompatibility(manifest.nativeRuntime, await options.nativeRuntime())
    }
    const sourceDigest = await hashFile(options.archivePath)
    const profileDirectory = path.join(options.dshHome, 'profiles', options.profileName)
    if (!samePath(await realpath(profileDirectory), path.join(await realpath(options.dshHome), 'profiles', options.profileName))) throw new Error('Profile 目录不能包含重定向链接。')
    const profileFile = path.join(profileDirectory, 'package.json')
    const previousText = await readFile(profileFile, 'utf8')
    const profile = JSON.parse(previousText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
    const declared = { ...profile.dependencies, ...profile.devDependencies, ...profile.optionalDependencies, ...profile.peerDependencies }
    const existingLink = await lstat(path.join(profileDirectory, 'node_modules', ...manifest.name.split('/'))).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (Object.hasOwn(declared, manifest.name) || profile.dsh?.profile?.bundles?.includes(manifest.name) || existingLink) throw new Error(`当前 Profile 已有 ${manifest.name}，请先卸载再导入。`)
    const packageRoot = await managedPackageRoot(options.dshHome, manifest.name)
    const destination = path.join(packageRoot, sourceDigest)
    staging = await mkdtemp(path.join(packageRoot, '.import-'))
    const seen = new Set<string>()
    const budget = { extracted: 0 }
    options.onProgress?.(`正在校验独立插件 ${manifest.name}`)
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue
      const filename = entry.entryName
      const key = filename.toLowerCase()
      if (!safeRelative(filename) || seen.has(key) || (filename !== 'standalone.json' && !Object.hasOwn(manifest.files, filename))) throw new Error(`独立插件包含未声明或重复的文件：${filename}`)
      seen.add(key)
      const target = path.join(staging, filename)
      await archive.writeEntryToFile(entry, target, { budget, maxTotalBytes: LIMITS.maxUnpackedBytes })
      if (filename !== 'standalone.json') {
        if (await hashFile(target) !== manifest.files[filename].sha256) throw new Error(`独立插件文件校验失败：${filename}`)
        await chmod(target, manifest.files[filename].mode)
      }
    }
    if (Object.keys(manifest.files).some(filename => !seen.has(filename.toLowerCase()))) throw new Error('独立插件缺少清单声明的文件。')
    const outer = await json<PackageJson>(path.join(staging, 'package.json'))
    if (outer.name !== manifest.name || outer.version !== manifest.version || outer.dsh?.standalone?.schemaVersion !== 1 || outer.dsh?.bundle?.patch !== './cordis.patch.yml' || ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(field => Object.keys(outer[field] ?? {}).length)) throw new Error('独立插件入口与制品清单不一致。')
    const memberNames = manifest.members.map(id => manifest.packages.find(entry => entry.id === id)!.name)
    if (outer.dsh.standalone.dshVersion !== manifest.dshVersion || JSON.stringify(outer.dsh.standalone.members) !== JSON.stringify(memberNames)) throw new Error('独立插件的 DSH 版本或成员顺序与制品清单不一致。')
    if (JSON.stringify(outer.dsh.standalone.nativeRuntime) !== JSON.stringify(manifest.nativeRuntime)) throw new Error('独立插件的原生运行时要求与制品清单不一致。')
    for (const entry of manifest.packages) {
      const source = await json<PackageJson>(path.join(staging, 'private', 'packages', entry.id, 'package.json'))
      if (source.name !== entry.name || source.version !== entry.version) throw new Error(`私有包身份不一致：${entry.name}`)
      const required = { ...source.dependencies, ...Object.fromEntries(Object.entries(source.peerDependencies ?? {}).filter(([name]) => !source.peerDependenciesMeta?.[name]?.optional)) }
      for (const name of Object.keys(required)) {
        if (!(name in (source.optionalDependencies ?? {})) && !Object.hasOwn(entry.dependencies, name)) throw new Error(`独立插件依赖闭包不完整：${entry.name} 缺少 ${name}`)
      }
      const declarations = { ...source.peerDependencies, ...source.dependencies, ...source.optionalDependencies }
      for (const [name, edge] of Object.entries(entry.dependencies)) {
        if (!('package' in edge)) continue
        const target = manifest.packages.find(item => item.id === edge.package)!
        const specifier = declarations[name] ?? ''
        const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/.exec(specifier)?.[1]
        if (target.name !== (alias ?? name) || (VERSION.test(specifier) && target.version !== specifier)) throw new Error(`独立插件依赖身份不一致：${entry.name} 的 ${name}`)
      }
    }
    // Reusing an already imported artifact is allowed; it never shares content with ordinary plugins.
    const existingDestination = await lstat(destination).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!existingDestination) {
      await rename(staging, destination)
      staging = null
      installedDirectory = destination
    } else {
      if (!existingDestination.isDirectory() || !samePath(await realpath(destination), destination)) throw new Error('已有独立插件目录不安全。')
      for (const [filename, info] of Object.entries(manifest.files)) {
        const file = path.join(destination, filename)
        if (!(await lstat(file)).isFile() || !inside(destination, await realpath(file)) || await hashFile(file) !== info.sha256) throw new Error(`已安装独立插件内容不一致，请先卸载后重新导入：${filename}`)
      }
    }
    const hostDirectories = new Map<string, string>()
    const hostAnchors: string[] = []
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot']) {
      const direct = await realpath(path.join(hostRoot, ...name.split('/'))).catch(() => null)
      if (direct) hostAnchors.push(direct)
      else for (const anchor of [...hostAnchors]) {
        const indirect = await dependencyDirectory(anchor, name)
        if (indirect) hostAnchors.push(indirect)
      }
    }
    async function resolveHost(name: string, version: string | null): Promise<string> {
      const key = `${name}@${version ?? ''}`
      const cached = hostDirectories.get(key)
      if (cached) return cached
      const candidates = [path.join(hostRoot, ...name.split('/'))]
      for (const anchor of hostAnchors) {
        const found = await dependencyDirectory(anchor, name)
        if (found) candidates.push(found)
      }
      for (const candidate of candidates) {
        const host = await json<PackageJson>(path.join(candidate, 'package.json')).catch(() => null)
        if (host?.name === name && (!version || host.version === version)) {
          const resolved = await realpath(candidate)
          hostDirectories.set(key, resolved)
          return resolved
        }
      }
      throw new Error(`DSH ${manifest.dshVersion} 未提供兼容的宿主依赖 ${key}。`)
    }
    for (const entry of manifest.packages) {
      const directory = path.join(destination, 'private', 'packages', entry.id)
      if (!samePath(await realpath(directory), directory)) throw new Error('独立插件私有包目录被重定向。')
      for (const [name, edge] of Object.entries(entry.dependencies)) {
        const target = 'package' in edge ? path.join(destination, 'private', 'packages', edge.package) : await resolveHost(edge.host, edge.version)
        const link = path.join(directory, 'node_modules', ...name.split('/'))
        if (existingDestination) {
          const valid = await lstat(link).then(async info => info.isSymbolicLink()
            && samePath(await realpath(path.dirname(link)), path.dirname(link))
            && samePath(await realpath(link), await realpath(target))).catch(() => false)
          if (!valid) throw new Error(`已安装独立插件链接不一致，请先卸载后重新导入：${name}`)
        } else await linkDirectory(target, link)
      }
    }
    const patchTemplate = await readFile(path.join(destination, 'patch-template.yaml'), 'utf8')
    for (const specifier of standalonePatchHostModules(patchTemplate)) {
      const host = await resolveHost(modulePackage(specifier), null)
      try {
        const moduleUrl = resolveImport(specifier, pathToFileURL(path.join(host, 'package.json')).href)
        const moduleFile = fileURLToPath(moduleUrl)
        if (!inside(host, await realpath(moduleFile)) || !(await stat(moduleFile)).isFile()) throw new Error('模块不在宿主包内')
      } catch (error) {
        throw new Error(`DSH ${manifest.dshVersion} 无法提供宿主模块 ${specifier}：${String(error)}`)
      }
    }
    const compiledPatch = materializeStandalonePluginPatch(patchTemplate, destination, new Set(Object.keys(manifest.files)))
    const patchFile = path.join(destination, 'cordis.patch.yml')
    if (existingDestination) {
      if (!(await lstat(patchFile)).isFile() || await readFile(patchFile, 'utf8') !== compiledPatch) throw new Error('已安装独立插件补丁不一致，请先卸载后重新导入。')
    } else await writeFile(patchFile, compiledPatch)
    options.onProgress?.(`正在注册 ${manifest.name}，内部 ${manifest.members.length} 个插件保持私有`)
    await ensureStandalonePluginLink(options.dshHome, options.profileName, manifest.name, destination)
    try {
      const bundles = profile.dsh?.profile?.bundles ?? []
      const next = { ...profile, dependencies: { ...profile.dependencies, [manifest.name]: `link:${destination}` }, dsh: { ...profile.dsh, profile: { ...profile.dsh?.profile, bundles: [...bundles, manifest.name] } } }
      await writeFile(profileFile, `${JSON.stringify(next, null, 2)}\n`)
      await recordPluginInstall(options.pluginReceiptsPath, { repository: `file:${destination}`, packageName: manifest.name, profileName: options.profileName, source: 'local-directory', subdirectory: null, version: manifest.version, commit: '', installedAt: new Date().toISOString(), actualSource: 'local' })
      attached = true
    } catch (error) {
      await writeFile(profileFile, previousText)
      await rm(path.join(profileDirectory, 'node_modules', ...manifest.name.split('/')), { recursive: true, force: true })
      await removePluginReceipt(options.pluginReceiptsPath, options.profileName, manifest.name)
      throw error
    }
    options.onProgress?.(`独立插件导入完成：${manifest.name}@${manifest.version}`)
    return readProfile(options.dshHome, options.profileName, options.pluginReceiptsPath)
  } finally {
    await archive.close()
    if (staging) await rm(staging, { recursive: true, force: true })
    if (installedDirectory && !attached) await rm(installedDirectory, { recursive: true, force: true })
  }
}
