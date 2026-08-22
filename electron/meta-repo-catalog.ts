import type {
  CatalogRepositoryAnalysis,
  PluginInstallTarget,
  PresetInstallTarget,
  PresetRepositoryAnalysis,
  ReleaseAnalysis,
  RepositoryAnalysis,
  SkillInstallTarget,
  SkillRepositoryAnalysis,
} from '../src/types'
import { parseGitModules, resolveSubmodulePins, submoduleFullName } from './ai-repository-source'
import { isSafeRepositoryName } from './profile'
import { isSkillName } from './skill-format'

const GITHUB_API_HEADERS = { 'User-Agent': 'DSH-Launcher', 'Accept': 'application/vnd.github+json' } as const
const RELEASE_LOOKUP_LIMIT = 10

/**
 * 确定性 meta-repo（git submodules 聚合仓库）分析。
 * 不调用大模型：解析 .gitmodules 拿到子模块仓库，用 gitlink 精确 commit 钉住版本，
 * 逐个子模块跑常规 plugin / skill 分析并聚合出可安装组件。
 * 复用 ai-repository-source.ts 里已为「AI 尝试」实现的子模块基础设施。
 */

function safeBranch(value: string): boolean {
  return value.length > 0
    && value.length <= 160
    && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value)
}

function rawFileUrl(repository: string, revision: string, filePath: string): string {
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/')
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${repositoryPath}/${revision}/${encodedPath}`
}

/** 读取 meta-repo 根部的 .gitmodules；404 / 网络失败返回 null（视为非聚合仓库）。 */
async function readGitModules(
  repository: string,
  defaultBranch: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(rawFileUrl(repository, defaultBranch, '.gitmodules'), {
      headers: { 'User-Agent': 'DSH-Launcher' },
    })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

/**
 * 子模块是 github 源插件时，查一次 releases 找官方预编译 tgz 资产。
 * 源码 pin 不一定带构建产物（如 dsh-super-injector 的 lib/ 不在仓库里），
 * Release tgz 是官方安装产物。返回 null 表示该仓库没有可用 release。
 */
async function resolveReleaseTarball(
  repository: string,
  fetchImpl: typeof fetch,
): Promise<{ tarballUrl: string; version: string } | null> {
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/')
  const response = await fetchImpl(`https://api.github.com/repos/${repositoryPath}/releases?per_page=${RELEASE_LOOKUP_LIMIT}`, {
    headers: GITHUB_API_HEADERS,
  })
  if (!response.ok) return null
  const releases: unknown = await response.json().catch(() => null)
  if (!Array.isArray(releases)) return null
  for (const release of releases) {
    if (!release || typeof release !== 'object') continue
    const record = release as { draft?: unknown; prerelease?: unknown; tag_name?: unknown; assets?: unknown }
    if (record.draft === true || record.prerelease === true) continue
    if (!Array.isArray(record.assets)) continue
    const tgz = record.assets.find((asset): asset is { browser_download_url: string } => {
      if (!asset || typeof asset !== 'object') return false
      const url = (asset as { browser_download_url?: unknown }).browser_download_url
      return typeof url === 'string' && /\.(tgz|tar\.gz)$/i.test(url)
    })
    if (!tgz) continue
    const version = typeof record.tag_name === 'string' ? record.tag_name.replace(/^v/i, '') : ''
    if (!version) continue
    return { tarballUrl: tgz.browser_download_url, version }
  }
  return null
}

/**
 * 子模块是 agent-preset 仓库时，用 git trees API 枚举顶层 `preset/` 下
 * 含 `preset.yml` 的变体目录（如 `preset/router-standard`），每个产出一个预设目标。
 */
