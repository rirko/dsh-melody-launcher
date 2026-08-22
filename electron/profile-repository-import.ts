import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseGitHubImportUrl } from '../src/lib/github-import'
import type { PackManifest, PackPluginEntry, ProfileRepositoryImportPreview } from '../src/types'
import { parsePackManifest, serializePackManifest, packProfileName } from './pack-manifest'
import { extractPackBodiesFromPath, inspectPackZipFromPath } from './pack-zip'
import { readPluginReceipts, type PluginInstallReceipt } from './plugin-receipts'
import type { GitHubAuthService } from './github-auth'

type RepositoryFile = { bytes: Uint8Array; path: 'dsh-profile.yaml' | 'dsh-pack.yaml' }

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

async function repositoryDefaultBranch(auth: GitHubAuthService, repository: string, requested?: string): Promise<string> {
  if (requested) return requested
  const [owner, repo] = repository.split('/')
  const response = await auth.fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 404) throw new Error('无法读取 GitHub 仓库。公开仓库可匿名导入，私有仓库请先登录 GitHub。')
    throw new Error(`读取 GitHub 仓库信息失败（HTTP ${response.status}）。`)
  }
  const body = jsonObject(await response.json().catch(() => null))
  return typeof body?.default_branch === 'string' && body.default_branch ? body.default_branch : 'main'
}

async function readManifest(auth: GitHubAuthService, repository: string, branch: string): Promise<RepositoryFile> {
  for (const file of ['dsh-profile.yaml', 'dsh-pack.yaml'] as const) {
    try {
      return { bytes: await auth.readRepositoryFile(repository, file, branch), path: file }
    } catch {
      // Try the compatibility filename next.
    }
  }
  throw new Error('仓库中没有 dsh-profile.yaml 或兼容的 dsh-pack.yaml。')
}

async function manifestCommit(auth: GitHubAuthService, repository: string, branch: string, file: string): Promise<string | null> {
  const [owner, repo] = repository.split('/')
  const query = new URLSearchParams({ path: file, sha: branch, per_page: '1' })
  const response = await auth.fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${query.toString()}`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) return null
  const body = await response.json().catch(() => null)
  if (!Array.isArray(body)) return null
  const sha = jsonObject(body[0])?.sha
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
}

async function fileExists(auth: GitHubAuthService, repository: string, file: string, branch: string): Promise<boolean> {
  const [owner, repo] = repository.split('/')
  const response = await auth.fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file}?ref=${encodeURIComponent(branch)}`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  return response.ok
}

function sameTarget(a: PackPluginEntry, b: PluginInstallReceipt): boolean {
  return a.packageName === b.packageName
    && (a.version == null || b.version == null || a.version === b.version)
    && (!a.repository || a.repository.toLowerCase() === b.repository.toLowerCase())
}

function candidateEntry(receipt: PluginInstallReceipt): PackPluginEntry {
  return {
    packageName: receipt.packageName,
    source: receipt.source === 'npm' ? 'npm' : receipt.source === 'github' ? 'github' : 'local',
    ...(receipt.repository && receipt.source !== 'npm' && receipt.source !== 'local-directory' ? { repository: receipt.repository } : {}),
    ...(receipt.defaultBranch ? { defaultBranch: receipt.defaultBranch } : {}),
    ...(receipt.targetId ? { targetId: receipt.targetId } : {}),
    ...(receipt.subdirectory ? { subdirectory: receipt.subdirectory } : {}),
    ...(receipt.commit ? { commit: receipt.commit } : {}),
    ...(receipt.version ? { version: receipt.version } : {}),
  }
}

export interface ProfileRepositoryServiceOptions {
  githubAuth: GitHubAuthService
  pluginReceiptsPath: string
}

export async function loadProfileRepositoryManifest(auth: GitHubAuthService, url: string): Promise<{ repository: string; branch: string; file: RepositoryFile; manifest: PackManifest; commit: string | null }> {
  const parsed = parseGitHubImportUrl(url)
  const branch = await repositoryDefaultBranch(auth, parsed.fullName, parsed.defaultBranch)
  const file = await readManifest(auth, parsed.fullName, branch)
  const manifest = parsePackManifest(new TextDecoder().decode(file.bytes), { requireDshVersion: true })
  const commit = await manifestCommit(auth, parsed.fullName, branch, file.path)
  return { repository: parsed.fullName, branch, file, manifest, commit }
}

/** Contents API refuses binary files above its small response limit. Use the
 * raw endpoint as a fallback only after the user explicitly chose full mode. */
