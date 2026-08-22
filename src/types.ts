export type ViewName = 'plugins' | 'discover' | 'dsh-market' | 'environment' | 'packs' | 'github'
export type RuntimeDrawerMode = 'hidden' | 'half' | 'expanded'
export type WindowMode = 'launcher' | 'manager'
export type UiTheme = 'forest' | 'ocean' | 'berry' | 'graphite'

export interface AppSettings {
  dshInstallPath: string
  dshHome: string
  /** 当前选中的启动器托管 DSH 版本；null 表示沿用旧版自动检测。 */
  dshVersion?: string | null
  /** 当前选中的启动器托管 Node.js 版本；null 表示系统 Node 优先。 */
  nodeVersion?: string | null
  profileName: string
  /** 当前选中的整合包清单；不改变实际 DSH Profile。 */
  activePackId?: string | null
  workspace: string
  launchExecutable: string
  launchArgs: string[]
  webPort: number
  openAfterLaunch: boolean
  /** 启动器界面配色；主表面由同一基色的明暗层级构成。 */
  uiTheme?: UiTheme
  /** DSH Copilot 是否允许用户替换基础 persona。 */
  aiDeveloperMode?: boolean
  /** DSH Copilot 的用户提示词覆盖/追加内容。 */
  aiPrompt?: string
}

export interface CredentialStatus {
  configured: boolean
}

export type CustomApiProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface CustomApiProvider {
  route: string
  displayName: string
  baseUrl: string
  protocol: CustomApiProtocol
  modelIds: string[]
  credentialName: string | null
  hasApiKey: boolean
}

export interface CustomApiProviderInput {
  originalRoute?: string
  route: string
  displayName: string
  baseUrl: string
  protocol: CustomApiProtocol
  modelIds: string[]
  /** 编辑时留空表示保留现有密钥；新建时留空表示该服务无需鉴权。 */
  apiKey?: string
}

export interface GitHubRateLimit {
  limit: number
  remaining: number
  resetAt: string | null
}

export interface GitHubAuthStatus {
  authenticated: boolean
  login: string | null
  name: string | null
  avatarUrl: string | null
  scopes: string[]
  method: 'oauth' | 'token' | null
  oauthAvailable: boolean
  rateLimit: GitHubRateLimit | null
}

export interface GitHubDeviceAuthorization {
  userCode: string
  verificationUri: string
  expiresAt: string
  intervalSeconds: number
}

export interface GitHubPullRequestSummary {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  draft: boolean
  author: string
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  headBranch: string
  baseBranch: string
}

export interface ManagedPlugin {
  packageName: string
  displayName: string
  version: string
  description: string
  repository?: string
  repositoryFullName?: string
  enabled: boolean
  builtin: boolean
  locked: boolean
  compatible: boolean
  order: number | null
}

export interface ProfileState {
  initialized: boolean
  profileDir: string
  manifestPath: string
  plugins: ManagedPlugin[]
  activeBundles: string[]
  dependencyCount: number
  disabledCount: number
}

export type CatalogCandidateType = 'plugin' | 'skill' | 'application'
export type CatalogComponentKind = 'plugin' | 'skill' | 'application' | 'preset'
export type CatalogKind = CatalogComponentKind | 'hybrid' | 'dsh' | 'invalid'

export interface CatalogRepositoryResult {
  id: number
  fullName: string
  name: string
  owner: string
  description: string
  url: string
  stars: number
  /** GitHub Search API reports repository size in kilobytes. */
  sizeKb?: number
  language: string | null
  updatedAt: string
  topics: string[]
  defaultBranch: string
  kind: 'repository' | 'dsh'
  candidateTypes: CatalogCandidateType[]
  /** 市场内置（featured）条目，列表顶部固定展示。 */
  featured?: boolean
}

export type PluginInstallability = 'ready' | 'choice' | 'dynamic' | 'application' | 'invalid'

export type PluginInstallSource = 'npm' | 'github' | 'archive-subdirectory' | 'local-directory' | 'release'

export interface PluginInstallTarget {
  id: string
  packageName: string
  version: string | null
  source: PluginInstallSource
  profileName: string
  platform: 'web' | 'terminal' | 'unknown'
  subdirectory: string | null
  commit: string
  requiresBuild: boolean
  buildScripts: string[]
  nodeRange: string | null
  /** `local-directory` 源专用：本地插件本体所在目录（已存在的绝对路径）。 */
  localDirectory?: string
  /** `release` 源专用：GitHub Release tgz 资产直链（meta-repo 分析时解析，安装时透传请求）。 */
  tarballUrl?: string
  /** 聚合仓库（meta-repo）子模块来源：安装请求应指向该仓库，而非父 meta-repo。 */
  sourceRepository?: string
}

