import path from 'node:path'
import AdmZip from 'adm-zip'
import type { SkillInstallTarget, SkillRepositoryAnalysis } from '../src/types'
import { downloadGitHubArchive } from './github-archive'
import { isSafeRepositoryName } from './profile'
import { parseSkillDocument } from './skill-format'

const MAX_FILES = 12_000
const MAX_SKILL_DOCUMENT_BYTES = 2 * 1024 * 1024
const MAX_CANDIDATES = 128
const CANDIDATE_FETCH_CONCURRENCY = 8
const GITHUB_API_ROOT = 'https://api.github.com'
/** 归档式检测的下载上限：Skill 仓库都是文档型仓库，64 MiB 足够且能挡住异常大包。 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

interface GitHubTreeEntry {
  path?: unknown
  type?: unknown
  size?: unknown
}

interface GitHubTreeResponse {
  truncated?: unknown
  tree?: unknown
}

function safeRevision(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

function safeArchivePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '')
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
  return normalized
}

/** 判定一个 .md 文件是否为「flat skill 候选」。导出供 raw 包扫描（pack-scan.ts）复用。 */
export function likelyFlatSkill(filePath: string): boolean {
  if (!filePath.toLowerCase().endsWith('.md') || /(?:^|\/)skill\.md$/i.test(filePath)) return false
  const lower = filePath.toLowerCase()
  if (/(?:^|\/)(?:readme|license|contributing|changelog)(?:\.[^/]*)?\.md$/.test(lower)) return false
  const segments = lower.split('/')
  return segments.length === 1
    || (segments.length <= 3 && ['skills', '.dsh', '.agents'].includes(segments[0]))
}

/** 同名 skill 候选去重：路径浅优先，其次 bundle 优先于 flat。导出供 raw 包扫描复用。 */
export function preferTarget(left: SkillInstallTarget, right: SkillInstallTarget): SkillInstallTarget {
  const leftDepth = left.sourcePath.split('/').length
  const rightDepth = right.sourcePath.split('/').length
  if (leftDepth !== rightDepth) return leftDepth < rightDepth ? left : right
  if (left.format !== right.format) return left.format === 'bundle' ? left : right
  return left.sourcePath.localeCompare(right.sourcePath) <= 0 ? left : right
}

function githubApiPath(repository: string, suffix: string): string {
  const [owner, name] = repository.split('/')
  return `${GITHUB_API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${suffix}`
}