export async function readProfileRepositoryArchive(auth: GitHubAuthService, repository: string, branch: string): Promise<Uint8Array> {
  try {
    return await auth.readRepositoryFile(repository, 'profile.zip', branch)
  } catch {
    const [owner, repo] = repository.split('/')
    const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')
    const response = await auth.fetch(`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodedBranch}/profile.zip`)
    if (!response.ok) throw new Error(`读取 GitHub 完整包失败（HTTP ${response.status}）。`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

export async function analyzeProfileRepository(options: ProfileRepositoryServiceOptions, url: string): Promise<ProfileRepositoryImportPreview> {
  const loaded = await loadProfileRepositoryManifest(options.githubAuth, url)
  const receipts = await readPluginReceipts(options.pluginReceiptsPath)
  const plugins = loaded.manifest.plugins.map((entry, order) => {
    const candidates = receipts.filter(receipt => sameTarget(entry, receipt)).map(candidateEntry)
    const distinct = new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate]))
    const list = [...distinct.values()]
    const declared = (entry.source === 'npm' && Boolean(entry.version)) || (entry.source === 'github' && Boolean(entry.repository) && Boolean(entry.commit))
    const localMatch = list.length === 1 && list[0].source === 'local'
    const pinnedCandidate = list.length === 1 && ((list[0].source === 'npm' && Boolean(list[0].version)) || (Boolean(list[0].repository && list[0].commit)))
    const match = declared ? 'declared' : localMatch || pinnedCandidate ? 'matched' : list.length > 1 ? 'ambiguous' : 'missing'
    return {
      packageName: entry.packageName,
      enabled: entry.enabled !== false,
      order,
      source: entry.source ?? (entry.repository ? 'github' : 'npm'),
      repository: entry.repository ?? null,
      version: entry.version ?? null,
      commit: entry.commit ?? null,
      match,
      candidates: list,
      ...(match === 'missing' ? { reason: entry.source === 'github' && entry.repository && !entry.commit ? 'GitHub 来源缺少固定 commit。' : entry.source === 'npm' && !entry.version ? 'npm 来源缺少精确版本。' : '清单缺少来源，且本地没有唯一匹配记录。' } : match === 'ambiguous' ? { reason: '存在多个来源候选，需要选择具体来源。' } : {}),
    } satisfies ProfileRepositoryImportPreview['plugins'][number]
  })
  const blockers = plugins.filter(item => item.match === 'missing' || item.match === 'ambiguous').map(item => `${item.packageName}：${item.reason}`)
  const hasFullPackage = await fileExists(options.githubAuth, loaded.repository, 'profile.zip', loaded.branch)
  return {
    repository: loaded.repository,
    branch: loaded.branch,
    commit: loaded.commit,
    manifestPath: loaded.file.path,
    profileName: packProfileName(loaded.manifest.name),
    description: loaded.manifest.description,
    version: loaded.manifest.version,
    dshVersion: loaded.manifest.dshVersion!,
    plugins,
    hasFullPackage,
    fullPackagePluginBodies: [],
    differences: [],
    blockers,
  }
}

export function applyReceiptMatches(manifest: PackManifest, receipts: PluginInstallReceipt[]): PackManifest {
  return {
    ...manifest,
    plugins: manifest.plugins.map(entry => {
      if (entry.source !== 'local' && (entry.source === 'npm' || entry.repository)) return entry
      const matches = receipts.filter(receipt => sameTarget(entry, receipt))
      if (matches.length !== 1) return entry
      const candidate = candidateEntry(matches[0])
      return { ...entry, ...candidate, enabled: entry.enabled }
    }),
  }
}

export function applySelectedMatches(manifest: PackManifest, selections: Record<string, PackPluginEntry> | undefined, receipts: PluginInstallReceipt[]): PackManifest {
  if (!selections) return manifest
  return {
    ...manifest,
    plugins: manifest.plugins.map(entry => {
      const selected = selections[entry.packageName]
      if (!selected) return entry
      if (selected.packageName !== entry.packageName) throw new Error(`插件来源选择与清单不一致：${entry.packageName}`)
      const trusted = receipts.some(receipt => receipt.packageName === entry.packageName
        && (selected.repository ?? '') === receipt.repository
        && (selected.commit ?? '') === receipt.commit
        && (selected.version ?? null) === (receipt.version ?? null))
      if (!trusted) throw new Error(`插件来源候选未经本地安装收据验证：${entry.packageName}`)
      return { ...entry, ...selected, enabled: entry.enabled }
    }),
  }
}

export function manifestText(manifest: PackManifest): string {
  return serializePackManifest(manifest)
}

export async function validateFullArchive(filePath: string, manifest: PackManifest): Promise<string[]> {
  const inspection = await inspectPackZipFromPath(filePath)
  const archiveManifest = inspection.manifest
  if (archiveManifest.name !== manifest.name || archiveManifest.version !== manifest.version || archiveManifest.dshVersion !== manifest.dshVersion) {
    throw new Error('完整包内清单与仓库 dsh-profile.yaml 不一致。')
  }
  const expected = manifest.plugins.map(item => item.packageName)
  const archiveNames = archiveManifest.plugins.map(item => item.packageName)
  if (expected.length !== archiveNames.length || expected.some(name => !archiveNames.includes(name))) {
    throw new Error('完整包内插件清单与仓库清单不一致。')
  }
  const missing = expected.filter(name => !inspection.bodyPackageNames.includes(name))
  if (missing.length > 0) throw new Error(`完整安装缺少插件本体：${missing.join('、')}`)
  const staging = await mkdtemp(path.join(path.dirname(filePath), 'full-profile-check-'))
  try {
    const bodies = await extractPackBodiesFromPath(filePath, staging, undefined, new Set(expected))
    for (const entry of manifest.plugins) {
      const bodyDir = bodies.get(entry.packageName)
      if (!bodyDir) continue
      let body: { name?: unknown; version?: unknown }
      try {
        body = JSON.parse(await readFile(path.join(bodyDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
      } catch {
        throw new Error(`完整安装插件本体缺少 package.json：${entry.packageName}`)
      }
      if (body.name !== entry.packageName) throw new Error(`完整安装插件包名不一致：清单 ${entry.packageName}，本体 ${String(body.name ?? '未知')}`)
      if (entry.version && body.version !== entry.version) throw new Error(`完整安装插件版本不一致：${entry.packageName} 要求 ${entry.version}，本体 ${String(body.version ?? '未知')}`)
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  return inspection.bodyPackageNames
}