async function detectPresets(
  repository: string,
  revision: string,
  fetchImpl: typeof fetch,
): Promise<PresetInstallTarget[]> {
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/')
  const response = await fetchImpl(`https://api.github.com/repos/${repositoryPath}/git/trees/${revision}?recursive=1`, {
    headers: GITHUB_API_HEADERS,
  })
  if (!response.ok) return []
  const tree: unknown = await response.json().catch(() => null)
  const entries = (tree && typeof tree === 'object' && Array.isArray((tree as { tree?: unknown }).tree))
    ? (tree as { tree: Array<{ path?: unknown; type?: unknown }> }).tree
    : []
  const variantNames = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'blob' || typeof entry.path !== 'string') continue
    const match = /^preset\/([^/]+)\/preset\.yml$/.exec(entry.path)
    if (match) variantNames.add(match[1])
  }
  const targets: PresetInstallTarget[] = []
  for (const variant of variantNames) {
    if (!isSkillName(variant)) continue
    targets.push({
      id: `${variant}:preset/${variant}`,
      name: variant,
      description: `${variant} agent preset（含 preset.yml 的 DSH 预设目录）。`,
      sourceRepository: repository,
      revision,
      sourcePath: `preset/${variant}`,
    })
  }
  return targets.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 分析一个聚合仓库：把 .gitmodules 声明的每个 GitHub 子模块分别交给注入的
 * plugin / skill 分析器（installer 传入缓存版 analyzePlugin / analyzeSkill），
 * 汇总 targets 并给每个 target 打上 `sourceRepository`（子模块仓库）与精确 commit。
 * github 源插件子模块优先 Release tgz；plugin / skill 都没识别出的子模块再探测
 * agent-preset 目录（如 routing-suite 的 router-standard）。
 *
 * 返回 null 表示不是 meta-repo（无 .gitmodules / 无 GitHub 子模块 / 子模块里
 * 没有任何可安装组件），调用方回落到常规分类（保留「AI 尝试」兜底）。
 */
