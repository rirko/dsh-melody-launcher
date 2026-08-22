// 整合包（Pack）压缩包的纯函数域：读取检查 / 解出插件本体 / 重新打包。
// 不依赖 Electron，仅 adm-zip + node:fs + yauzl/yazl。
//
// 大包路径：为避免把 1.3GB 整合包整体 readFile 进内存，这里同时提供
// 基于 Buffer 的旧 API（测试/小包）和基于文件路径 + 流式读取的新 API。

import { createWriteStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import AdmZip from 'adm-zip'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import type { PackManifest } from '../src/types'
import { isSafePackageName } from './profile'
import { PACK_MANIFEST_FILENAME, PROFILE_MANIFEST_FILENAME, parsePackManifest, serializePackManifest } from './pack-manifest'

export interface PackZipLimits {
  maxArchiveBytes: number
  maxFiles: number
  maxUnpackedBytes: number
}

export const DEFAULT_PACK_ZIP_LIMITS: PackZipLimits = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxFiles: 12_000,
  maxUnpackedBytes: 256 * 1024 * 1024,
}

export interface PackZipInspection {
  manifest: PackManifest
  hasBodies: boolean
  bodyPackageNames: string[]
  presetBodyNames: string[]
}

const PLUGIN_BODIES_PREFIX = 'plugin-bodies/'
const PRESET_BODIES_PREFIX = 'preset-bodies/'

/** 标准包清单读取上限（清单本身很小，给一个安全余量即可）。 */
const MAX_MANIFEST_BYTES = 1 * 1024 * 1024

/** 流式打开时的“宽松探测”限额：只防极端条目数/路径风险，体积限制交给后续严格检查。 */
const LOOSE_PATH_LIMITS = {
  maxArchiveBytes: Number.MAX_SAFE_INTEGER,
  maxFiles: 1_000_000,
}

/**
 * zip 条目路径安全校验：归一化 + 拒绝 `..` / 绝对路径 / 反斜杠 / 空段。
 * 与 skill-catalog 的 safeArchivePath 同源，额外拒绝了空段与 `.` 段。
 * 导出供 raw 扫描（pack-scan.ts）复用。
 */
export function safeArchivePath(value: string): string | null {
  if (value.includes('\\')) return null
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  const normalized = path.posix.normalize(value).replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
  return normalized
}

/** 断言 target 位于 root 之下（防止解出路径越界）。导出供 raw 扫描复用。 */
export function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('解出路径超出了允许范围。')
  }
}

interface OpenPackZip {
  entries: AdmZip.IZipEntry[]
  stripRoot: string | null
}

/**
 * 检测整体套一层顶层目录：全部条目共享同一首段且它不是清单/plugin-bodies 时视为包裹层。
 * 仅统计非目录条目；返回包裹层首段，否则 null。
 */
function computeStripRoot(entries: ReadonlyArray<{ entryName: string; isDirectory: boolean }>): string | null {
  const firstSegments = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    firstSegments.add(safe.split('/')[0])
  }
  if (firstSegments.size !== 1) return null
  const only = [...firstSegments][0]
  if (only !== PACK_MANIFEST_FILENAME && only !== PROFILE_MANIFEST_FILENAME && !only.startsWith(PLUGIN_BODIES_PREFIX)) return only
  return null
}

function openArchive(buffer: Uint8Array, limits: PackZipLimits): OpenPackZip {
  if (buffer.byteLength > limits.maxArchiveBytes) throw new Error('整合包压缩包过大。')
  const archive = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
  const entries = archive.getEntries()
  if (entries.length === 0) throw new Error('整合包压缩包为空。')
  if (entries.length > limits.maxFiles) throw new Error('整合包文件数量超过安全限制。')

  let unpackedBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!safeArchivePath(entry.entryName)) throw new Error('整合包包含不安全路径。')
    unpackedBytes += Number(entry.header.size) || 0
  }
  if (unpackedBytes > limits.maxUnpackedBytes) throw new Error('整合包解压体积超过安全限制。')

  return { entries, stripRoot: computeStripRoot(entries) }
}

/**
 * 宽松探测：zip 内是否存在 dsh-pack.yaml（尊重单顶层目录包裹）。
 * 不做体积/文件数/解压体积限额——那是严格 inspectPackZip 与 raw 扫描各自的责任；
 * 这里只负责「判定是否为标准格式包」并返回清单文本。全部条目仍过路径安全校验。
 */
