import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'
import { githubCandidateUrls } from './github-archive'
import { downloadReleaseAsset } from './release-download'
import type { OfficialPackDownloadProgress, OfficialPackRelease, PackInstallResult } from '../src/types'

/**
 * 官方默认整合包：zip 作为 LAUNCHER_RELEASE_REPOSITORY 的 GitHub Release 资产发布，
 * 资产名 `official-pack-v<版本>.zip`，版本号 = 适配的 DSH 版本 + 序号（如 0.1.5-rc.2.1），
 * 用户看版本号就知道这个包适配哪个 DSH。一次挂多个版本（不同 Release 各一份资产），
 * 整合包页把它们列成「官方整合包」堆叠，最新版即推荐版本。
 *
 * 本模块含版本目录（列出 Release 上的官方包资产）与获取流程（换源下载 →
 * 导入 → 盖官方版本戳 → 外观回原生）。导入复用启动器自己的
 * packManager.importPack——快照格式由 pack-snapshot.ts 的导入分支消化。
 */

const GITHUB_API_ROOT = 'https://api.github.com'
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
/** 列 Release 时的单页条数（GitHub 上限 100）。 */
const RELEASE_LOOKUP_LIMIT = 100

const OFFICIAL_PACK_ASSET_RE = /^official-pack-v(.+)\.zip$/
/** 构建脚本写进 Release 正文的三行元信息，用于回显「这个包是用什么建的」。 */
const RELEASE_BODY_DSH_RE = /(?:^|\n)\s*dsh\s*[:：]\s*(\S+)/i

export function officialPackAssetName(version: string): string {
  return `official-pack-v${version}.zip`
}

export function officialPackDisplayName(version: string): string {
  return `官方默认整合包 ${version}`
}

/**
 * 从官方包版本号里取回「适配的 DSH 版本」：`0.1.5-rc.2.1` → `0.1.5-rc.2`。
 * 只有「去掉尾段序号后仍是一个合法版本号」才认——那说明资产名按新命名方案编码了 DSH 版本。
 * 旧命名（如 `official-pack-v0.1.1.zip`，包版本 = 启动器版本，与 DSH 无关）解不出来，返回 null：
 * 界面显示「适配 DSH 未标注」也比拿包版本号冒充强（那是错的）。
 */
export function dshVersionOfOfficialPack(version: string): string | null {
  const trimmed = version.trim()
  const cut = trimmed.lastIndexOf('.')
  if (cut <= 0) return null
  const stripped = trimmed.slice(0, cut)
  return validVersion(stripped) ? stripped : null
}

export function validVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())
}

/** 版本号降序比较：数字段按数值、无预发布版 > 有预发布版、预发布段逐标识符比较。 */
export function compareOfficialPackVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const trimmed = value.trim().replace(/^v/i, '')
    const [core, prerelease] = trimmed.split('-', 2)
    const numbers = core.split('.').map(segment => Number(segment) || 0)
    return { numbers, prerelease: prerelease ? prerelease.split('.') : [] }
  }
  const a = parse(left)
  const b = parse(right)
  const width = Math.max(a.numbers.length, b.numbers.length)
  for (let index = 0; index < width; index += 1) {
    const diff = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    const leftNumber = Number(leftPart)
    const rightNumber = Number(rightPart)
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber
      continue
    }
    if (Number.isFinite(leftNumber)) return -1
    if (Number.isFinite(rightNumber)) return 1
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return a.prerelease.length - b.prerelease.length
}

/** 从 Release 正文里读构建时记录的 DSH 版本（新方案的包都会写这行）。 */
function dshVersionFromNotes(notes: string | null): string | null {
  if (!notes) return null
  const match = RELEASE_BODY_DSH_RE.exec(notes)
  const value = match?.[1]?.trim()
  return value && validVersion(value) ? value : null
}

/** 只需要网络能力的窄依赖：列版本不需要导入管线。 */
export interface OfficialPackListDeps {
  fetchImpl: typeof fetch
  /** 用户配置的 GitHub 镜像（缺省时直连 + 内置公共镜像）。 */
  mirror?: string
}

interface RawRelease {
  tag_name?: unknown
  body?: unknown
  published_at?: unknown
  draft?: unknown
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>
}

/**
 * 列出所有 Release 上的官方包资产，按版本降序（第一项即推荐版本）。
 * 网络/限流失败时抛错，由调用方决定怎么提示。
 */