export interface RepositoryAnalysis {
  repository: string
  defaultBranch: string
  installability: PluginInstallability
  summary: string
  targets: PluginInstallTarget[]
  /** 最新稳定 GitHub Release 中可直接下载的可执行资产。 */
  releaseAnalysis?: ReleaseAnalysis | null
}

export type ReleaseExecutablePlatform = 'windows' | 'macos' | 'linux' | 'cross-platform' | 'unknown'
export type ReleaseExecutableKind =
  | 'exe'
  | 'msi'
  | 'dmg'
  | 'pkg'
  | 'appimage'
  | 'deb'
  | 'rpm'
  | 'binary'
  | 'script'
  | 'jar'
  | 'archive'

export interface ReleaseExecutableAsset {
  name: string
  url: string
  size: number | null
  contentType: string | null
  platform: ReleaseExecutablePlatform
  kind: ReleaseExecutableKind
  releaseTag: string
  releaseName: string | null
  publishedAt: string | null
}

export interface ReleaseAnalysis {
  state: 'found' | 'none' | 'unavailable'
  releaseTag: string | null
  releaseName: string | null
  publishedAt: string | null
  assets: ReleaseExecutableAsset[]
}

export interface PluginInstallRequest {
  repository: string
  defaultBranch: string
  targetId: string
  profileName?: string // 安装到指定 profile
  /** release 源插件：meta-repo 分析得到的 tgz 直链，安装时覆盖重分析得到的 github 源。 */
  tarballUrl?: string
}

export interface DshInstallationStatus {
  installed: boolean
  version: string | null
  executable: string | null
  source: 'launcher' | 'system' | null
}

export interface DshUpdateStatus {
  state: 'not-installed' | 'up-to-date' | 'update-available' | 'error'
  localVersion: string | null
  remoteVersion: string | null
  repository: string
  checkedAt: string
  message: string
}

/** Profile 是本地运行环境与可分享整合包的唯一实体。 */
export interface ProfileSourceMetadata {
  kind: 'local' | 'github' | 'import'
  path?: string
  repository?: string
  branch?: string
  commit?: string
  format?: 'zip' | 'yaml' | 'github'
  reference?: string
}

export interface ProfileSummary {
  id: string
  name: string
  description: string
  dshVersion: string | null
  source: ProfileSourceMetadata | null
  createdAt: string
  updatedAt: string
  exportedAt?: string | null
  profileDir: string
  initialized: boolean
  pluginCount: number
  enabledPluginCount: number
  disabledPluginCount: number
  missingDependencies: string[]
  hasNodeModules: boolean
  selected: boolean
}

export interface ProfileCreateRequest {
  name: string
  description?: string
  dshVersion?: string | null
  cloneFrom?: string
}

export type ProfileExportMode = 'light' | 'full' | 'repository'
export interface ProfileExportOptions {
  repositoryPrivate?: boolean
}

export interface RuntimeVersionCandidate {
  version: string
  label: string | null
  lts: string | boolean | null
  date: string | null
  prerelease: boolean
}

export interface DshVersionInfo {
  version: string
  root: string
  executable: string
  source: 'launcher' | 'legacy' | 'system'
  selected: boolean
  removable: boolean
}

export interface NodeVersionInfo {
  version: string
  root: string
  executable: string
  source: 'launcher' | 'legacy' | 'system'
  selected: boolean
  removable: boolean
}

export interface RuntimeEnvironmentState {
  dshRoot: string
  nodeRoot: string
  dshSelectedVersion: string | null
  nodeSelectedVersion: string | null
  dshInstalled: DshVersionInfo[]
  nodeInstalled: NodeVersionInfo[]
  dshAvailable: RuntimeVersionCandidate[]
  nodeAvailable: RuntimeVersionCandidate[]
}

export interface LauncherUpdateStatus {
  state: 'up-to-date' | 'update-available' | 'downloading' | 'downloaded' | 'applying' | 'error'
  localVersion: string | null
  remoteVersion: string | null
  releaseUrl: string | null
  assetName: string | null
  assetSize: number | null
  checkedAt: string | null
  message: string
}

export interface LauncherUpdateProgress {
  phase: 'downloading' | 'applying'
  percent: number
  downloadedBytes?: number
  totalBytes?: number
}

export interface SkillInstallTarget {
  id: string
  name: string
  description: string
  sourcePath: string
  format: 'bundle' | 'flat'
  revision: string
  modelInvocable: boolean
  userInvocable: boolean
  /** 聚合仓库（meta-repo）子模块来源：安装请求应指向该仓库，而非父 meta-repo。 */
  sourceRepository?: string
}