export function findManifestInArchive(buffer: Uint8Array): string | null {
  const archive = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
  const entries = archive.getEntries()
  if (entries.length === 0) return null
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!safeArchivePath(entry.entryName)) throw new Error('整合包包含不安全路径。')
  }
  const stripRoot = computeStripRoot(entries)
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    const rel = relForEntry(safe, stripRoot)
    if (rel === PACK_MANIFEST_FILENAME || rel === PROFILE_MANIFEST_FILENAME) return entry.getData().toString('utf8')
  }
  return null
}

function relForEntry(safe: string, stripRoot: string | null): string {
  return stripRoot && safe.startsWith(`${stripRoot}/`) ? safe.slice(stripRoot.length + 1) : safe
}

interface DecodedBody {
  pkg: string
  rel: string
}

/**
 * 解析 plugin-bodies/<...> 的相对路径，兼容 `@scope/pkg`（嵌套）与 `@scope-pkg`（单段编码）两种形态。
 *
 * 歧义：`@my-scope/web-ui` 可能是嵌套包 `@my-scope/web-ui`，也可能是单段编码的 `@my/scope`。
 * 路径本身无法消歧，因此优先用清单已知包名（knownNames）判定：命中哪一形态就用哪一形态；
 * 清单未列出时回退到「带 `-` 的首段按单段编码」的历史规则，保证既有 zip 可读。
 */
function decodeBodyEntry(rel: string, knownNames?: ReadonlySet<string>): DecodedBody | null {
  const rest = rel.slice(PLUGIN_BODIES_PREFIX.length)
  if (!rest) return null
  const segments = rest.split('/')
  const first = segments[0]
  if (first.startsWith('@')) {
    const nestedPkg = segments.length >= 2 ? `${first}/${segments[1]}` : null
    const nestedOk = nestedPkg !== null && isSafePackageName(nestedPkg)
    let encodedPkg: string | null = null
    if (first.includes('-')) {
      const decoded = first.replace('-', '/')
      if (isSafePackageName(decoded)) encodedPkg = decoded
    }
    if (knownNames && knownNames.size > 0) {
      if (nestedOk && knownNames.has(nestedPkg!)) return { pkg: nestedPkg!, rel: segments.slice(2).join('/') }
      if (encodedPkg && knownNames.has(encodedPkg)) return { pkg: encodedPkg, rel: segments.slice(1).join('/') }
    }
    if (encodedPkg) return { pkg: encodedPkg, rel: segments.slice(1).join('/') }
    if (nestedOk) return { pkg: nestedPkg!, rel: segments.slice(2).join('/') }
    return null
  }
  if (isSafePackageName(first)) return { pkg: first, rel: segments.slice(1).join('/') }
  return null
}

/** 读取并检查整合包：解析清单、检测 plugin-bodies，全程 zip-slip + 限额校验。 */
export function inspectPackZip(buffer: Uint8Array, limits: PackZipLimits = DEFAULT_PACK_ZIP_LIMITS): PackZipInspection {
  const { entries, stripRoot } = openArchive(buffer, limits)
  // 两遍解析：先取清单，再以清单内已知包名解码 scoped body，避免嵌套 / 单段编码歧义。
  let manifestText: string | null = null
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    const rel = relForEntry(safe, stripRoot)
    if (rel === PACK_MANIFEST_FILENAME || rel === PROFILE_MANIFEST_FILENAME) {
      manifestText = entry.getData().toString('utf8')
      break
    }
  }
  if (!manifestText) throw new Error(`压缩包内没有找到 ${PACK_MANIFEST_FILENAME}。`)
  const manifest = parsePackManifest(manifestText)
  const knownNames = new Set(manifest.plugins.map(plugin => plugin.packageName))

  const bodyPackageNames = new Set<string>()
  const presetBodyNames = new Set<string>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) continue
    const rel = relForEntry(safe, stripRoot)
    if (rel.startsWith(PLUGIN_BODIES_PREFIX)) {
      const decoded = decodeBodyEntry(rel, knownNames)
      if (decoded) bodyPackageNames.add(decoded.pkg)
    }
    if (rel.startsWith(PRESET_BODIES_PREFIX)) {
      const rest = rel.slice(PRESET_BODIES_PREFIX.length)
      const name = rest.split('/')[0]
      if (name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) presetBodyNames.add(name)
    }
  }
  return {
    manifest,
    hasBodies: bodyPackageNames.size > 0,
    bodyPackageNames: [...bodyPackageNames],
    presetBodyNames: [...presetBodyNames],
  }
}