function rawFileUrl(repository: string, revision: string, filePath: string): string {
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${encodedRepository}/${encodeURIComponent(revision)}/${encodedPath}`
}

async function fetchCommit(repository: string, branch: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(githubApiPath(repository, `commits/${encodeURIComponent(branch)}`), {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DSH-Launcher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 403) throw new Error('GitHub 请求额度暂时用尽，请稍后重试。')
  if (!response.ok) throw new Error(`读取 Skill 仓库版本失败（HTTP ${response.status}）。`)
  const body = await response.json() as { sha?: unknown }
  if (typeof body.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(body.sha)) {
    throw new Error('GitHub 没有返回有效的 Skill 仓库版本。')
  }
  return body.sha
}

async function fetchTree(repository: string, commit: string, fetchImpl: typeof fetch): Promise<GitHubTreeEntry[]> {
  const response = await fetchImpl(githubApiPath(repository, `git/trees/${commit}?recursive=1`), {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DSH-Launcher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 403) throw new Error('GitHub 请求额度暂时用尽，请稍后重试。')
  if (!response.ok) throw new Error(`读取 Skill 仓库目录失败（HTTP ${response.status}）。`)
  const body = await response.json() as GitHubTreeResponse
  if (body.truncated === true) {
    throw new Error('Skill 仓库目录过大，GitHub 未返回完整目录树，已停止检测。')
  }
  if (!Array.isArray(body.tree)) throw new Error('GitHub 返回的 Skill 仓库目录无效。')
  return body.tree.filter((entry): entry is GitHubTreeEntry => Boolean(entry && typeof entry === 'object'))
}

async function readCandidateDocument(
  repository: string,
  revision: string,
  sourcePath: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const response = await fetchImpl(rawFileUrl(repository, revision, sourcePath), {
    headers: { Accept: 'text/plain', 'User-Agent': 'DSH-Launcher' },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`读取 Skill 文件 ${sourcePath} 失败（HTTP ${response.status}）。`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_SKILL_DOCUMENT_BYTES) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) return null
  return Buffer.from(bytes).toString('utf8')
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= values.length) return
      results[index] = await mapper(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

export async function analyzeSkillRepository(
  repository: string,
  defaultBranch: string,
  fetchImpl?: typeof fetch,
): Promise<SkillRepositoryAnalysis> {
  if (!isSafeRepositoryName(repository) || !safeRevision(defaultBranch)) throw new Error('仓库名称或默认分支无效。')

  // 检测阶段只读取 Git Trees 元数据和候选 Markdown，避免下载整个仓库压缩包。
  const request = fetchImpl ?? fetch
  const commit = await fetchCommit(repository, defaultBranch, request)
  const tree = await fetchTree(repository, commit, request)
  if (tree.length > MAX_FILES) throw new Error('仓库目录文件数量超过安全限制，已停止 Skill 检测。')

  const repositoryFiles = tree.flatMap(entry => {
    if (entry.type !== 'blob' || typeof entry.path !== 'string') return []
    const sourcePath = safeArchivePath(entry.path)
    if (!sourcePath) throw new Error('GitHub 仓库目录包含不安全路径。')
    return [{ sourcePath, size: Number(entry.size) || 0 }]
  })

  const candidates = [
    ...repositoryFiles.filter(file => /(?:^|\/)SKILL\.md$/i.test(file.sourcePath)),
    ...repositoryFiles.filter(file => likelyFlatSkill(file.sourcePath)),
  ].filter((file, index, values) => values.findIndex(other => other.sourcePath === file.sourcePath) === index)
    .filter(file => file.size === 0 || file.size <= MAX_SKILL_DOCUMENT_BYTES)
    .slice(0, MAX_CANDIDATES)

  const discovered = new Map<string, SkillInstallTarget>()
  const documents = await mapWithConcurrency(candidates, CANDIDATE_FETCH_CONCURRENCY, async ({ sourcePath }) => ({
    sourcePath,
    content: await readCandidateDocument(repository, commit, sourcePath, request),
  }))
  for (const { sourcePath, content } of documents) {
    if (!content) continue
    const parsed = parseSkillDocument(content)
    if (!parsed) continue
    const format = path.posix.basename(sourcePath).toLowerCase() === 'skill.md' ? 'bundle' : 'flat'
    const target: SkillInstallTarget = {
      id: `${parsed.name}:${sourcePath}`,
      name: parsed.name,
      description: parsed.description,
      sourcePath,
      format,
      revision: defaultBranch,
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
    }
    const existing = discovered.get(parsed.name)
    discovered.set(parsed.name, existing ? preferTarget(existing, target) : target)
  }

  const targets = [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name))
  if (targets.length > 0) {
    return {
      repository,
      defaultBranch,
      installability: targets.length === 1 ? 'ready' : 'choice',
      summary: targets.length === 1
        ? `确认是 DSH Skill：${targets[0].name}`
        : `确认包含 ${targets.length} 个有效 DSH Skills。`,
      targets,
    }
  }
  return {
    repository,
    defaultBranch,
    installability: 'invalid',
    summary: '没有找到符合 DSH 规范的 SKILL.md 或单文件 Skill。',
    targets: [],
  }
}

/** 归档条目（已去掉顶层包裹目录）：path 为仓库内路径，content 为文本内容。 */
export interface SkillArchiveEntry {
  path: string
  content: string
}

/**
 * 纯函数：从仓库归档条目挑出 Skill targets，规则与 API 检测完全一致
 * （SKILL.md = bundle；likelyFlatSkill = flat；同名按 preferTarget 去重；按名称排序）。
 */
export function skillTargetsFromArchiveEntries(
  repository: string,
  revision: string,
  entries: SkillArchiveEntry[],
): SkillInstallTarget[] {
  const candidates = [
    ...entries.filter(entry => /(?:^|\/)SKILL\.md$/i.test(entry.path)),
    ...entries.filter(entry => likelyFlatSkill(entry.path)),
  ].filter((entry, index, values) => values.findIndex(other => other.path === entry.path) === index)
    .filter(entry => entry.content.length <= MAX_SKILL_DOCUMENT_BYTES)
    .slice(0, MAX_CANDIDATES)

  const discovered = new Map<string, SkillInstallTarget>()
  for (const entry of candidates) {
    let parsed: ReturnType<typeof parseSkillDocument> = null
    try {
      parsed = parseSkillDocument(entry.content)
    } catch {
      parsed = null
    }
    if (!parsed) continue
    const format = path.posix.basename(entry.path).toLowerCase() === 'skill.md' ? 'bundle' : 'flat'
    const target: SkillInstallTarget = {
      id: `${parsed.name}:${entry.path}`,
      name: parsed.name,
      description: parsed.description,
      sourcePath: entry.path,
      format,
      revision,
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
    }
    const existing = discovered.get(parsed.name)
    discovered.set(parsed.name, existing ? preferTarget(existing, target) : target)
  }
  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 归档式 Skill 检测：下载 codeload zip 后本地扫描，绕开 api.github.com。
 * 面向 C 端技能市场——无令牌时 REST API 会被限流（403），而 codeload 直连可用。
 * revision 使用分支名（与 installSkillFromRepository 的归档 ref 语义一致）。
 */
export async function analyzeSkillRepositoryFromArchive(
  repository: string,
  defaultBranch: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<SkillRepositoryAnalysis> {
  if (!isSafeRepositoryName(repository) || !safeRevision(defaultBranch)) throw new Error('仓库名称或默认分支无效。')

  const buffer = await downloadGitHubArchive(repository, defaultBranch, MAX_ARCHIVE_BYTES, onProgress)
  const archive = new AdmZip(buffer)
  const entries = archive.getEntries().filter(entry => !entry.isDirectory)
  if (entries.length > MAX_FILES) throw new Error('仓库文件数量超过安全限制，已停止 Skill 检测。')
  const firstFile = entries[0]
  const archiveRoot = firstFile ? firstFile.entryName.split('/')[0] : null
  if (!archiveRoot) throw new Error('仓库压缩包结构无效。')

  const scanned: SkillArchiveEntry[] = []
  for (const entry of entries) {
    const repositoryPath = safeArchivePath(entry.entryName)
    if (!repositoryPath) throw new Error('仓库压缩包包含不安全路径。')
    if (!repositoryPath.startsWith(`${archiveRoot}/`)) continue
    const relative = repositoryPath.slice(archiveRoot.length + 1)
    if (!relative) continue
    const isSkillFile = /(?:^|\/)SKILL\.md$/i.test(relative) || likelyFlatSkill(relative)
    if (!isSkillFile) continue
    if (entry.header.size > MAX_SKILL_DOCUMENT_BYTES) continue
    scanned.push({ path: relative, content: entry.getData().toString('utf8') })
  }

  const targets = skillTargetsFromArchiveEntries(repository, defaultBranch, scanned)
  if (targets.length > 0) {
    return {
      repository,
      defaultBranch,
      installability: targets.length === 1 ? 'ready' : 'choice',
      summary: targets.length === 1
        ? `确认是 DSH Skill：${targets[0].name}`
        : `确认包含 ${targets.length} 个有效 DSH Skills。`,
      targets,
    }
  }
  return {
    repository,
    defaultBranch,
    installability: 'invalid',
    summary: '没有找到符合 DSH 规范的 SKILL.md 或单文件 Skill。',
    targets: [],
  }
}