export interface SkillRepositoryAnalysis {
  repository: string
  defaultBranch: string
  installability: 'ready' | 'choice' | 'invalid'
  summary: string
  targets: SkillInstallTarget[]
}

export interface InstalledSkill {
  name: string
  description: string
  path: string
  format: 'bundle' | 'flat'
  enabled: boolean
  modelInvocable: boolean
  userInvocable: boolean
  /** 以下字段来自 skill receipts；仅在通过启动器安装过且有来源记录时存在。 */
  repository?: string
  sourcePath?: string
  revision?: string
}

export interface SkillInstallRequest {
  repository: string
  defaultBranch: string
  targetId: string
}

export interface SkillInstallResult {
  installedSkill: InstalledSkill
  installedSkills: InstalledSkill[]
}

export type ApplicationLaunchMode = 'runtime-replacement' | 'after-runtime' | 'standalone'
export type ApplicationInstallProvider = 'npm'

export interface ApplicationInstallTarget {
  id: string
  addonId: string
  name: string
  description: string
  provider: ApplicationInstallProvider
  packageName: string
  version: string | null
  binName: string
  launchMode: ApplicationLaunchMode
  launchArgs: string[]
  platforms: Array<'win32' | 'darwin' | 'linux'>
  supported: boolean
  verified: boolean
  provides: string[]
}

export interface ApplicationRepositoryAnalysis {
  repository: string
  defaultBranch: string
  installability: 'ready' | 'choice' | 'unsupported' | 'invalid'
  summary: string
  targets: ApplicationInstallTarget[]
}

export interface InstalledApplicationAddon {
  id: string
  name: string
  description: string
  repository: string
  provider: ApplicationInstallProvider
  packageName: string
  version: string
  binName: string
  entryPath: string
  installPath: string
  launchMode: ApplicationLaunchMode
  launchArgs: string[]
  enabled: boolean
  verified: boolean
  provides: string[]
  installedAt: string
  updatedAt: string
}

export interface ApplicationInstallRequest {
  repository: string
  defaultBranch: string
  targetId: string
}

export interface ApplicationInstallResult {
  installedAddon: InstalledApplicationAddon
  installedAddons: InstalledApplicationAddon[]
  profile: ProfileState
}

export interface LinkedComponentToggleResult {
  profile: ProfileState
  installedApplications: InstalledApplicationAddon[]
  linked: boolean
}

/**
 * Agent 预设安装目标。DSH 的 agent-preset 是一份含 preset.yml 的目录，
 * 安装 = 把子模块仓库内 `sourcePath` 目录复制到 `~/.dsh/.agent-presets/<name>`。
 */
export interface PresetInstallTarget {
  id: string
  name: string
  description: string
  /** 子模块仓库（meta-repo 分析时确定），安装请求应指向它而非父 meta-repo。 */
  sourceRepository: string
  /** 精确 pin commit。 */
  revision: string
  /** 子模块内预设目录，如 `preset/router-standard`。 */
  sourcePath: string
}

export interface PresetRepositoryAnalysis {
  repository: string
  defaultBranch: string
  installability: 'ready' | 'invalid'
  summary: string
  targets: PresetInstallTarget[]
}

export interface InstalledPreset {
  name: string
  path: string
  /** false 表示被停用（目录在 .agent-presets/.disabled 下，DSH 不可见）。 */
  enabled: boolean
  /** 以下字段来自 preset receipts；仅在通过启动器安装过且有来源记录时存在。 */
  repository?: string
  sourcePath?: string
  revision?: string
}

export interface PresetInstallRequest {
  /** 子模块仓库（meta-repo 分析确定），不是父 meta-repo。 */
  repository: string
  targetId: string
  /** 预设名（.agent-presets/<name> 目录名）。 */
  name: string
  /** 子模块内预设目录，如 `preset/router-standard`。 */
  sourcePath: string
  /** 精确 pin commit。预设安装不做重分析：revision 已钉死，内容不可变。 */
  revision: string
}

export interface PresetInstallResult {
  installedPreset: InstalledPreset
  installedPresets: InstalledPreset[]
}

export interface CatalogRepositoryAnalysis {
  repository: string
  defaultBranch: string
  kind: CatalogKind
  componentKinds: CatalogComponentKind[]
  summary: string
  pluginAnalysis: RepositoryAnalysis | null
  skillAnalysis: SkillRepositoryAnalysis | null
  applicationAnalysis: ApplicationRepositoryAnalysis | null
  /** agent-preset 组件（meta-repo 子模块里的预设目录），非聚合仓库无此字段。 */
  presetAnalysis?: PresetRepositoryAnalysis | null
  warnings: string[]
  /** 共享检测目录同步状态；仅运行时附加，不写入共享 XML。 */
  sync?: CatalogSyncInfo
}