/**
 * 把 plugin-bodies/<packageName>/… 解到 workDir/<packageName>/（带 zip-slip 与限额），返回 包名→目录。
 * knownNames 传入清单已知包名以消歧 scoped 解码；未传入时按历史规则回退。
 * 解压字节以「实际解出的字节」累计（header 声明的 size 可被伪造，不能作为 zip-bomb 依据）。
 */
export async function extractPackBodies(
  buffer: Uint8Array,
  workDir: string,
  limits: PackZipLimits = DEFAULT_PACK_ZIP_LIMITS,
  knownNames?: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const { entries, stripRoot } = openArchive(buffer, limits)
  const resolvedWorkDir = path.resolve(workDir)
  await mkdir(resolvedWorkDir, { recursive: true })
  const result = new Map<string, string>()
  let extractedBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safe = safeArchivePath(entry.entryName)
    if (!safe) throw new Error('整合包包含不安全路径。')
    const rel = relForEntry(safe, stripRoot)
    if (!rel.startsWith(PLUGIN_BODIES_PREFIX)) continue
    const decoded = decodeBodyEntry(rel, knownNames)
    if (!decoded || !decoded.rel) continue
    const packageDirectory = path.join(resolvedWorkDir, ...decoded.pkg.split('/'))
    assertInside(resolvedWorkDir, packageDirectory)
    const target = path.join(packageDirectory, ...decoded.rel.split('/'))
    assertInside(resolvedWorkDir, target)
    const data = entry.getData()
    extractedBytes += data.byteLength
    if (extractedBytes > limits.maxUnpackedBytes) throw new Error('整合包解压体积超过安全限制。')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
    result.set(decoded.pkg, packageDirectory)
  }
  return result
}

/** 用 adm-zip 打包：dsh-pack.yaml + plugin-bodies/<packageName>/…（无 body 时即 manifest-only 包）。 */
export function buildPackZip(manifest: PackManifest, bodyDirs: Map<string, string>): Uint8Array {
  const zip = new AdmZip()
  const manifestBuffer = Buffer.from(serializePackManifest(manifest), 'utf8')
  zip.addFile(PACK_MANIFEST_FILENAME, manifestBuffer)
  zip.addFile(PROFILE_MANIFEST_FILENAME, manifestBuffer)
  for (const [packageName, directory] of bodyDirs) {
    const base = `${PLUGIN_BODIES_PREFIX}${packageName}`
    const stack: Array<{ dir: string; rel: string }> = [{ dir: directory, rel: '' }]
    while (stack.length > 0) {
      const current = stack.pop()!
      let childNames: string[] = []
      try {
        childNames = readdirSync(current.dir)
      } catch (error) {
        throw new Error(`无法读取插件本体目录：${current.dir}。`)
      }
      for (const childName of childNames) {
        const childPath = path.join(current.dir, childName)
        let stats
        try {
          stats = statSync(childPath)
        } catch (error) {
          throw new Error(`无法读取插件本体文件：${childPath}。`)
        }
        const childRel = current.rel ? `${current.rel}/${childName}` : childName
        if (stats.isDirectory()) {
          stack.push({ dir: childPath, rel: childRel })
        } else if (stats.isFile()) {
          zip.addFile(`${base}/${childRel}`, readFileSync(childPath))
        }
      }
    }
  }
  return new Uint8Array(zip.toBuffer())
}

// ===========================================================================
// 流式路径 API（大整合包）
// ===========================================================================

/** yauzl 打开读取流真正依赖的字段；不保留 fileNameRaw/extraFieldRaw 等大 Buffer。 */
interface YauzlEntryRef {
  compressedSize: number
  uncompressedSize: number
  relativeOffsetOfLocalHeader: number
  generalPurposeBitFlag: number
  compressionMethod: number
  isEncrypted(): boolean
  isCompressed(): boolean
  canDecodeFileData(): boolean
}

export interface ZipPathEntry {
  readonly entryName: string
  readonly isDirectory: boolean
  readonly declaredSize: number
  /** 仅供 pack-zip 内部实现使用的轻量 yauzl 引用；外部不要直接依赖。 */
  readonly raw: YauzlEntryRef
}

export interface WriteEntryOptions {
  /** 跨条目共享的实际解压字节预算（zip-bomb 防护）。 */
  budget?: { extracted: number }
  /** 单个条目解压字节上限。 */
  maxEntryBytes?: number
  /** 累计解压字节上限（配合 budget 使用）。 */
  maxTotalBytes?: number
}