export async function listOfficialPackVersions(deps: OfficialPackListDeps): Promise<OfficialPackRelease[]> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases?per_page=${RELEASE_LOOKUP_LIMIT}`
  let releases: RawRelease[] | null = null
  let lastError = '无法访问 GitHub Release（网络或限流）。'
  for (const url of githubCandidateUrls(endpoint, deps.mirror)) {
    try {
      const response = await deps.fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000) })
      if (response.status === 403) {
        lastError = 'GitHub 请求额度暂时用尽，稍后再试。'
        continue
      }
      if (!response.ok) {
        lastError = `GitHub 返回 ${response.status}。`
        continue
      }
      const payload = await response.json() as unknown
      if (!Array.isArray(payload)) {
        lastError = 'GitHub 返回了非预期的数据。'
        continue
      }
      releases = payload as RawRelease[]
      break
    } catch {
      // 这个候选不可达，换下一个。
    }
  }
  if (!releases) throw new Error(lastError)

  const found: OfficialPackRelease[] = []
  const seen = new Set<string>()
  for (const release of releases) {
    if (!release || release.draft === true) continue
    const releaseTag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const notes = typeof release.body === 'string' ? release.body : null
    const publishedAt = typeof release.published_at === 'string' ? release.published_at : null
    for (const asset of Array.isArray(release.assets) ? release.assets : []) {
      const assetName = typeof asset?.name === 'string' ? asset.name : ''
      const match = OFFICIAL_PACK_ASSET_RE.exec(assetName)
      const version = match?.[1]?.trim()
      if (!version || typeof asset.browser_download_url !== 'string' || seen.has(version)) continue
      seen.add(version)
      found.push({
        version,
        // 正文的构建元信息 > 资产名里的编码；两者都没有就是真的不知道（旧命名的历史资产），
        // 留给渲染层显示「未标注」。
        dshVersion: dshVersionFromNotes(notes) ?? dshVersionOfOfficialPack(version),
        assetName,
        assetUrl: String(asset.browser_download_url),
        size: Number(asset.size) || 0,
        releaseTag,
        publishedAt,
      })
    }
  }
  return found.sort((left, right) => -compareOfficialPackVersions(left.version, right.version))
}


// ——————————————————————————————————————————————
// 获取流程：换源下载 → 导入 → 盖版本戳 → 外观回原生
// ——————————————————————————————————————————————

/** 官方包快照 zip 上限（含依赖本体，数百 MB 量级）。 */
export const OFFICIAL_PACK_MAX_BYTES = 2 * 1024 * 1024 * 1024

export interface OfficialPackDownloadTuning {
  /** 等首个字节的上限：超时说明这条链路基本不通。 */
  firstByteMs: number
  /** 中途多久没有新数据判定为断流。 */
  stallMs: number
  /** 速度观测窗口：窗口内的平均速度低于下限就换源。 */
  probeMs: number
  /** 速度下限（字节/秒）。 */
  floorBytesPerSecond: number
}

/** 默认值面向国内家宽调过：直连 8 秒不见字节、或 5 秒内均速不到 300KB/s 就换镜像。 */
export const OFFICIAL_PACK_DOWNLOAD_TUNING: OfficialPackDownloadTuning = {
  firstByteMs: 8_000,
  stallMs: 20_000,
  probeMs: 5_000,
  floorBytesPerSecond: 300 * 1024,
}

/** 给界面看的源名字：镜像显示域名，直连显示「GitHub 直连」。 */
function sourceLabel(candidateUrl: string, assetUrl: string): string {
  if (candidateUrl === assetUrl) return 'GitHub 直连'
  try {
    return new URL(candidateUrl).host
  } catch {
    return '镜像'
  }
}

/** 换源时抛出：带上实测平均速度，第二轮据此按快慢排序。 */
class CandidateRejected extends Error {
  constructor(message: string, readonly speed: number) {
    super(message)
    this.name = 'CandidateRejected'
  }
}

export interface OfficialPackDownloadOptions {
  fetchImpl: typeof fetch
  maxBytes: number
  mirror?: string
  onProgress?: (progress: OfficialPackDownloadProgress) => void
  tuning?: Partial<OfficialPackDownloadTuning>
}

export interface OfficialPackDownloadResult {
  buffer: Buffer
  /** 实际拿下这份包的源（给界面回显「经 xxx 下载」）。 */
  source: string
}

/**
 * 百 MB 级下载走三重守卫换源：等首字节超时、断流超时、速度下限。
 * 全部候选都不达标时，第二轮按实测速度从快到慢再试一次——那一轮只看断流，
 * 不再因慢中断，否则「全网都慢」的线路会一直换源、永远下不完。
 */
export async function downloadOfficialPackAsset(
  assetUrl: string,
  options: OfficialPackDownloadOptions,
): Promise<OfficialPackDownloadResult> {
  const tuning = { ...OFFICIAL_PACK_DOWNLOAD_TUNING, ...options.tuning }
  const candidates = githubCandidateUrls(assetUrl, options.mirror)
  /** 被测速拒绝过的源 → 实测均速（第二轮排序用）。 */
  const measured = new Map<string, number>()
  let lastError: unknown = null
  for (const enforceFloor of [true, false]) {
    const ordered = enforceFloor
      ? candidates
      : [...measured.entries()].sort((left, right) => right[1] - left[1]).map(([url]) => url)
    for (const candidateUrl of ordered) {
      const source = sourceLabel(candidateUrl, assetUrl)
      try {
        const buffer = await downloadCandidate(candidateUrl, source, options, tuning, enforceFloor)
        return { buffer, source }
      } catch (error) {
        lastError = error
        if (error instanceof CandidateRejected) measured.set(candidateUrl, error.speed)
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '未知原因'
  throw new Error(`官方整合包下载失败：所有下载源都不可用（最后一个：${detail}）。`)
}

/** 从单个候选源取整包；被守卫打断时抛 CandidateRejected（含均速）。 */
async function downloadCandidate(
  candidateUrl: string,
  source: string,
  options: OfficialPackDownloadOptions,
  tuning: OfficialPackDownloadTuning,
  enforceFloor: boolean,
): Promise<Buffer> {
  const controller = new AbortController()
  const startedAt = Date.now()
  let received = 0
  let lastDataAt = startedAt
  let firstByteAt: number | null = null
  let probeStartedAt = startedAt
  let probeStartBytes = 0
  let rejection: CandidateRejected | null = null

  const reject = (message: string): void => {
    if (rejection) return
    const seconds = Math.max(1, Date.now() - startedAt) / 1000
    rejection = new CandidateRejected(message, received / seconds)
    controller.abort()
  }

  /** 守卫巡检间隔：跟着最紧的那个阈值走（生产里 250ms，测试把阈值调小后也随之变快）。 */
  const tickMs = Math.max(25, Math.min(250, Math.floor(Math.min(tuning.firstByteMs, tuning.stallMs, tuning.probeMs) / 4)))
  const watchdog = setInterval(() => {
    const now = Date.now()
    if (firstByteAt === null) {
      if (now - startedAt >= tuning.firstByteMs) reject(`${source} 无响应（等首字节超时）`)
      return
    }
    if (now - lastDataAt >= tuning.stallMs) {
      reject(`${source} 下载中断`)
      return
    }
    if (!enforceFloor) return
    const windowMs = now - probeStartedAt
    if (windowMs < tuning.probeMs) return
    const speed = ((received - probeStartBytes) * 1000) / windowMs
    if (speed >= tuning.floorBytesPerSecond) return
    reject(`${source} 速度只有 ${Math.round(speed / 1024)} KB/s`)
  }, tickMs)

  try {
    return await downloadReleaseAsset(
      candidateUrl,
      options.maxBytes,
      (chunkReceived, total) => {
        const now = Date.now()
        received = chunkReceived
        lastDataAt = now
        if (firstByteAt === null) {
          firstByteAt = now
          probeStartedAt = now
          probeStartBytes = chunkReceived
        }
        options.onProgress?.({ received: chunkReceived, total, source })
      },
      options.fetchImpl,
      controller.signal,
    )
  } catch (error) {
    if (rejection) throw rejection
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearInterval(watchdog)
  }
}

export type OfficialPackOutcome = 'present' | 'imported' | 'no-asset' | 'failed'

export interface OfficialPackResult {
  outcome: OfficialPackOutcome
  result?: PackInstallResult
  message?: string
  /** 实际拿下这份包的源（镜像域名 / GitHub 直连），成功时用于日志与界面回显。 */
  source?: string
}

interface ReleaseAssetRef {
  url: string
  size: number
}

/** 把整合包家的外观钉回「DSH 原生无皮肤」：与序曲的 stock-appearance 等效的最小实现。 */
async function applyStockAppearance(home: string): Promise<void> {
  const target = path.join(home, 'skin-center-active.json')
  await mkdir(path.dirname(target), { recursive: true })
  // active: null + initialized: true 双条件堵住 skin-center 的 seed 逻辑：
  // 既保证导入后是原生外观，也不会在之后反复覆盖用户手动选的皮肤。
  await writeFile(target, JSON.stringify({ active: null, initialized: true }, null, 2) + '\n', 'utf8')
}

export interface OfficialPackService {
  listVersions(): Promise<OfficialPackRelease[]>
  /** 确保指定版本的官方整合包存在；缺失时下载导入并盖版本戳。永不 throw。 */
  install(version: string): Promise<OfficialPackResult>
}

export interface OfficialPackServiceDeps {
  fetchImpl: typeof fetch
  /** 复用整合包导入管线（快照 zip → 统一 Profile → 注册）。 */
  importPack: (filePath: string, items: undefined, options: { name: string }) => Promise<PackInstallResult>
  /** 导入后读家目录路径（外观回原生用）。 */
  homeForPack: (packId: string) => Promise<string | null>
  /** 把官方包版本戳写进包记录的权威存储（统一 Profile 模式 = Profile 元数据）。 */
  stampOfficialVersion: (packId: string, version: string) => Promise<void>
  /** 该官方包版本是否已经导入过（权威存储 = Profile 元数据）。 */
  isOfficialVersionImported: (version: string) => Promise<boolean>
  /** zip 的临时落盘目录（导入完成后删除）。 */
  downloadDir: string
  /** 下载进度（含字节数、总量、速度来源），界面据此画进度条。 */
  onProgress?: (progress: OfficialPackDownloadProgress) => void
  mirror?: string
}

/** 老路径兜底：直接查 `releases/latest` 里的同名资产（列表读不到时保证最新版装得上）。 */
async function resolveOfficialPackAssetFromLatest(
  deps: OfficialPackServiceDeps,
  version: string,
): Promise<{ asset: ReleaseAssetRef | null; message?: string }> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
  const assetName = officialPackAssetName(version)
  for (const url of githubCandidateUrls(endpoint, deps.mirror)) {
    try {
      const response = await deps.fetchImpl(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(12_000) })
      if (!response.ok) continue
      const release = await response.json() as { assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }> }
      const assets = Array.isArray(release.assets) ? release.assets : []
      const found = assets.find(entry => entry?.name === assetName && typeof entry.browser_download_url === 'string')
      if (!found) return { asset: null, message: `最新 Release 中没有 ${assetName}。` }
      return { asset: { url: String(found.browser_download_url), size: Number(found.size) || 0 } }
    } catch {
      // 这个候选不可达，换下一个。
    }
  }
  return { asset: null, message: '无法访问 GitHub Release（网络或限流）。' }
}

/** 下载 → 导入 → 盖官方版本戳 → 把外观钉回原生。 */
async function downloadAndImport(
  deps: OfficialPackServiceDeps,
  version: string,
  asset: ReleaseAssetRef,
): Promise<OfficialPackResult> {
  let buffer: Buffer
  let source: string
  try {
    const download = await downloadOfficialPackAsset(asset.url, {
      fetchImpl: deps.fetchImpl,
      maxBytes: OFFICIAL_PACK_MAX_BYTES,
      mirror: deps.mirror,
      onProgress: deps.onProgress,
    })
    buffer = download.buffer
    source = download.source
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }

  await mkdir(deps.downloadDir, { recursive: true })
  const zipPath = path.join(deps.downloadDir, officialPackAssetName(version))
  await writeFile(zipPath, buffer)
  try {
    const result = await deps.importPack(zipPath, undefined, { name: officialPackDisplayName(version) })
    await deps.stampOfficialVersion(result.id, version)
    const home = await deps.homeForPack(result.id)
    if (home) await applyStockAppearance(home)
    return { outcome: 'imported', result, source }
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error), source }
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined)
  }
}

async function ensureVersionFrom(
  deps: OfficialPackServiceDeps,
  version: string,
  releases: OfficialPackRelease[] | null,
): Promise<OfficialPackResult> {
  try {
    const listed = releases?.find(item => item.version === version)
    if (listed) {
      return await downloadAndImport(deps, version, { url: listed.assetUrl, size: listed.size })
    }
    const resolved = await resolveOfficialPackAssetFromLatest(deps, version)
    if (!resolved.asset) {
      return { outcome: resolved.message?.includes('没有') ? 'no-asset' : 'failed', message: resolved.message }
    }
    return await downloadAndImport(deps, version, resolved.asset)
  } catch (error) {
    return { outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** 只需要网络能力的窄依赖：列版本不需要导入管线。 */
export function createOfficialPackService(deps: OfficialPackServiceDeps): OfficialPackService {
  async function tryListVersions(): Promise<OfficialPackRelease[] | null> {
    try {
      return await listOfficialPackVersions(deps)
    } catch {
      return null
    }
  }
  return {
    listVersions: () => listOfficialPackVersions(deps),
    /**
     * 确保指定版本的官方整合包存在；缺失时下载导入并盖版本戳。永不 throw。
     * 「已导入」的短路在联网之前——本机已有这个版本就一次网络请求都不发。
     */
    async install(version: string): Promise<OfficialPackResult> {
      const target = version.trim()
      if (!target) return { outcome: 'failed', message: '官方整合包版本号为空。' }
      try {
        if (await deps.isOfficialVersionImported(target)) return { outcome: 'present' }
      } catch {
        // 存在性探测失败不阻断：继续走下载，导入端会自己兜底。
      }
      return ensureVersionFrom(deps, target, await tryListVersions())
    },
  }
}