/** 共享目录 XML 中保存的最小分类标签。 */
export type CatalogIndexTag = 'plugin' | 'skill' | 'runtime' | 'preset' | 'dsh' | 'invalid'

/** 共享目录 XML 的一行；不包含检测过程、摘要或本地路径。 */
export interface CatalogIndexEntry {
  repository: string
  defaultBranch: string
  repositoryUpdatedAt: string | null
  tags: CatalogIndexTag[]
}

export type CatalogSyncState = 'remote' | 'queued' | 'published' | 'not-authenticated' | 'unavailable' | 'stale-fallback'

export interface CatalogSyncInfo {
  source: 'github' | 'local'
  state: CatalogSyncState
  message: string
  pullRequestUrl?: string
}

export type CatalogAnalysisCheck = 'plugin' | 'skill' | 'application'
export type CatalogAnalysisCheckState = 'pending' | 'running' | 'complete' | 'failed'

/** 单个仓库的实时检测步骤。三个结构检测器并行执行，不表示虚拟下载百分比。 */
export interface CatalogAnalysisProgress {
  repository: string
  phase: 'preparing' | 'checking' | 'classifying' | 'complete' | 'error'
  message: string
  completed: number
  total: 3
  checks: Record<CatalogAnalysisCheck, CatalogAnalysisCheckState>
}

export interface CatalogDiscoveryResult {
  repositories: CatalogRepositoryResult[]
  topicTotals: Record<CatalogCandidateType, number>
  page: number
  pageCount: number
  rateRemaining?: number
  warnings: string[]
  dshInstallation: DshInstallationStatus
  installedRepositories: string[]
  installedSkills: InstalledSkill[]
  installedApplications: InstalledApplicationAddon[]
  installedPresets: InstalledPreset[]
}

/** 从 GitHub 链接导入的结果：市场行 + 已完成的仓库分析。 */
export interface CatalogImportResult {
  repository: CatalogRepositoryResult
  analysis: CatalogRepositoryAnalysis
}

export interface InstallProgress {
  repository: string
  kind: 'plugin' | 'dsh' | 'skill' | 'application' | 'preset'
  phase: 'preparing' | 'resolving' | 'downloading' | 'building' | 'configuring' | 'verifying' | 'complete' | 'error'
  percent: number
  message: string
  indeterminate?: boolean
  downloadedBytes?: number
  totalBytes?: number
}

export interface RepositoryInstallResult {
  kind: 'plugin' | 'dsh'
  profile: ProfileState
  settings: AppSettings
  dshInstallation: DshInstallationStatus
  installedProfileName?: string
  packageName?: string
}

export interface RuntimeState {
  running: boolean
  pid: number | null
  startedAt: string | null
  url: string | null
  port: number | null
  launchMode?: 'web' | 'application-replacement'
  applicationAddonId?: string | null
  applicationAddonName?: string | null
  /** 最近一次非正常退出，供界面显示 AI 修复入口。新一轮启动时清空。 */
  lastFailure?: RuntimeFailure | null
}

export interface RuntimeFailure {
  profileName: string
  diagnostics: string
  failedAt: string
}

export interface RuntimeOutput {
  channel: 'runtime' | 'plugin' | 'test' | 'ai'
  level: 'info' | 'error' | 'success'
  text: string
  timestamp: string
}

export type AiInstallPhase = 'idle' | 'preparing' | 'running' | 'done' | 'cancelled' | 'error'

export interface AiInstallStatus {
  phase: AiInstallPhase
  repository: string | null
  taskKind: 'repository-install' | 'plugin-adaptation' | 'runtime-repair'
  subject: string | null
  startedAt: string | null
  sessionId: string | null
  message: string
}

export type PluginTrialPhase = 'running' | 'passed' | 'failed'

/** 插件隔离试运行的实时状态与最近结果。 */
export interface PluginTrialResult {
  packageName: string
  profileName: string
  phase: PluginTrialPhase
  message: string
  diagnostics: string
  startedAt: string
  testedAt: string | null
  durationMs: number | null
  url: string | null
}

/** 渲染层看到的待审批请求（args 已脱敏截断）。 */
export interface AiApprovalRequest {
  id: string
  sessionId?: string
  toolName: string
  toolKind: string | null
  args: string
  reason: string
}

export type AiInstallEvent =
  | { kind: 'status'; status: AiInstallStatus }
  | { kind: 'log'; text: string; stream?: boolean }
  | { kind: 'auto-approved'; toolName: string; reason: string }
  | { kind: 'approval'; request: AiApprovalRequest }
  | { kind: 'snapshot'; snapshotId: string }
  | { kind: 'done'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string }