export interface OpenZipPath {
  readonly entries: ZipPathEntry[]
  readonly stripRoot: string | null
  readEntryData(entry: ZipPathEntry, maxBytes?: number): Promise<Buffer>
  writeEntryToFile(entry: ZipPathEntry, targetPath: string, options?: WriteEntryOptions): Promise<number>
  close(): Promise<void>
}

export interface PackZipPathLimits {
  maxArchiveBytes: number
  maxFiles: number
  maxUnpackedBytes?: number
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  if (entry.fileName.endsWith('/')) return true
  // Unix：高 16 位是 mode，S_IFDIR = 0o040000。
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  if ((unixMode & 0o170000) === 0o040000) return true
  // DOS/Windows：目录属性 0x10 在低位。
  if ((entry.externalFileAttributes & 0x10) !== 0) return true
  return false
}

async function openYauzlZip(filePath: string): Promise<yauzl.ZipFile> {
  return yauzl.openPromise(filePath, {
    lazyEntries: true,
    autoClose: false,
    decodeStrings: true,
  })
}

async function readZipPathEntries(zipfile: yauzl.ZipFile): Promise<ZipPathEntry[]> {
  const entries: ZipPathEntry[] = []
  for await (const entry of zipfile.eachEntry()) {
    // 立刻转成轻量引用并丢弃 yauzl 原始 Entry（避免 fileNameRaw/extraFieldRaw 等 Buffer 常驻）。
    entries.push(toZipPathEntry(entry))
  }
  return entries
}

function toZipPathEntry(entry: yauzl.Entry): ZipPathEntry {
  return {
    entryName: entry.fileName,
    isDirectory: isDirectoryEntry(entry),
    declaredSize: entry.uncompressedSize,
    raw: {
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader,
      generalPurposeBitFlag: entry.generalPurposeBitFlag,
      compressionMethod: entry.compressionMethod,
      isEncrypted() {
        return (this.generalPurposeBitFlag & 0x1) !== 0
      },
      isCompressed() {
        return this.compressionMethod === 8
      },
      canDecodeFileData() {
        return !this.isEncrypted() && (this.compressionMethod === 0 || this.compressionMethod === 8)
      },
    },
  }
}

async function readStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        fail(new Error('条目解压体积超过安全限制。'))
        stream.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    stream.on('error', fail)
  })
}

async function writeStreamToFile(stream: Readable, targetPath: string, options?: WriteEntryOptions): Promise<number> {
  await mkdir(path.dirname(targetPath), { recursive: true })
  const output = createWriteStream(targetPath)
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      if (options?.maxEntryBytes !== undefined && written > options.maxEntryBytes) {
        callback(new Error('单个文件解压体积超过安全限制。'))
        return
      }
      if (options?.budget) {
        options.budget.extracted += chunk.length
        if (options.maxTotalBytes !== undefined && options.budget.extracted > options.maxTotalBytes) {
          callback(new Error('整合包解压体积超过安全限制。'))
          return
        }
      }
      callback(null, chunk)
    },
  })
  await pipeline(stream, counter, output)
  return written
}

function makePathHandle(zipfile: yauzl.ZipFile, entries: ZipPathEntry[], stripRoot: string | null): OpenZipPath {
  return {
    entries,
    stripRoot,
    async readEntryData(entry, maxBytes) {
      const limit = maxBytes ?? Math.max(entry.declaredSize, 1)
      const stream = await zipfile.openReadStreamPromise(entry.raw as unknown as yauzl.Entry)
      return readStream(stream, limit)
    },
    async writeEntryToFile(entry, targetPath, options) {
      const stream = await zipfile.openReadStreamPromise(entry.raw as unknown as yauzl.Entry)
      return writeStreamToFile(stream, targetPath, options)
    },
    async close() {
      zipfile.close()
    },
  }
}

export async function openZipPathFromFile(filePath: string, limits: PackZipPathLimits): Promise<OpenZipPath> {
  const fileStats = await stat(filePath)
  if (fileStats.size > limits.maxArchiveBytes) throw new Error('整合包压缩包过大。')
  const zipfile = await openYauzlZip(filePath)
  try {
    const entries = await readZipPathEntries(zipfile)
    if (entries.length === 0) throw new Error('整合包压缩包为空。')
    if (entries.length > limits.maxFiles) throw new Error('整合包文件数量超过安全限制。')

    let unpackedBytes = 0
    for (const entry of entries) {
      if (entry.isDirectory) continue
      if (!safeArchivePath(entry.entryName)) throw new Error('整合包包含不安全路径。')
      unpackedBytes += entry.declaredSize || 0
    }
    if (limits.maxUnpackedBytes !== undefined && unpackedBytes > limits.maxUnpackedBytes) {
      throw new Error('整合包解压体积超过安全限制。')
    }

    return makePathHandle(zipfile, entries, computeStripRoot(entries))
  } catch (error) {
    zipfile.close()
    throw error
  }
}

