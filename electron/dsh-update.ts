import { DSH_PACKAGE_NAME, DSH_REPOSITORY } from '../src/constants'
import type { DshInstallationStatus, DshUpdateStatus } from '../src/types'

const GITHUB_API_ROOT = 'https://api.github.com'
const DSH_PACKAGE_PATHS = ['apps/cli/package.json', 'package.json'] as const
const DSH_VERSION_PACKAGE_NAMES = new Set([DSH_PACKAGE_NAME, '@deepseek-ai/dsh-root'])
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}

interface GitHubRepositoryResponse {
  default_branch?: unknown
}

interface GitHubContentResponse {
  content?: unknown
  encoding?: unknown
  download_url?: unknown
}

interface PackageManifest {
  name?: unknown
  version?: unknown
}

function repositoryApiUrl(path: string): string {
  return `${GITHUB_API_ROOT}/repos/${DSH_REPOSITORY}/${path}`
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

interface ParsedVersion {
  core: [number, number, number]
  prerelease: string[]
}

function parseVersion(version: string): ParsedVersion | null {
  const match = normalizeVersion(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** Returns a positive number when remote is newer than local. */
export function compareVersions(local: string, remote: string): number {
  const left = parseVersion(local)
  const right = parseVersion(remote)
  if (!left || !right) return normalizeVersion(remote).localeCompare(normalizeVersion(local))

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return right.core[index] - left.core[index]
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? -1 : 1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const localPart = left.prerelease[index]
    const remotePart = right.prerelease[index]
    if (localPart === undefined || remotePart === undefined) return localPart === undefined ? 1 : -1
    if (localPart === remotePart) continue
    const localNumber = /^\d+$/.test(localPart) ? Number(localPart) : null
    const remoteNumber = /^\d+$/.test(remotePart) ? Number(remotePart) : null
    if (localNumber !== null && remoteNumber !== null) return remoteNumber - localNumber
    if (localNumber !== null) return -1
    if (remoteNumber !== null) return 1
    return remotePart.localeCompare(localPart)
  }
  return 0
}

function checkedAt(): string {
  return new Date().toISOString()
}

function status(
  state: DshUpdateStatus['state'],
  localVersion: string | null,
  remoteVersion: string | null,
  message: string,
): DshUpdateStatus {
  return {
    state,
    localVersion,
    remoteVersion,
    repository: DSH_REPOSITORY,
    checkedAt: checkedAt(),
    message,
  }
}

async function requestJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { headers: GITHUB_HEADERS })
  if (!response.ok) {
    if (response.status === 403) throw new Error('GitHub 请求额度暂时用尽。')
    throw new Error(`GitHub 返回 ${response.status}。`)
  }
  return response.json() as Promise<T>
}

function decodeContent(content: string): string {
  return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8')
}

/**
 * npm registry 的 dist-tag/latest。DSH 本体经 npm 分发，registry 才是版本真值；
 * GitHub contents 接口在仓库不可达/镜像限流时会 404，只作最后回退。
 */
async function readRemoteDshVersionFromRegistry(fetchImpl: typeof fetch, registry: string): Promise<string> {
  const base = registry.replace(/\/+$/, '')
  const response = await fetchImpl(`${base}/${DSH_PACKAGE_NAME.replace('/', '%2F')}/latest`, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`npm 镜像返回 ${response.status}。`)
  const body = await response.json() as { version?: unknown }
  if (typeof body?.version !== 'string' || !body.version.trim()) throw new Error('npm 镜像没有返回可用的版本号。')
  return body.version.trim()
}

async function readRemoteDshVersionFromGitHub(fetchImpl: typeof fetch): Promise<string> {
  const repository = await requestJson<GitHubRepositoryResponse>(
    repositoryApiUrl(''),
    fetchImpl,
  )
  const branch = typeof repository.default_branch === 'string' && repository.default_branch.length > 0
    ? repository.default_branch
    : 'master'

  let lastError: unknown = null
  for (const packagePath of DSH_PACKAGE_PATHS) {
    const endpoint = repositoryApiUrl(`contents/${packagePath}?ref=${encodeURIComponent(branch)}`)
    try {
      const content = await requestJson<GitHubContentResponse>(endpoint, fetchImpl)
      if (typeof content.content !== 'string' || content.encoding !== 'base64') {
        throw new Error('GitHub 没有返回可读取的 package.json。')
      }
      const manifest = JSON.parse(decodeContent(content.content)) as PackageManifest
      if (typeof manifest.name !== 'string' || !DSH_VERSION_PACKAGE_NAMES.has(manifest.name)
        || typeof manifest.version !== 'string' || !manifest.version.trim()) {
        throw new Error(`仓库文件不是 DSH 版本清单。`)
      }
      return manifest.version.trim()
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('未找到 DSH 版本清单。')
}

/** 镜像优先逐个试 registry，全部失败才回退 GitHub；两边都失败时抛最后一次的错误。 */
async function readRemoteDshVersion(fetchImpl: typeof fetch, registryCandidates: string[]): Promise<string> {
  const seen = new Set<string>()
  let lastError: unknown = null
  for (const candidate of registryCandidates) {
    const registry = candidate.trim().replace(/\/+$/, '')
    if (!registry || seen.has(registry)) continue
    seen.add(registry)
    try {
      return await readRemoteDshVersionFromRegistry(fetchImpl, registry)
    } catch (error) {
      lastError = error
    }
  }
  try {
    return await readRemoteDshVersionFromGitHub(fetchImpl)
  } catch (error) {
    throw error instanceof Error ? error : lastError
  }
}

/**
 * Compare the installed DSH package with the published npm version
 * (mirror-first, official registry, GitHub contents as last resort).
 * A failed check is reported as an error state and never blocks launcher startup.
 */
export async function checkDshUpdate(
  installation: DshInstallationStatus,
  fetchImpl: typeof fetch = fetch,
  registryCandidates: string[] = [],
): Promise<DshUpdateStatus> {
  const localVersion = installation.version?.trim() || null
  if (!installation.installed || !localVersion) {
    return status('not-installed', localVersion, null, '尚未安装 DSH。')
  }

  try {
    const remoteVersion = await readRemoteDshVersion(fetchImpl, registryCandidates)
    const newer = compareVersions(localVersion, remoteVersion) > 0
    return newer
      ? status('update-available', localVersion, remoteVersion, `发现 DSH 新版本 ${remoteVersion}。`)
      : status('up-to-date', localVersion, remoteVersion,
        normalizeVersion(remoteVersion) === normalizeVersion(localVersion)
          ? '当前 DSH 已是最新版本。'
          : `本地 DSH ${localVersion} 高于仓库版本 ${remoteVersion}。`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return status('error', localVersion, null, `暂时无法检查 DSH 更新：${detail}`)
  }
}

export { normalizeVersion, readRemoteDshVersion }