export interface AiInstallResult {
  ok: boolean
  message: string
}

// ===================== 整合包（Pack）管理 =====================

export type PackSource = 'created' | 'zip' | 'manifest' | 'raw'

export interface PackPluginEntry {
  packageName: string
  /** 完整安装目标；用于导入时不重新猜测仓库结构。 */
  targetId?: string
  repository?: string        // github 源
  defaultBranch?: string
  source?: 'github' | 'npm' | 'local'
  subdirectory?: string
  commit?: string
  version?: string
  /** 清单期望状态；缺省为启用。 */
  enabled?: boolean
  /** 清单声明的精确 pnpm 构建许可策略。 */
  allowBuilds?: string[]
  denyBuilds?: string[]
}

export type AiSessionKind = 'chat' | 'repository-install' | 'plugin-adaptation' | 'runtime-repair'
export type AiSessionPhase = 'idle' | 'queued' | 'preparing' | 'running' | 'done' | 'cancelled' | 'error' | 'interrupted'

export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  createdAt: string
  streaming?: boolean
}

export interface AiQueueState {
  position: number | null
  total: number
  running: boolean
  mutating: boolean
  reason?: string | null
}

export interface AiSessionSummary {
  id: string
  kind: AiSessionKind
  title: string
  subject: string | null
  phase: AiSessionPhase
  createdAt: string
  updatedAt: string
  queue: AiQueueState
  messageCount: number
  pendingApproval: AiApprovalRequest | null
  hasSnapshot: boolean
}

export interface AiSession extends AiSessionSummary {
  messages: AiMessage[]
}

export type AiSessionEvent =
  | { kind: 'session-created'; session: AiSession }
  | { kind: 'session-updated'; session: AiSession }
  | { kind: 'message'; sessionId: string; message: AiMessage }
  | { kind: 'approval'; sessionId: string; request: AiApprovalRequest }
  | { kind: 'snapshot'; sessionId: string; snapshotId: string }
  | { kind: 'deleted'; sessionId: string }

export interface AiSessionCreateInput {
  kind?: AiSessionKind
  title?: string
  subject?: string | null
}

export interface PackPresetEntry {
  /** 预设目录名，也是 `~/.dsh/.agent-presets/<name>` 的目录名。 */
  name: string
  /** 子模块仓库（meta-repo 分析确定）。 */
  repository?: string
  /** 子模块内预设目录，如 `preset/router-standard`。 */
  sourcePath?: string
  /** 精确 pin commit。 */
  revision?: string
}

export interface PackSkillEntry {
  name: string
  format: 'bundle' | 'flat'
  /** 子模块仓库（meta-repo 分析确定）。 */
  repository?: string
  /** 子模块内 Skill 源路径，如 `skills/git-workflow` 或 `skills/quick-ref.md`。 */
  sourcePath?: string
  /** 精确 pin commit。 */
  revision?: string
}

export interface PackApplicationEntry {
  id: string
  name: string
  repository: string
  packageName: string
  version: string
  binName: string
  launchMode: ApplicationLaunchMode
  launchArgs: string[]
  provides: string[]
}

export interface PackManifest {
  name: string
  description: string
  version: string
  /** 当前整合包要求使用的 DSH 精确版本；导入当前版本时必须提供。 */
  dshVersion?: string
  author?: string
  plugins: PackPluginEntry[]
  presets?: PackPresetEntry[]
  skills?: PackSkillEntry[]
  applications?: PackApplicationEntry[]
}

export interface PackAnalysisItem {
  packageName: string
  available: boolean          // 能否安装
  offline: boolean            // 插件本体是否在 zip 内（离线装）
  enabled?: boolean            // 清单期望状态；false 表示安装后保持关闭
  kind?: 'plugin' | 'skill' | 'preset' | 'application'   // 缺省为插件；技能/预设/应用项的 packageName 即名称
  reason?: string             // 不可装原因
}

export interface PackAnalysis {
  id: string                  // = pack-<safeName>
  name: string
  description: string
  version: string
  dshVersion: string | null
  source: PackSource
  items: PackAnalysisItem[]
}

export interface PackInstalledPlugin {
  packageName: string
  enabled: boolean
  version?: string
}

/** raw 整合包导入的技能（全局安装，记入包以支持删包清理）。 */
export interface PackInstalledSkill {
  name: string
  format: 'bundle' | 'flat'
  enabled: boolean
  description?: string
}

/** 整合包记录的 Agent 预设（全局安装，记入包以支持导出与删包清理）。 */
export interface PackInstalledPreset {
  name: string
  enabled: boolean
  description?: string
}