/** 以严格的标准整合包限额打开文件路径 zip。 */
export function openStandardPackZipFromPath(
  filePath: string,
  limits: PackZipLimits = DEFAULT_PACK_ZIP_LIMITS,
): Promise<OpenZipPath> {
  return openZipPathFromFile(filePath, limits)
}

/** 以宽松探测限额打开文件路径 zip（用于先判断标准包还是 raw 包）。 */
export function openLooseZipFromPath(filePath: string): Promise<OpenZipPath> {
  return openZipPathFromFile(filePath, LOOSE_PATH_LIMITS)
}

/** 文件路径版 findManifestInArchive。 */
export async function findManifestInArchiveFromPath(filePath: string): Promise<string | null> {
  const handle = await openLooseZipFromPath(filePath)
  try {
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) continue
      const rel = relForEntry(safe, handle.stripRoot)
      if (rel === PACK_MANIFEST_FILENAME || rel === PROFILE_MANIFEST_FILENAME) {
        const data = await handle.readEntryData(entry, MAX_MANIFEST_BYTES)
        return data.toString('utf8')
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/** 文件路径版 inspectPackZip。 */
export async function inspectPackZipFromPath(
  filePath: string,
  limits: PackZipLimits = DEFAULT_PACK_ZIP_LIMITS,
): Promise<PackZipInspection> {
  const handle = await openStandardPackZipFromPath(filePath, limits)
  try {
    let manifestText: string | null = null
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) continue
      const rel = relForEntry(safe, handle.stripRoot)
      if (rel === PACK_MANIFEST_FILENAME || rel === PROFILE_MANIFEST_FILENAME) {
        const data = await handle.readEntryData(entry, MAX_MANIFEST_BYTES)
        manifestText = data.toString('utf8')
        break
      }
    }
    if (!manifestText) throw new Error(`压缩包内没有找到 ${PACK_MANIFEST_FILENAME}。`)
    const manifest = parsePackManifest(manifestText)
    const knownNames = new Set(manifest.plugins.map(plugin => plugin.packageName))

    const bodyPackageNames = new Set<string>()
    const presetBodyNames = new Set<string>()
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) continue
      const rel = relForEntry(safe, handle.stripRoot)
      if (rel.startsWith(PLUGIN_BODIES_PREFIX)) {
        const decoded = decodeBodyEntry(rel, knownNames)
        if (decoded) bodyPackageNames.add(decoded.pkg)
      }
      if (rel.startsWith(PRESET_BODIES_PREFIX)) {
        const rest = rel.slice(PRESET_BODIES_PREFIX.length)
        const name = rest.split('/')[0]
        if (name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) presetBodyNames.add(name)
      }
    }
    return {
      manifest,
      hasBodies: bodyPackageNames.size > 0,
      bodyPackageNames: [...bodyPackageNames],
      presetBodyNames: [...presetBodyNames],
    }
  } finally {
    await handle.close()
  }
}

/** 文件路径版 extractPackBodies。 */
export async function extractPackBodiesFromPath(
  filePath: string,
  workDir: string,
  limits: PackZipLimits = DEFAULT_PACK_ZIP_LIMITS,
  knownNames?: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const handle = await openStandardPackZipFromPath(filePath, limits)
  try {
    const resolvedWorkDir = path.resolve(workDir)
    await mkdir(resolvedWorkDir, { recursive: true })
    const result = new Map<string, string>()
    const budget = { extracted: 0 }
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) throw new Error('整合包包含不安全路径。')
      const rel = relForEntry(safe, handle.stripRoot)
      if (!rel.startsWith(PLUGIN_BODIES_PREFIX)) continue
      const decoded = decodeBodyEntry(rel, knownNames)
      if (!decoded || !decoded.rel) continue
      const packageDirectory = path.join(resolvedWorkDir, ...decoded.pkg.split('/'))
      assertInside(resolvedWorkDir, packageDirectory)
      const target = path.join(packageDirectory, ...decoded.rel.split('/'))
      assertInside(resolvedWorkDir, target)
      await handle.writeEntryToFile(entry, target, { budget, maxTotalBytes: limits.maxUnpackedBytes })
      result.set(decoded.pkg, packageDirectory)
    }
    return result
  } finally {
    await handle.close()
  }
}