export async function analyzeMetaRepository(
  fullName: string,
  defaultBranch: string,
  analyzePlugin: (repository: string, branch: string) => Promise<RepositoryAnalysis>,
  analyzeSkill: (repository: string, branch: string) => Promise<SkillRepositoryAnalysis>,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogRepositoryAnalysis | null> {
  if (!isSafeRepositoryName(fullName) || !safeBranch(defaultBranch)) return null

  const gitmodules = await readGitModules(fullName, defaultBranch, fetchImpl)
  if (!gitmodules) return null
  const declarations = parseGitModules(gitmodules)
  if (declarations.length === 0) return null

  const pins = await resolveSubmodulePins(fullName, fetchImpl)
  const pluginTargets: PluginInstallTarget[] = []
  const skillTargets: SkillInstallTarget[] = []
  const presetTargets: PresetInstallTarget[] = []
  const components: string[] = []
  const seenPaths = new Set<string>()
  const seenPlugins = new Set<string>()
  const seenSkills = new Set<string>()
  const seenPresets = new Set<string>()
  const releaseAnalyses: ReleaseAnalysis[] = []

  for (const declaration of declarations) {
    const submodulePath = declaration.path
    if (!submodulePath || submodulePath === '.' || submodulePath === '..' || seenPaths.has(submodulePath)) continue
    seenPaths.add(submodulePath)
    const submoduleRepository = submoduleFullName(declaration.url)
    if (!submoduleRepository) continue
    // gitlink 精确 commit 优先；解析失败回退 .gitmodules 声明的 branch，再退默认分支。
    const pinned = pins?.get(submodulePath)
    const revision = pinned ?? declaration.branch ?? 'main'
    if (!safeBranch(revision)) continue

    const [pluginAnalysis, skillAnalysis] = await Promise.all([
      analyzePlugin(submoduleRepository, revision).catch(() => null),
      analyzeSkill(submoduleRepository, revision).catch(() => null),
    ])
    const basePluginTargets = pluginAnalysis?.targets ?? []
    const baseSkillTargets = skillAnalysis?.targets ?? []
    if (pluginAnalysis?.releaseAnalysis?.state === 'found' && pluginAnalysis.releaseAnalysis.assets.length > 0) {
      releaseAnalyses.push(pluginAnalysis.releaseAnalysis)
    }

    // github 源插件：优先官方 Release tgz（源码 pin 不一定带构建产物）。
    let submodulePluginTargets = basePluginTargets
    if (basePluginTargets.some(target => target.source === 'github')) {
      const release = await resolveReleaseTarball(submoduleRepository, fetchImpl).catch(() => null)
      if (release) {
        submodulePluginTargets = basePluginTargets.map(target => target.source === 'github'
          ? { ...target, source: 'release' as const, tarballUrl: release.tarballUrl, version: release.version }
          : target)
      }
    }
    for (const target of submodulePluginTargets) {
      const packageName = target.packageName.toLowerCase()
      if (seenPlugins.has(packageName)) continue
      seenPlugins.add(packageName)
      pluginTargets.push({ ...target, sourceRepository: submoduleRepository, commit: revision })
    }
    for (const target of baseSkillTargets) {
      const name = target.name.toLowerCase()
      if (seenSkills.has(name)) continue
      seenSkills.add(name)
      skillTargets.push({ ...target, sourceRepository: submoduleRepository, revision })
    }

    // plugin / skill 都没识别出的子模块，再探测是不是 agent-preset 仓库。
    let submodulePresetTargets: PresetInstallTarget[] = []
    if (basePluginTargets.length === 0 && baseSkillTargets.length === 0) {
      submodulePresetTargets = await detectPresets(submoduleRepository, revision, fetchImpl).catch(() => [])
    }
    for (const preset of submodulePresetTargets) {
      const key = preset.name.toLowerCase()
      if (seenPresets.has(key)) continue
      seenPresets.add(key)
      presetTargets.push(preset)
    }

    if (basePluginTargets.length > 0 || baseSkillTargets.length > 0 || submodulePresetTargets.length > 0) {
      components.push(`${submodulePath} → ${submoduleRepository}@${revision.slice(0, 12)}`)
    }
  }

  if (pluginTargets.length + skillTargets.length + presetTargets.length === 0) return null

  const hasPlugin = pluginTargets.length > 0
  const hasSkill = skillTargets.length > 0
  const hasPreset = presetTargets.length > 0
  const kind: CatalogRepositoryAnalysis['kind'] = [hasPlugin && 'plugin', hasSkill && 'skill', hasPreset && 'preset']
    .filter((value): value is 'plugin' | 'skill' | 'preset' => Boolean(value)).length > 1
    ? 'hybrid'
    : hasPlugin
      ? 'plugin'
      : hasSkill
        ? 'skill'
        : hasPreset
          ? 'preset'
          : 'invalid'

  const pluginAnalysis: RepositoryAnalysis = {
    repository: fullName,
    defaultBranch,
    installability: pluginTargets.length === 1
      ? 'ready'
      : pluginTargets.length > 1
        ? 'choice'
        : 'invalid',
    summary: pluginTargets.length > 0
      ? `检测到 ${pluginTargets.length} 个可安装 Plugin 组件。`
      : '未在子模块中检测到 Plugin 组件。',
    targets: pluginTargets,
    releaseAnalysis: releaseAnalyses.length === 0
      ? null
      : releaseAnalyses.length === 1
        ? releaseAnalyses[0]
        : {
            state: 'found',
            releaseTag: null,
            releaseName: `${releaseAnalyses.length} 个子模块 Release`,
            publishedAt: null,
            assets: releaseAnalyses.flatMap(analysis => analysis.assets),
          },
  }
  const skillAnalysis: SkillRepositoryAnalysis = {
    repository: fullName,
    defaultBranch,
    installability: skillTargets.length === 1
      ? 'ready'
      : skillTargets.length > 1
        ? 'choice'
        : 'invalid',
    summary: skillTargets.length > 0
      ? `检测到 ${skillTargets.length} 个可安装 Skill 组件。`
      : '未在子模块中检测到 Skill 组件。',
    targets: skillTargets,
  }
  const presetAnalysis: PresetRepositoryAnalysis = {
    repository: fullName,
    defaultBranch,
    installability: presetTargets.length > 0 ? 'ready' : 'invalid',
    summary: presetTargets.length > 0
      ? `检测到 ${presetTargets.length} 个可安装 Agent 预设。`
      : '未在子模块中检测到 Agent 预设。',
    targets: presetTargets,
  }

  return {
    repository: fullName,
    defaultBranch,
    kind,
    componentKinds: [hasPlugin && 'plugin', hasSkill && 'skill', hasPreset && 'preset']
      .filter((value): value is 'plugin' | 'skill' | 'preset' => Boolean(value)),
    summary: `聚合仓库（meta-repo）：可确定性安装 ${pluginTargets.length} 个 Plugin、${skillTargets.length} 个 Skill 与 ${presetTargets.length} 个预设（${components.join('；')}）。`,
    pluginAnalysis,
    skillAnalysis,
    applicationAnalysis: null,
    presetAnalysis,
    warnings: [],
  }
}