/** 整合包记录的 Application Addon（独立安装目录，记入包以支持导出与删包清理）。 */
export interface PackInstalledApplication {
  id: string
  name: string
  enabled: boolean
}

export interface PackStatus {
  id: string
  name: string
  description: string
  version: string
  /** 当前整合包要求的 DSH 版本；旧注册表记录可能为空。 */
  dshVersion: string | null
  source: PackSource
  enabled: boolean            // 当前选中的整合包清单
  state: 'complete' | 'partial' | 'failed'
  plugins: PackInstalledPlugin[]
  skills?: PackInstalledSkill[]
  presets?: PackInstalledPreset[]
  applications?: PackInstalledApplication[]
  /** state 为 partial/failed 时的失败项（含原因），完整包缺省省略。 */
  failures?: { packageName: string; reason: string }[]
  installedAt: string
  updatedAt: string
}

export interface PackCreateRequest {
  name: string
  description?: string
  packageNames: string[]      // 从已安装插件勾选的包名
  presetNames?: string[]      // 从已安装且有来源记录的 Agent 预设勾选
  skillNames?: string[]       // 从已安装且有来源记录的 Skill 勾选
  applicationIds?: string[]   // 从已安装的 Application Addon 勾选
  /** 可选覆盖；缺省使用当前启动器选中的 DSH 版本。 */
  dshVersion?: string
}

/** importPack 的可选覆盖项（raw 导入时的包名覆盖）。 */
export interface PackImportOptions {
  name?: string
  /** Explicitly replace an existing Profile; default imports create a new
   * suffixed Profile instead of changing the current environment. */
  overwrite?: boolean
  /** Remote Profile import mode. Full mode requires every plugin body in the archive. */
  mode?: 'source' | 'full'
  /** Main-process-only validated shared body paths for matched local plugins. */
  localPluginBodies?: Record<string, string>
}

export type ProfileRepositoryImportMode = 'source' | 'full'

export interface ProfileRepositoryPluginPreview {
  packageName: string
  enabled: boolean
  order: number
  source: 'npm' | 'github' | 'local'
  repository: string | null
  version: string | null
  commit: string | null
  match: 'declared' | 'matched' | 'ambiguous' | 'missing'
  candidates: PackPluginEntry[]
  reason?: string
}

export interface ProfileRepositoryImportPreview {
  repository: string
  branch: string
  commit: string | null
  manifestPath: 'dsh-profile.yaml' | 'dsh-pack.yaml'
  profileName: string
  description: string
  version: string
  dshVersion: string
  dshVersionInstalled?: boolean
  plugins: ProfileRepositoryPluginPreview[]
  hasFullPackage: boolean
  fullPackagePluginBodies: string[]
  differences: { kind: 'added' | 'removed' | 'version' | 'commit' | 'enabled' | 'order'; packageName: string; detail: string }[]
  blockers: string[]
}

export interface PackInstallResult {
  id: string
  installed: string[]
  failures: { packageName: string; reason: string }[]
  state: 'complete' | 'partial' | 'failed'
}

export type PackProgressEvent =
  | { kind: 'status'; message: string }
  | { kind: 'phase'; phase: string; itemIndex?: number; itemTotal?: number }
  | { kind: 'item-start'; packageName: string; offline: boolean }
  | { kind: 'item-done'; packageName: string; ok: boolean; reason?: string }
  | { kind: 'snapshot' }
  | { kind: 'done'; result: PackInstallResult }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

export interface DshMarketPlugin {
  name: string
  owner: string
  url: string
  category: string
  description: Record<string, string | undefined>
  npm: string | null
  stars: number
  added: string
  install: string
  installed: boolean
  enabled: boolean
  version: string | null
  updateAvailable: boolean
  updateVersion: string | null
}

export type DshMarketInstalledPlugin = DshMarketPlugin

export interface DshMarketCatalog {
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  plugins: DshMarketPlugin[]
}