/** 文件路径版解出 preset-bodies/<name>/… 到 workDir/<name>/。 */
export async function extractPresetBodiesFromPath(
  filePath: string,
  workDir: string,
  limits: PackZipLimits = DEFAULT_PACK_ZIP_LIMITS,
): Promise<Map<string, string>> {
  const handle = await openStandardPackZipFromPath(filePath, limits)
  try {
    const resolvedWorkDir = path.resolve(workDir)
    await mkdir(resolvedWorkDir, { recursive: true })
    const result = new Map<string, string>()
    const budget = { extracted: 0 }
    for (const entry of handle.entries) {
      if (entry.isDirectory) continue
      const safe = safeArchivePath(entry.entryName)
      if (!safe) throw new Error('整合包包含不安全路径。')
      const rel = relForEntry(safe, handle.stripRoot)
      if (!rel.startsWith(PRESET_BODIES_PREFIX)) continue
      const rest = rel.slice(PRESET_BODIES_PREFIX.length)
      const [name, ...restParts] = rest.split('/')
      if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || restParts.length === 0) continue
      const presetDirectory = path.join(resolvedWorkDir, name)
      assertInside(resolvedWorkDir, presetDirectory)
      const target = path.join(presetDirectory, ...restParts)
      assertInside(resolvedWorkDir, target)
      await handle.writeEntryToFile(entry, target, { budget, maxTotalBytes: limits.maxUnpackedBytes })
      result.set(name, presetDirectory)
    }
    return result
  } finally {
    await handle.close()
  }
}

/** 用 yazl 流式把整合包写入文件（大包导出不占内存）。 */
export async function buildPackZipToFile(
  manifest: PackManifest,
  bodyDirs: Map<string, string>,
  outputPath: string,
  presetDirs: Map<string, string> = new Map(),
): Promise<void> {
  const zip = new yazl.ZipFile()
  const manifestBuffer = Buffer.from(serializePackManifest(manifest), 'utf8')
  zip.addBuffer(manifestBuffer, PACK_MANIFEST_FILENAME)
  zip.addBuffer(manifestBuffer, PROFILE_MANIFEST_FILENAME)
  for (const [packageName, directory] of bodyDirs) {
    const base = `${PLUGIN_BODIES_PREFIX}${packageName}`
    const stack: Array<{ dir: string; rel: string }> = [{ dir: directory, rel: '' }]
    while (stack.length > 0) {
      const current = stack.pop()!
      let childNames: string[] = []
      try {
        childNames = readdirSync(current.dir)
      } catch (error) {
        throw new Error(`无法读取插件本体目录：${current.dir}。`)
      }
      for (const childName of childNames) {
        const childPath = path.join(current.dir, childName)
        let stats
        try {
          stats = statSync(childPath)
        } catch (error) {
          throw new Error(`无法读取插件本体文件：${childPath}。`)
        }
        const childRel = current.rel ? `${current.rel}/${childName}` : childName
        if (stats.isDirectory()) {
          stack.push({ dir: childPath, rel: childRel })
        } else if (stats.isFile()) {
          zip.addFile(childPath, `${base}/${childRel}`)
        }
      }
    }
  }
  for (const [presetName, directory] of presetDirs) {
    const base = `${PRESET_BODIES_PREFIX}${presetName}`
    const stack: Array<{ dir: string; rel: string }> = [{ dir: directory, rel: '' }]
    while (stack.length > 0) {
      const current = stack.pop()!
      let childNames: string[] = []
      try {
        childNames = readdirSync(current.dir)
      } catch (error) {
        throw new Error(`无法读取预设本体目录：${current.dir}。`)
      }
      for (const childName of childNames) {
        const childPath = path.join(current.dir, childName)
        let stats
        try {
          stats = statSync(childPath)
        } catch (error) {
          throw new Error(`无法读取预设本体文件：${childPath}。`)
        }
        const childRel = current.rel ? `${current.rel}/${childName}` : childName
        if (stats.isDirectory()) {
          stack.push({ dir: childPath, rel: childRel })
        } else if (stats.isFile()) {
          zip.addFile(childPath, `${base}/${childRel}`)
        }
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath)
    output.on('error', reject)
    output.on('close', resolve)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    zip.end()
  })
}