export interface DshMarketUpdateStatus {
  kind: 'npm' | 'github' | 'linked'
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

export interface DshMarketProgress {
  name: string
  phase: 'loading' | 'checking' | 'resolving' | 'downloading' | 'building' | 'verifying' | 'complete' | 'error'
  percent: number | null
  message: string
  downloadedBytes?: number | null
  totalBytes?: number | null
}

export interface LauncherApi {
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  detectDshInstallation(): Promise<DshInstallationStatus>
  checkDshUpdate(): Promise<DshUpdateStatus>
  readRuntimeEnvironment(refresh?: boolean): Promise<RuntimeEnvironmentState>
  installDshVersion(version: string): Promise<RuntimeEnvironmentState>
  selectDshVersion(version: string): Promise<RuntimeEnvironmentState>
  removeDshVersion(version: string): Promise<RuntimeEnvironmentState>
  installNodeVersion(version: string): Promise<RuntimeEnvironmentState>
  selectNodeVersion(version: string | null): Promise<RuntimeEnvironmentState>
  removeNodeVersion(version: string): Promise<RuntimeEnvironmentState>
  cancelRuntimeEnvironmentOperation(): Promise<void>
  openDshFolder(): Promise<void>
  openNodeFolder(): Promise<void>
  checkLauncherUpdate(): Promise<LauncherUpdateStatus>
  downloadLauncherUpdate(): Promise<LauncherUpdateStatus>
  applyLauncherUpdate(): Promise<void>
  onLauncherUpdateProgress(listener: (progress: LauncherUpdateProgress) => void): () => void
  getDeepSeekCredentialStatus(): Promise<CredentialStatus>
  setDeepSeekApiKey(apiKey: string): Promise<CredentialStatus>
  clearDeepSeekApiKey(): Promise<CredentialStatus>
  listCustomApiProviders(): Promise<CustomApiProvider[]>
  saveCustomApiProvider(input: CustomApiProviderInput): Promise<CustomApiProvider[]>
  removeCustomApiProvider(route: string): Promise<CustomApiProvider[]>
  getGitHubAuthStatus(): Promise<GitHubAuthStatus>
  loginGitHubWithToken(token: string): Promise<GitHubAuthStatus>
  beginGitHubDeviceLogin(): Promise<GitHubDeviceAuthorization>
  completeGitHubDeviceLogin(): Promise<GitHubAuthStatus>
  cancelGitHubDeviceLogin(): Promise<void>
  logoutGitHub(): Promise<GitHubAuthStatus>
  listGitHubPullRequests(): Promise<GitHubPullRequestSummary[]>
  getGitHubStarStatus(repository: string): Promise<boolean>
  setGitHubStar(repository: string, starred: boolean): Promise<boolean>
  chooseDirectory(kind: 'dshInstallPath' | 'dshHome' | 'workspace'): Promise<string | null>
  readProfile(): Promise<ProfileState>
  listProfiles(): Promise<ProfileSummary[]>
  createProfile(request: ProfileCreateRequest): Promise<ProfileSummary>
  cloneProfile(sourceName: string, targetName: string, description?: string): Promise<ProfileSummary>
  switchProfile(profileName: string, options?: { fillMissing?: boolean }): Promise<AppSettings>
  deleteProfile(profileName: string): Promise<void>
  readProfileMetadata(profileName: string): Promise<ProfileSummary>
  exportProfile(profileName: string, mode: ProfileExportMode, options?: ProfileExportOptions): Promise<string | null>
  importProfile(path: string, options?: { name?: string; overwrite?: boolean }): Promise<ProfileSummary>
  analyzeProfileRepository(url: string): Promise<ProfileRepositoryImportPreview>
  importProfileRepository(url: string, options: { mode: ProfileRepositoryImportMode; name?: string; overwrite?: boolean; resolutions?: Record<string, PackPluginEntry> }): Promise<ProfileSummary>
  matchProfilePlugin(packageName: string): Promise<PackPluginEntry | null>
  togglePlugin(packageName: string, enabled: boolean, profileName?: string): Promise<LinkedComponentToggleResult>
  reorderPlugins(packageNames: string[]): Promise<ProfileState>
  discoverCatalog(query: string, sort: 'stars' | 'updated', page: number): Promise<CatalogDiscoveryResult>
  refreshCatalogIndex(): Promise<CatalogIndexEntry[]>
  analyzeCatalogRepository(fullName: string, defaultBranch: string, repositoryUpdatedAt?: string): Promise<CatalogRepositoryAnalysis>
  importCatalogUrl(url: string): Promise<CatalogImportResult>
  loadDshMarket(): Promise<DshMarketCatalog>
  installDshMarketPlugin(name: string): Promise<DshMarketInstalledPlugin[]>
  updateDshMarketPlugin(name: string): Promise<DshMarketInstalledPlugin[]>
  uninstallDshMarketPlugin(name: string): Promise<DshMarketInstalledPlugin[]>
  toggleDshMarketPlugin(name: string, enabled: boolean): Promise<DshMarketInstalledPlugin[]>
  checkDshMarketUpdates(force?: boolean): Promise<Record<string, DshMarketUpdateStatus>>
  installPlugin(request: string | PluginInstallRequest): Promise<RepositoryInstallResult>
  uninstallPlugin(packageName: string): Promise<ProfileState>
  trialPlugin(packageName: string, profileName?: string): Promise<PluginTrialResult>
  readPluginTrials(): Promise<PluginTrialResult[]>
  installSkill(request: SkillInstallRequest): Promise<SkillInstallResult>
  readInstalledSkills(): Promise<InstalledSkill[]>
  toggleSkill(name: string, enabled: boolean): Promise<InstalledSkill[]>
  installApplication(request: ApplicationInstallRequest): Promise<ApplicationInstallResult>
  readInstalledApplications(): Promise<InstalledApplicationAddon[]>
  toggleApplication(id: string, enabled: boolean): Promise<LinkedComponentToggleResult>
  uninstallApplication(id: string): Promise<InstalledApplicationAddon[]>
  installPreset(request: PresetInstallRequest): Promise<PresetInstallResult>
  readInstalledPresets(): Promise<InstalledPreset[]>
  togglePreset(name: string, enabled: boolean): Promise<InstalledPreset[]>
  getRuntimeState(): Promise<RuntimeState>
  startRuntime(): Promise<RuntimeState>
  stopRuntime(): Promise<RuntimeState>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  setWindowMode(mode: WindowMode): Promise<void>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<boolean>
  closeWindow(): Promise<void>
  aiInstall(input: { repository: string; defaultBranch: string }): Promise<AiInstallResult>
  aiAdaptPlugin(input: { packageName: string; profileName?: string }): Promise<AiInstallResult>
  aiRepairRuntime(): Promise<AiInstallResult>
  aiApprove(requestId: string, allow: boolean): Promise<boolean>
  aiCancel(): Promise<void>
  aiRollback(): Promise<{ restored: number; profileName: string }>
  aiStatus(): Promise<AiInstallStatus>
  aiHasSnapshot(): Promise<boolean>
  listAiSessions(): Promise<AiSession[]>
  createAiSession(input?: AiSessionCreateInput): Promise<AiSession>
  sendAiSessionMessage(sessionId: string, text: string): Promise<AiSession>
  cancelAiSession(sessionId: string): Promise<void>
  approveAiSession(sessionId: string, requestId: string, allow: boolean): Promise<boolean>
  rollbackAiSession(sessionId: string): Promise<{ restored: number; profileName: string }>
  deleteAiSession(sessionId: string): Promise<void>
  listPacks(): Promise<PackStatus[]>
  createPack(request: PackCreateRequest): Promise<PackInstallResult>
  analyzePackImport(path: string): Promise<PackAnalysis>
  importPack(path: string, items?: string[], options?: PackImportOptions): Promise<PackInstallResult>
  exportPack(packId: string): Promise<string | null>
  pickPackFile(): Promise<string | null>
  activatePack(packId: string): Promise<AppSettings>
  deactivatePack(): Promise<AppSettings>
  removePack(packId: string): Promise<{ removed: number }>
  rollbackPack(): Promise<{ restored: number; profileName: string }>
  packHasSnapshot(): Promise<boolean>
  addPackPlugin(packId: string, packageName: string): Promise<PackStatus>
  addPackPreset(packId: string, presetName: string): Promise<PackStatus>
  addPackSkill(packId: string, skillName: string): Promise<PackStatus>
  addPackApplication(packId: string, addonId: string): Promise<PackStatus>
  togglePackItem(packId: string, packageName: string, enabled: boolean): Promise<PackStatus>
  togglePackPreset(packId: string, presetName: string, enabled: boolean): Promise<PackStatus>
  togglePackSkill(packId: string, skillName: string, enabled: boolean): Promise<PackStatus>
  togglePackApplication(packId: string, addonId: string, enabled: boolean): Promise<PackStatus>
  removePackItem(packId: string, packageName: string): Promise<PackStatus>
  removePackPreset(packId: string, presetName: string): Promise<PackStatus>
  removePackSkill(packId: string, skillName: string): Promise<PackStatus>
  removePackApplication(packId: string, addonId: string): Promise<PackStatus>
  onCatalogAnalysisProgress(listener: (progress: CatalogAnalysisProgress) => void): () => void
  onDshMarketProgress(listener: (progress: DshMarketProgress) => void): () => void
  onPackProgress(listener: (event: PackProgressEvent) => void): () => void
  onRuntimeOutput(listener: (output: RuntimeOutput) => void): () => void
  onRuntimeState(listener: (state: RuntimeState) => void): () => void
  onInstallProgress(listener: (progress: InstallProgress) => void): () => void
  onPluginTrialEvent(listener: (result: PluginTrialResult) => void): () => void
  onAiInstallEvent(listener: (event: AiInstallEvent) => void): () => void
  onAiSessionEvent(listener: (event: AiSessionEvent) => void): () => void
}

declare global {
  interface Window {
    launcher?: LauncherApi
  }
}
