import type {
  ApplicationRepositoryAnalysis,
  AiInstallEvent,
  AiMessage,
  AiSession,
  AiSessionCreateInput,
  AiSessionEvent,
  AiInstallStatus,
  AppSettings,
  CatalogAnalysisProgress,
  CatalogIndexEntry,
  CatalogDiscoveryResult,
  CatalogImportResult,
  CatalogRepositoryAnalysis,
  CatalogRepositoryResult,
  CredentialStatus,
  CustomApiProvider,
  DshInstallationStatus,
  DshMarketCatalog,
  DshMarketProgress,
  DshUpdateStatus,
  RuntimeEnvironmentState,
  RuntimeVersionCandidate,
  GitHubAuthStatus,
  GitHubPullRequestSummary,
  InstallProgress,
  InstalledPreset,
  InstalledSkill,
  InstalledApplicationAddon,
  LauncherApi,
  LauncherUpdateProgress,
  LauncherUpdateStatus,
  ManagedPlugin,
  PackProgressEvent,
  PackStatus,
  PluginInstallTarget,
  PluginTrialResult,
  PresetInstallTarget,
  ProfileState,
  RepositoryAnalysis,
  SkillInstallTarget,
  RuntimeOutput,
  RuntimeState,
  SkillRepositoryAnalysis,
} from './types'
import { DSH_REPOSITORY } from './constants'
import { parseGitHubImportUrl } from './lib/github-import'

let demoSettings: AppSettings = {
  dshInstallPath: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\dsh-runtime',
  dshHome: 'C:\\Users\\demo\\.dsh',
  profileName: 'web',
  activePackId: 'pack-web-basic',
  workspace: 'C:\\Users\\demo\\Projects',
  launchExecutable: 'C:\\Program Files\\nodejs\\npx.cmd',
  launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
  webPort: 3080,
  openAfterLaunch: true,
  uiTheme: 'forest',
  dshVersion: null,
  nodeVersion: null,
}

let demoPlugins: ManagedPlugin[] = [
  {
    packageName: '@deepseek-ai/dsh-base',
    displayName: 'Base runtime',
    version: '随 DSH 提供',
    description: 'DeepSeek Harness 的核心服务、模型和工具组合层。',
    enabled: true,
    builtin: true,
    locked: true,
    compatible: true,
    order: 1,
  },
  {
    packageName: '@deepseek-ai/dsh-web-app',
    displayName: 'Web app',
    version: '随 DSH 提供',
    description: '浏览器工作台与 Web 运行时组合层。',
    enabled: true,
    builtin: true,
    locked: true,
    compatible: true,
    order: 2,
  },
  {
    packageName: '@zhu1090093659/dsh-web-ui',
    displayName: 'Web UI collection',
    version: '1.7.2',
    description: '任务看板、Git 图谱、右侧面板、移动端与实时 token 统计。',
    repository: 'https://github.com/zhu1090093659/dsh-web-ui',
    repositoryFullName: 'zhu1090093659/dsh-web-ui',
    enabled: true,
    builtin: false,
    locked: false,
    compatible: true,
    order: 3,
  },
  {
    packageName: '@liustack/modlens',
    displayName: 'ModLens',
    version: '0.9.4',
    description: '为纯文本智能体提供 OCR、布局和图像语义证据。',
    repository: 'https://github.com/liustack/modlens',
    repositoryFullName: 'liustack/modlens',
    enabled: true,
    builtin: false,
    locked: false,
    compatible: true,
    order: 4,
  },
  {
    packageName: '@deepseek-harness-tui/dsh-tui',
    displayName: 'DSH TUI',
    version: '2.3.0',
    description: 'Claude Code 风格的全屏终端交互界面。',
    repository: 'https://github.com/ccch1mneyyy/dsh-TUI',
    repositoryFullName: 'ccch1mneyyy/dsh-TUI',
    enabled: false,
    builtin: false,
    locked: false,
    compatible: true,
    order: null,
  },
]

const demoRepositories: CatalogRepositoryResult[] = [
  { id: 0, fullName: 'deepseek-ai/deepseek-harness', name: 'deepseek-harness', owner: 'deepseek-ai', description: 'DeepSeek Harness 官方本体。', url: 'https://github.com/deepseek-ai/deepseek-harness', stars: 71883, language: 'TypeScript', updatedAt: '2026-08-14T05:20:00Z', topics: ['dsh-plugin', 'dsh', 'cordis'], defaultBranch: 'master', kind: 'dsh', candidateTypes: [] },
  { id: 1, fullName: 'zhu1090093659/dsh-web-ui', name: 'dsh-web-ui', owner: 'zhu1090093659', description: 'Plugin and skin collection for DeepSeek Harness Web UI.', url: 'https://github.com/zhu1090093659/dsh-web-ui', stars: 863, language: 'TypeScript', updatedAt: '2026-08-14T03:20:00Z', topics: ['dsh-plugin', 'web-ui', 'deepseek-harness'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 2, fullName: 'liustack/modlens', name: 'modlens', owner: 'liustack', description: 'The first vision plugin for DeepSeek Harness.', url: 'https://github.com/liustack/modlens', stars: 829, language: 'TypeScript', updatedAt: '2026-08-14T02:10:00Z', topics: ['dsh-plugin', 'vision', 'ocr'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 3, fullName: 'ccch1mneyyy/dsh-TUI', name: 'dsh-TUI', owner: 'ccch1mneyyy', description: 'Claude Code 风格全屏交互终端插件。', url: 'https://github.com/ccch1mneyyy/dsh-TUI', stars: 443, language: 'TypeScript', updatedAt: '2026-08-14T04:10:00Z', topics: ['dsh-plugin', 'tui', 'terminal'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 4, fullName: 'omdsh-dev/DSH-better-sidebar', name: 'DSH-better-sidebar', owner: 'omdsh-dev', description: '支持文件、终端、Git 和子代理的侧边栏工作台。', url: 'https://github.com/omdsh-dev/DSH-better-sidebar', stars: 337, language: 'TypeScript', updatedAt: '2026-08-13T21:30:00Z', topics: ['dsh-plugin', 'sidebar'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 101, fullName: 'TohsakaRIN521/dsh-academic-skill', name: 'dsh-academic-skill', owner: 'TohsakaRIN521', description: 'Academic writing and verification skills for DSH.', url: 'https://github.com/TohsakaRIN521/dsh-academic-skill', stars: 210, language: 'Python', updatedAt: '2026-08-15T03:20:00Z', topics: ['dsh-skill', 'academic'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['skill'] },
  { id: 102, fullName: 'v587d/dsh-multimodal-skill', name: 'dsh-multimodal-skill', owner: 'v587d', description: 'Multimodal image and audio workflows.', url: 'https://github.com/v587d/dsh-multimodal-skill', stars: 96, language: 'Python', updatedAt: '2026-08-14T23:10:00Z', topics: ['dsh-skill', 'multimodal'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['skill'] },
  { id: 103, fullName: '2BingLing/dsh-market', name: 'dsh-market', owner: '2BingLing', description: '同时提供 Plugin 与 Skill 的 DSH 生态市场。', url: 'https://github.com/2BingLing/dsh-market', stars: 350, language: 'TypeScript', updatedAt: '2026-08-15T02:10:00Z', topics: ['dsh-plugin', 'dsh-skill', 'market'], defaultBranch: 'master', kind: 'repository', candidateTypes: ['plugin', 'skill'] },
  { id: 104, fullName: 'nexu-io/open-design', name: 'open-design', owner: 'nexu-io', description: '普通应用仓库，用于演示错误 topic 的无效候选。', url: 'https://github.com/nexu-io/open-design', stars: 28, sizeKb: 1_788_202, language: 'TypeScript', updatedAt: '2026-08-13T12:10:00Z', topics: ['dsh-plugin'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 105, fullName: 'anywhere-labs/deepseek-harness-desktop', name: 'deepseek-harness-desktop', owner: 'anywhere-labs', description: 'DSH Desktop 原生桌面宿主。', url: 'https://github.com/anywhere-labs/deepseek-harness-desktop', stars: 196, sizeKb: 9_420, language: 'TypeScript', updatedAt: '2026-08-16T08:10:00Z', topics: ['dsh-plugin', 'desktop'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 200, fullName: 'yjh051108/dsh-routing-suite', name: 'dsh-routing-suite', owner: 'yjh051108', description: '内置路由套件：dsh-super-injector、dsh-mode-boost 插件与 dsh-router-standard 预设，一键安装全部组件。', url: 'https://github.com/yjh051108/dsh-routing-suite', stars: 0, language: null, updatedAt: '2026-08-01T00:00:00Z', topics: ['dsh-plugin', 'dsh-skill'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin', 'skill'], featured: true },
  { id: 201, fullName: 'yjh051108/dsh-super-injector', name: 'dsh-super-injector', owner: 'yjh051108', description: '插件注入器（routing-suite 子模块）。', url: 'https://github.com/yjh051108/dsh-super-injector', stars: 0, language: null, updatedAt: '2026-08-01T00:00:00Z', topics: ['dsh-plugin'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 202, fullName: 'yjh051108/dsh-mode-boost', name: 'dsh-mode-boost', owner: 'yjh051108', description: '模式增强（routing-suite 子模块）。', url: 'https://github.com/yjh051108/dsh-mode-boost', stars: 0, language: null, updatedAt: '2026-08-01T00:00:00Z', topics: ['dsh-plugin'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['plugin'] },
  { id: 203, fullName: 'yjh051108/dsh-router-standard', name: 'dsh-router-standard', owner: 'yjh051108', description: '标准路由预设（routing-suite 子模块）。', url: 'https://github.com/yjh051108/dsh-router-standard', stars: 0, language: null, updatedAt: '2026-08-01T00:00:00Z', topics: ['dsh-skill'], defaultBranch: 'main', kind: 'repository', candidateTypes: ['skill'] },
]

let demoInstalledSkills: InstalledSkill[] = []
let demoInstalledApplications: InstalledApplicationAddon[] = [{
  id: 'dsh-tui-host',
  name: 'DSH TUI Host',
  description: '与 DSH TUI Plugin 协同工作的终端应用宿主。',
  repository: 'ccch1mneyyy/dsh-TUI',
  provider: 'npm',
  packageName: '@deepseek-harness-tui/dsh-tui-host',
  version: '2.3.0',
  binName: 'dsh-tui',
  entryPath: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\application-addons\\dsh-tui-host\\index.js',
  installPath: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\application-addons\\dsh-tui-host',
  launchMode: 'after-runtime',
  launchArgs: [],
  enabled: false,
  verified: true,
  provides: ['terminal-host'],
  installedAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
}]
let demoInstalledPresets: InstalledPreset[] = []
let demoDshMarketPlugins: DshMarketCatalog['plugins'] = [
  { name: 'dsh-explorer', owner: 'No-PRM', url: 'https://github.com/No-PRM/dsh-explorer', category: 'ui', description: { zh: 'Git 优先的文件树侧栏。', en: 'Git-first file tree sidebar.' }, npm: null, stars: 2, added: '2026-08-16', install: 'dsh plugin --profile web add github:No-PRM/dsh-explorer', installed: false, enabled: false, version: null, updateAvailable: false, updateVersion: null },
  { name: 'dsh-message-rail', owner: 'wx-yss', url: 'https://github.com/wx-yss/dsh-message-rail', category: 'ui', description: { zh: '会话消息导航栏。', en: 'Session message navigation rail.' }, npm: 'dsh-message-rail', stars: 2, added: '2026-08-15', install: 'dsh plugin --profile web add dsh-message-rail', installed: false, enabled: false, version: null, updateAvailable: false, updateVersion: null },
  { name: 'dsh-web-mobile', owner: 'mexiaosqwq', url: 'https://github.com/mexiaosqwq/dsh-web-mobile', category: 'ui', description: { zh: '移动端 Web UI 适配。', en: 'Mobile-adaptive Web UI.' }, npm: null, stars: 15, added: '2026-08-15', install: 'dsh plugin --profile web add github:mexiaosqwq/dsh-web-mobile', installed: false, enabled: false, version: null, updateAvailable: false, updateVersion: null },
]

let demoRuntime: RuntimeState = { running: false, pid: null, startedAt: null, url: null, port: null }
let demoCredential: CredentialStatus = { configured: false }
let demoCustomApiProviders: CustomApiProvider[] = [{
  route: 'local-ollama',
  displayName: 'Local Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  protocol: 'openai-completions',
  modelIds: ['qwen3:8b'],
  credentialName: null,
  hasApiKey: false,
}]
let demoGitHubAuth: GitHubAuthStatus = {
  authenticated: false,
  login: null,
  name: null,
  avatarUrl: null,
  scopes: [],
  method: null,
  oauthAvailable: true,
  rateLimit: null,
}
const demoStarredRepositories = new Set<string>()
let demoDshInstallation: DshInstallationStatus = { installed: false, version: null, executable: null, source: null }
const demoRemoteDshVersion = '0.1.0-rc.7'
const demoDshCandidates: RuntimeVersionCandidate[] = [
  { version: '0.1.0-rc.7', label: 'latest', lts: null, date: null, prerelease: true },
  { version: '0.1.0-rc.6', label: null, lts: null, date: null, prerelease: true },
]
const demoNodeCandidates: RuntimeVersionCandidate[] = [
  { version: 'v24.19.0', label: 'Krypton', lts: 'Krypton', date: null, prerelease: false },
  { version: 'v22.19.0', label: 'Jod', lts: 'Jod', date: null, prerelease: false },
]
let demoDshVersions: RuntimeEnvironmentState['dshInstalled'] = []
let demoNodeVersions: RuntimeEnvironmentState['nodeInstalled'] = [
  { version: 'system', root: 'C:\\Program Files\\nodejs', executable: 'C:\\Program Files\\nodejs\\node.exe', source: 'system', selected: true, removable: false },
]
/** demo：置 true 可模拟「发现启动器新版本」，验证自更新 UI 与进度条。 */
let demoLauncherUpdateAvailable = false
const demoLauncherVersion = '0.1.9'
let demoOnLauncherUpdateProgress: ((progress: LauncherUpdateProgress) => void) | null = null
const outputListeners = new Set<(output: RuntimeOutput) => void>()
const stateListeners = new Set<(state: RuntimeState) => void>()
const installProgressListeners = new Set<(progress: InstallProgress) => void>()
const catalogAnalysisProgressListeners = new Set<(progress: CatalogAnalysisProgress) => void>()
const pluginTrialListeners = new Set<(result: PluginTrialResult) => void>()
const aiEventListeners = new Set<(event: AiInstallEvent) => void>()
const aiSessionEventListeners = new Set<(event: AiSessionEvent) => void>()
const packProgressListeners = new Set<(event: PackProgressEvent) => void>()
const dshMarketProgressListeners = new Set<(progress: DshMarketProgress) => void>()

function demoDshMarketCatalog(): DshMarketCatalog {
  return {
    updated: '2026-08-16',
    count: demoDshMarketPlugins.length,
    categories: { ui: { zh: 'UI 增强', en: 'UI Enhancements' } },
    plugins: demoDshMarketPlugins.map(plugin => ({ ...plugin, description: { ...plugin.description } })),
  }
}

function dshMarketRepository(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() !== 'github.com') return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`.toLowerCase()
  } catch {
    return null
  }
}

function marketMatchesDemoPlugin(market: DshMarketCatalog['plugins'][number], plugin: ManagedPlugin): boolean {
  const repository = dshMarketRepository(market.url)
  return (repository !== null && plugin.repositoryFullName?.toLowerCase() === repository)
    || (market.npm !== null && plugin.packageName.toLowerCase() === market.npm.toLowerCase())
    || plugin.packageName.toLowerCase() === market.name.toLowerCase()
}

function syncDemoMarketPluginState(plugin: ManagedPlugin): void {
  const market = demoDshMarketPlugins.find(item => marketMatchesDemoPlugin(item, plugin))
  if (market?.installed) market.enabled = plugin.enabled
}

function syncDemoPluginStateFromMarket(market: DshMarketCatalog['plugins'][number]): void {
  demoPlugins = renumber(demoPlugins.map(plugin => marketMatchesDemoPlugin(market, plugin)
    ? { ...plugin, enabled: market.enabled }
    : plugin))
}

function upsertDemoPluginFromMarket(market: DshMarketCatalog['plugins'][number]): void {
  const repository = dshMarketRepository(market.url)
  const packageName = market.npm ?? market.name
  const existing = demoPlugins.findIndex(plugin => marketMatchesDemoPlugin(market, plugin))
  const next: ManagedPlugin = {
    packageName,
    displayName: market.name,
    version: market.version ?? '1.0.0',
    description: market.description.zh ?? market.description.en ?? '来自 DSH Market 的插件。',
    repository: market.url,
    repositoryFullName: repository ?? undefined,
    enabled: market.enabled,
    builtin: false,
    locked: false,
    compatible: true,
    order: null,
  }
  demoPlugins = existing >= 0
    ? demoPlugins.map((plugin, index) => index === existing ? { ...plugin, ...next } : plugin)
    : renumber([...demoPlugins, next])
}

function removeDemoPluginFromMarket(market: DshMarketCatalog['plugins'][number]): void {
  demoPlugins = renumber(demoPlugins.filter(plugin => !marketMatchesDemoPlugin(market, plugin)))
}

let demoPacks: PackStatus[] = [
  {
    id: 'pack-web-basic',
    name: 'Web 基础包',
    description: 'Web 工作台 + UI 集合，日常使用的基础组合。',
    version: '1.0.0',
    dshVersion: '0.1.0-rc.7',
    source: 'created',
    enabled: true,
    state: 'complete',
    plugins: [
      { packageName: '@deepseek-ai/dsh-base', enabled: true },
      { packageName: '@deepseek-ai/dsh-web-app', enabled: true },
      { packageName: '@zhu1090093659/dsh-web-ui', enabled: true },
    ],
    installedAt: '2026-08-10T08:00:00Z',
    updatedAt: '2026-08-12T10:30:00Z',
  },
  {
    id: 'pack-cc-tui',
    name: 'CC TUI 终端包',
    description: '终端交互界面专用组合。',
    version: '0.9.0',
    dshVersion: '0.1.0-rc.7',
    source: 'zip',
    enabled: false,
    state: 'complete',
    plugins: [
      { packageName: '@deepseek-harness-tui/dsh-tui', enabled: false },
      { packageName: '@deepseek-ai/dsh-base', enabled: true },
    ],
    installedAt: '2026-08-11T14:00:00Z',
    updatedAt: '2026-08-11T14:00:00Z',
  },
]
let demoAiStatus: AiInstallStatus = { phase: 'idle', repository: null, taskKind: 'repository-install', subject: null, startedAt: null, sessionId: null, message: '' }
const demoPluginTrials = new Map<string, PluginTrialResult>()
let demoAiResolve: ((allow: boolean) => void) | null = null
let demoAiCancelled = false
let demoAiSessions: AiSession[] = []

function emitDemoSession(event: AiSessionEvent): void {
  aiSessionEventListeners.forEach(listener => listener(event))
}

function demoSession(input: AiSessionCreateInput = {}): AiSession {
  const timestamp = new Date().toISOString()
  const session: AiSession = {
    id: `demo-copilot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind: input.kind ?? 'chat',
    title: input.title ?? (input.kind === 'repository-install' ? 'AI 尝试安装' : '新对话'),
    subject: input.subject ?? null,
    phase: 'idle',
    createdAt: timestamp,
    updatedAt: timestamp,
    queue: { position: null, total: 0, running: false, mutating: false },
    messageCount: 0,
    pendingApproval: null,
    hasSnapshot: false,
    messages: [],
  }
  demoAiSessions = [session, ...demoAiSessions]
  emitDemoSession({ kind: 'session-created', session })
  return session
}

function emitAiEvent(event: AiInstallEvent): void {
  aiEventListeners.forEach(listener => listener(event))
}

function setDemoAiStatus(partial: Partial<AiInstallStatus>): void {
  demoAiStatus = { ...demoAiStatus, ...partial }
  emitAiEvent({ kind: 'status', status: demoAiStatus })
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds))
}

async function demoAnalyzeCatalogRepository(
  fullName: string,
  defaultBranch: string,
): Promise<CatalogRepositoryAnalysis> {
  const checks: CatalogAnalysisProgress['checks'] = {
    plugin: 'pending',
    skill: 'pending',
    application: 'pending',
  }
  const emit = (phase: CatalogAnalysisProgress['phase'], message: string) => {
    catalogAnalysisProgressListeners.forEach(listener => listener({
      repository: fullName,
      phase,
      message,
      completed: Object.values(checks).filter(state => state === 'complete' || state === 'failed').length,
      total: 3,
      checks: { ...checks },
    }))
  }

  emit('preparing', '正在准备仓库结构检测')
  await wait(120)
  checks.plugin = 'running'
  checks.skill = 'running'
  checks.application = 'running'
  emit('checking', '正在检查 Plugin、Skill、应用加载项')

  const completeCheck = async (delay: number, check: keyof typeof checks, message: string) => {
    await wait(delay)
    checks[check] = 'complete'
    emit('checking', message)
  }
  await Promise.all([
    completeCheck(320, 'plugin', 'Plugin 检查完成，正在等待 Skill、应用加载项'),
    completeCheck(620, 'skill', 'Plugin、Skill 检查完成，正在等待应用加载项'),
    completeCheck(900, 'application', '结构检查已完成'),
  ])
  emit('classifying', '正在汇总资源类型和安装入口')
  await wait(180)
  const result = demoCatalogAnalysis(fullName, defaultBranch)
  emit('complete', '资源检测完成')
  return result
}

function profile(): ProfileState {
  return {
    initialized: true,
    profileDir: `${demoSettings.dshHome}\\profiles\\${demoSettings.profileName}`,
    manifestPath: `${demoSettings.dshHome}\\profiles\\${demoSettings.profileName}\\package.json`,
    plugins: demoPlugins,
    activeBundles: demoPlugins.filter(plugin => plugin.enabled).map(plugin => plugin.packageName),
    dependencyCount: demoPlugins.filter(plugin => !plugin.builtin).length,
    disabledCount: demoPlugins.filter(plugin => !plugin.enabled).length,
  }
}

function renumber(plugins: ManagedPlugin[]): ManagedPlugin[] {
  let order = 0
  return plugins.map(plugin => ({ ...plugin, order: plugin.enabled ? ++order : null }))
}

function demoAnalysis(fullName: string, defaultBranch: string): RepositoryAnalysis {
  const repo = demoRepositories.find(item => item.fullName === fullName)
  if (fullName === 'nexu-io/open-design') {
    return { repository: fullName, defaultBranch, installability: 'application', summary: '这是独立应用，不是可加载的 DSH Plugin。', targets: [] }
  }
  if (repo?.candidateTypes.length === 1 && repo.candidateTypes[0] === 'skill') {
    return { repository: fullName, defaultBranch, installability: 'invalid', summary: '没有找到 Cordis Bundle 清单。', targets: [] }
  }
  const packageName = fullName === 'liustack/modlens'
      ? '@liustack/modlens'
      : fullName === 'ccch1mneyyy/dsh-TUI'
        ? '@deepseek-harness-tui/dsh-tui'
        : fullName === 'anywhere-labs/deepseek-harness-desktop'
          ? 'dsh-plugin-desktop'
        : fullName === 'omdsh-dev/DSH-better-sidebar'
        ? 'dsh-better-sidebar'
        : `@${repo?.owner ?? 'demo'}/${(repo?.name ?? 'plugin').toLowerCase()}`
  return {
    repository: fullName,
    defaultBranch,
    installability: 'ready',
    summary: `检测到可安装的 ${packageName}。`,
    targets: [{
      id: `${packageName}:.`,
      packageName,
      version: '1.0.0',
      source: 'npm',
      profileName: packageName === '@deepseek-harness-tui/dsh-tui' ? 'cc-tui' : 'web',
      platform: packageName === '@deepseek-harness-tui/dsh-tui' ? 'terminal' : 'web',
      subdirectory: null,
      commit: 'a'.repeat(40),
      requiresBuild: false,
      buildScripts: [],
      nodeRange: '>=22.19',
    }],
  }
}

function demoSkillAnalysis(fullName: string, defaultBranch: string): SkillRepositoryAnalysis {
  const repo = demoRepositories.find(item => item.fullName === fullName)
  if (!repo?.candidateTypes.includes('skill')) {
    return { repository: fullName, defaultBranch, installability: 'invalid', summary: '没有找到符合 DSH 规范的 SKILL.md 或单文件 Skill。', targets: [] }
  }
  const names = fullName.includes('academic')
    ? ['academic-paper-completion', 'skill-optimizer']
    : fullName === '2BingLing/dsh-market'
      ? ['dsh-market-guide']
      : fullName === 'yjh051108/dsh-router-standard'
        ? ['router-standard']
        : ['multimodal-workflow']
  return {
    repository: fullName,
    defaultBranch,
    installability: names.length > 1 ? 'choice' : 'ready',
    summary: names.length > 1 ? `确认包含 ${names.length} 个有效 DSH Skills。` : `确认是 DSH Skill：${names[0]}`,
    targets: names.map(name => ({
      id: `${name}:${name}/SKILL.md`,
      name,
      description: `Reusable instructions for ${name}.`,
      sourcePath: `${name}/SKILL.md`,
      format: 'bundle',
      revision: defaultBranch,
      modelInvocable: true,
      userInvocable: true,
    })),
  }
}

function demoApplicationAnalysis(fullName: string, defaultBranch: string): ApplicationRepositoryAnalysis {
  if (fullName !== 'anywhere-labs/deepseek-harness-desktop') {
    return { repository: fullName, defaultBranch, installability: 'invalid', summary: '没有找到 .dsh-launcher/addon.json 应用加载项清单。', targets: [] }
  }
  return {
    repository: fullName,
    defaultBranch,
    installability: 'ready',
    summary: '检测到 DSH Desktop 独立宿主，将作为应用加载项安装，不会写入 Web Profile。',
    targets: [{
      id: 'dsh-desktop:.',
      addonId: 'dsh-desktop',
      name: 'DSH Desktop',
      description: '为 DeepSeek Harness 提供原生窗口、托盘、终端与桌面运行时服务。',
      provider: 'npm',
      packageName: 'dsh-plugin-desktop',
      version: '2.0.0',
      binName: 'dsh-plugin-desktop',
      launchMode: 'runtime-replacement',
      launchArgs: [],
      platforms: ['win32', 'darwin', 'linux'],
      supported: true,
      verified: true,
      provides: ['desktopRuntime', 'desktopProfiles', 'desktopPnpmBootstrap'],
    }],
  }
}

function demoCatalogAnalysis(fullName: string, defaultBranch: string): CatalogRepositoryAnalysis {
  if (fullName === 'deepseek-ai/deepseek-harness') {
    return {
      repository: fullName,
      defaultBranch,
      kind: 'dsh',
      componentKinds: [],
      summary: '这是 DeepSeek Harness 官方仓库，将作为 DSH 本体安装。',
      pluginAnalysis: null,
      skillAnalysis: null,
      applicationAnalysis: null,
      warnings: [],
    }
  }
  if (fullName === 'yjh051108/dsh-routing-suite') {
    // 与真实 meta-repo 分析一致：super-injector 走 Release tgz；mode-boost 无 dsh 元数据（官方脚本不装）；
    // router-standard 是 agent-preset 而非 skill（preset/ 目录）。
    const pluginTargets: PluginInstallTarget[] = [
      {
        id: '@yjh051108/dsh-super-injector:.',
        packageName: '@yjh051108/dsh-super-injector',
        version: '0.3.3',
        source: 'release',
        profileName: 'web',
        platform: 'web',
        subdirectory: null,
        commit: 'c'.repeat(40),
        requiresBuild: false,
        buildScripts: [],
        nodeRange: null,
        sourceRepository: 'yjh051108/dsh-super-injector',
        tarballUrl: 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.3/dsh-super-injector-0.3.3.tgz',
      },
    ]
    const skillTargets: SkillInstallTarget[] = []
    const presetTargets: PresetInstallTarget[] = [
      {
        id: 'router-standard:preset/router-standard',
        name: 'router-standard',
        description: 'Standard routing agent preset（含 preset.yml 的 DSH 预设目录）。',
        sourceRepository: 'yjh051108/dsh-router-standard',
        revision: 'e'.repeat(40),
        sourcePath: 'preset/router-standard',
      },
      {
        id: 'router-spec:preset/router-spec',
        name: 'router-spec',
        description: 'Routing spec agent preset（含 preset.yml 的 DSH 预设目录）。',
        sourceRepository: 'yjh051108/dsh-router-standard',
        revision: 'e'.repeat(40),
        sourcePath: 'preset/router-spec',
      },
    ]
    return {
      repository: fullName,
      defaultBranch,
      kind: 'hybrid',
      componentKinds: ['plugin', 'preset'],
      summary: `确认包含 ${pluginTargets.length} 个 Plugin 组件和 ${presetTargets.length} 个 Agent 预设。`,
      pluginAnalysis: {
        repository: fullName,
        defaultBranch,
        installability: 'ready',
        summary: `检测到 ${pluginTargets.length} 个可安装 Plugin 组件。`,
        targets: pluginTargets,
      },
      skillAnalysis: {
        repository: fullName,
        defaultBranch,
        installability: 'invalid',
        summary: '未在子模块中检测到 Skill 组件。',
        targets: skillTargets,
      },
      applicationAnalysis: null,
      presetAnalysis: {
        repository: fullName,
        defaultBranch,
        installability: 'ready',
        summary: `检测到 ${presetTargets.length} 个可安装 Agent 预设。`,
        targets: presetTargets,
      },
      warnings: [],
    }
  }
  const pluginAnalysis = demoAnalysis(fullName, defaultBranch)
  const skillAnalysis = demoSkillAnalysis(fullName, defaultBranch)
  const applicationAnalysis = demoApplicationAnalysis(fullName, defaultBranch)
  const plugin = ['ready', 'choice', 'dynamic'].includes(pluginAnalysis.installability)
  const skill = ['ready', 'choice'].includes(skillAnalysis.installability)
  const application = ['ready', 'choice', 'unsupported'].includes(applicationAnalysis.installability)
  const componentKinds = [plugin ? 'plugin' : null, skill ? 'skill' : null, application ? 'application' : null]
    .filter((kind): kind is 'plugin' | 'skill' | 'application' => kind !== null)
  const kind = componentKinds.length > 1 ? 'hybrid' : componentKinds[0] ?? 'invalid'
  return {
    repository: fullName,
    defaultBranch,
    kind,
    componentKinds,
    summary: kind === 'hybrid'
      ? `确认包含 ${pluginAnalysis.targets.length} 个 Plugin 组件和 ${skillAnalysis.targets.length} 个 Skill 组件。`
      : kind === 'plugin'
        ? pluginAnalysis.summary
        : kind === 'skill'
          ? skillAnalysis.summary
          : kind === 'application'
            ? applicationAnalysis.summary
            : '没有找到符合 DSH 规范的 Plugin、Skill 或应用加载项。',
    pluginAnalysis,
    skillAnalysis,
    applicationAnalysis,
    warnings: [],
  }
}

export const demoApi: LauncherApi = {
  getSettings: async () => demoSettings,
  saveSettings: async settings => (demoSettings = settings),
  detectDshInstallation: async () => ({ ...demoDshInstallation }),
  readRuntimeEnvironment: async (): Promise<RuntimeEnvironmentState> => ({
    dshRoot: demoSettings.dshInstallPath,
    nodeRoot: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\node-runtime',
    dshSelectedVersion: demoSettings.dshVersion ?? null,
    nodeSelectedVersion: demoSettings.nodeVersion ?? null,
    dshInstalled: demoDshVersions,
    nodeInstalled: demoNodeVersions,
    dshAvailable: demoDshCandidates,
    nodeAvailable: demoNodeCandidates,
  }),
  installDshVersion: async version => {
    const normalized = version.replace(/^v/i, '')
    const item = { version: normalized, root: `${demoSettings.dshInstallPath}\\versions\\${normalized}`, executable: `${demoSettings.dshInstallPath}\\versions\\${normalized}\\node_modules\\.bin\\dsh.cmd`, source: 'launcher' as const, selected: true, removable: false }
    demoDshVersions = demoDshVersions.map(entry => ({ ...entry, selected: false, removable: true })).filter(entry => entry.version !== normalized)
    demoDshVersions.push(item)
    demoSettings = { ...demoSettings, dshVersion: normalized, launchExecutable: item.executable, launchArgs: ['web'] }
    demoDshInstallation = { installed: true, version: normalized, executable: item.executable, source: 'launcher' }
    return demoApi.readRuntimeEnvironment()
  },
  selectDshVersion: async version => {
    const item = demoDshVersions.find(entry => entry.version === version.replace(/^v/i, ''))
    if (!item) throw new Error('DSH 版本尚未安装。')
    demoDshVersions = demoDshVersions.map(entry => ({ ...entry, selected: entry.version === item.version, removable: entry.version !== item.version }))
    demoSettings = { ...demoSettings, dshVersion: item.version, launchExecutable: item.executable, launchArgs: ['web'] }
    return demoApi.readRuntimeEnvironment()
  },
  removeDshVersion: async version => {
    if (demoSettings.dshVersion === version.replace(/^v/i, '')) throw new Error('当前 DSH 版本不能删除。')
    demoDshVersions = demoDshVersions.filter(entry => entry.version !== version.replace(/^v/i, ''))
    return demoApi.readRuntimeEnvironment()
  },
  installNodeVersion: async version => {
    const normalized = version.startsWith('v') ? version : `v${version}`
    demoNodeVersions = demoNodeVersions.filter(entry => entry.version !== normalized && entry.version !== 'system')
    demoNodeVersions.push({ version: normalized, root: `C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\node-runtime\\versions\\${normalized}`, executable: `C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\node-runtime\\versions\\${normalized}\\node.exe`, source: 'launcher', selected: true, removable: false })
    demoNodeVersions = demoNodeVersions.map(entry => ({ ...entry, selected: entry.version === normalized, removable: entry.version !== normalized && entry.source === 'launcher' }))
    demoSettings = { ...demoSettings, nodeVersion: normalized }
    return demoApi.readRuntimeEnvironment()
  },
  selectNodeVersion: async version => {
    const normalized = version === null || version === 'system' ? null : (version.startsWith('v') ? version : `v${version}`)
    if (normalized && !demoNodeVersions.some(entry => entry.version === normalized)) throw new Error('Node.js 版本尚未安装。')
    demoSettings = { ...demoSettings, nodeVersion: normalized }
    demoNodeVersions = demoNodeVersions.map(entry => ({ ...entry, selected: normalized === null ? entry.version === 'system' : entry.version === normalized, removable: entry.source === 'launcher' && entry.version !== normalized }))
    return demoApi.readRuntimeEnvironment()
  },
  removeNodeVersion: async version => {
    if (demoSettings.nodeVersion === version) throw new Error('当前 Node.js 版本不能删除。')
    demoNodeVersions = demoNodeVersions.filter(entry => entry.version !== version)
    return demoApi.readRuntimeEnvironment()
  },
  cancelRuntimeEnvironmentOperation: async () => undefined,
  openDshFolder: async () => undefined,
  openNodeFolder: async () => undefined,
  checkDshUpdate: async (): Promise<DshUpdateStatus> => {
    const localVersion = demoDshInstallation.version
    if (!demoDshInstallation.installed || !localVersion) {
      return {
        state: 'not-installed',
        localVersion,
        remoteVersion: null,
        repository: 'deepseek-ai/deepseek-harness',
        checkedAt: new Date().toISOString(),
        message: '尚未安装 DSH。',
      }
    }
    const available = localVersion !== demoRemoteDshVersion
    return {
      state: available ? 'update-available' : 'up-to-date',
      localVersion,
      remoteVersion: demoRemoteDshVersion,
      repository: 'deepseek-ai/deepseek-harness',
      checkedAt: new Date().toISOString(),
      message: available ? `发现 DSH 新版本 ${demoRemoteDshVersion}。` : '当前 DSH 已是最新版本。',
    }
  },
  checkLauncherUpdate: async (): Promise<LauncherUpdateStatus> => {
    const remoteVersion = demoLauncherUpdateAvailable ? '0.1.10' : demoLauncherVersion
    const available = remoteVersion !== demoLauncherVersion
    return {
      state: available ? 'update-available' : 'up-to-date',
      localVersion: demoLauncherVersion,
      remoteVersion,
      releaseUrl: 'https://github.com/rirko/dsh-melody-launcher/releases/latest',
      assetName: `DSH-Launcher-${remoteVersion}-portable.exe`,
      assetSize: available ? 95_731_397 : null,
      checkedAt: new Date().toISOString(),
      message: available ? `发现启动器新版本 ${remoteVersion}。` : '启动器已是最新版本。',
    }
  },
  downloadLauncherUpdate: async (): Promise<LauncherUpdateStatus> => {
    const status: LauncherUpdateStatus = {
      state: 'downloading',
      localVersion: demoLauncherVersion,
      remoteVersion: '0.1.10',
      releaseUrl: 'https://github.com/rirko/dsh-melody-launcher/releases/latest',
      assetName: 'DSH-Launcher-0.1.10-portable.exe',
      assetSize: 95_731_397,
      checkedAt: new Date().toISOString(),
      message: '正在下载启动器新版本…',
    }
    const progress: LauncherUpdateProgress = { phase: 'downloading', percent: 100, downloadedBytes: 95_731_397, totalBytes: 95_731_397 }
    demoOnLauncherUpdateProgress?.(progress)
    return status
  },
  applyLauncherUpdate: async (): Promise<void> => {
    // demo 模式不真正替换可执行文件，仅提示已模拟。
    return
  },
  onLauncherUpdateProgress: listener => {
    demoOnLauncherUpdateProgress = listener
    return () => { demoOnLauncherUpdateProgress = null }
  },
  getDeepSeekCredentialStatus: async () => demoCredential,
  setDeepSeekApiKey: async apiKey => {
    if (!apiKey.trim()) throw new Error('API Key 不能为空。')
    demoCredential = { configured: true }
    return demoCredential
  },
  clearDeepSeekApiKey: async () => {
    demoCredential = { configured: false }
    return demoCredential
  },
  listCustomApiProviders: async () => demoCustomApiProviders.map(provider => ({ ...provider, modelIds: [...provider.modelIds] })),
  saveCustomApiProvider: async input => {
    const route = input.route.trim()
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route)) throw new Error('路由格式无效。')
    const previous = demoCustomApiProviders.find(item => item.route === input.originalRoute)
    const provider: CustomApiProvider = {
      route,
      displayName: input.displayName.trim(),
      baseUrl: input.baseUrl.trim(),
      protocol: input.protocol,
      modelIds: input.modelIds.map(id => id.trim()).filter(Boolean),
      credentialName: input.apiKey?.trim() ? `${route.toUpperCase().replaceAll('-', '_')}_API_KEY` : previous?.credentialName ?? null,
      hasApiKey: Boolean(input.apiKey?.trim()) || previous?.hasApiKey === true,
    }
    demoCustomApiProviders = demoCustomApiProviders.filter(item => item.route !== input.originalRoute && item.route !== route)
    demoCustomApiProviders.push(provider)
    return demoCustomApiProviders
  },
  removeCustomApiProvider: async route => {
    demoCustomApiProviders = demoCustomApiProviders.filter(provider => provider.route !== route)
    return demoCustomApiProviders
  },
  getGitHubAuthStatus: async () => demoGitHubAuth,
  loginGitHubWithToken: async token => {
    if (token.trim().length < 20) throw new Error('GitHub 访问令牌格式无效。')
    demoGitHubAuth = {
      authenticated: true,
      login: 'demo-user',
      name: 'Demo User',
      avatarUrl: null,
      scopes: ['repo', 'workflow', 'read:user'],
      method: 'token',
      oauthAvailable: true,
      rateLimit: { limit: 5000, remaining: 4998, resetAt: new Date(Date.now() + 3600_000).toISOString() },
    }
    return demoGitHubAuth
  },
  beginGitHubDeviceLogin: async () => ({
    userCode: 'DSH-2026',
    verificationUri: 'https://github.com/login/device',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    intervalSeconds: 5,
  }),
  completeGitHubDeviceLogin: async () => {
    await wait(900)
    demoGitHubAuth = {
      authenticated: true,
      login: 'demo-user',
      name: 'Demo User',
      avatarUrl: null,
      scopes: ['repo', 'workflow', 'read:user', 'user:email'],
      method: 'oauth',
      oauthAvailable: true,
      rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600_000).toISOString() },
    }
    return demoGitHubAuth
  },
  cancelGitHubDeviceLogin: async () => undefined,
  logoutGitHub: async () => {
    demoGitHubAuth = {
      authenticated: false,
      login: null,
      name: null,
      avatarUrl: null,
      scopes: [],
      method: null,
      oauthAvailable: true,
      rateLimit: null,
    }
    return demoGitHubAuth
  },
  listGitHubPullRequests: async (): Promise<GitHubPullRequestSummary[]> => demoGitHubAuth.authenticated ? [{
    number: 42,
    title: 'catalog: batch update',
    url: 'https://github.com/rirko/dsh-melody-launcher/pull/42',
    state: 'open',
    draft: false,
    author: demoGitHubAuth.login ?? 'demo-user',
    createdAt: '2026-08-17T08:00:00Z',
    updatedAt: '2026-08-18T08:00:00Z',
    mergedAt: null,
    headBranch: 'plugin-update',
    baseBranch: 'main',
  }] : [],
  getGitHubStarStatus: async repository => demoStarredRepositories.has(repository.toLowerCase()),
  setGitHubStar: async (repository, starred) => {
    const key = repository.toLowerCase()
    if (starred) demoStarredRepositories.add(key)
    else demoStarredRepositories.delete(key)
    return starred
  },
  chooseDirectory: async kind => kind === 'dshInstallPath'
    ? 'D:\\DeepSeek Harness'
    : kind === 'dshHome'
      ? 'C:\\Users\\demo\\.dsh'
      : 'C:\\Users\\demo\\Projects',
  readProfile: async () => profile(),
  listProfiles: async () => [{
    id: demoSettings.profileName,
    name: demoSettings.profileName,
    description: '浏览器演示 Profile',
    dshVersion: demoSettings.dshVersion ?? '0.1.0-rc.7',
    source: { kind: 'local' as const },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    profileDir: `${demoSettings.dshHome}\\profiles\\${demoSettings.profileName}`,
    initialized: true,
    pluginCount: profile().dependencyCount,
    enabledPluginCount: profile().plugins.filter(plugin => !plugin.builtin && plugin.enabled).length,
    disabledPluginCount: profile().disabledCount,
    missingDependencies: [],
    hasNodeModules: true,
    selected: true,
  }],
  createProfile: async request => {
    if (request.name === demoSettings.profileName) throw new Error(`Profile「${request.name}」已存在。`)
    return {
      id: request.name,
      name: request.name,
      description: request.description ?? '',
      dshVersion: request.dshVersion ?? demoSettings.dshVersion ?? null,
      source: { kind: 'local' as const },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      profileDir: `${demoSettings.dshHome}\\profiles\\${request.name}`,
      initialized: true,
      pluginCount: 0,
      enabledPluginCount: 0,
      disabledPluginCount: 0,
      missingDependencies: [],
      hasNodeModules: false,
      selected: false,
    }
  },
  cloneProfile: async (sourceName, targetName, description) => {
    const result = await demoApi.createProfile({ name: targetName, cloneFrom: sourceName, description })
    return { ...result, pluginCount: profile().dependencyCount, enabledPluginCount: profile().dependencyCount }
  },
  switchProfile: async (profileName, _options) => {
    demoSettings = { ...demoSettings, profileName, activePackId: undefined }
    return demoSettings
  },
  deleteProfile: async profileName => {
    if (profileName === demoSettings.profileName) throw new Error('当前 Profile 不能删除。')
  },
  readProfileMetadata: async profileName => {
    const list = await demoApi.listProfiles()
    const found = list.find(item => item.id === profileName)
    if (!found) throw new Error(`Profile「${profileName}」不存在。`)
    return found
  },
  exportProfile: async profileName => `C:\\Users\\demo\\Desktop\\${profileName}.zip`,
  importProfile: async (_filePath, options) => demoApi.createProfile({ name: options?.name ?? 'imported-profile' }),
  analyzeProfileRepository: async url => {
    const parsed = parseGitHubImportUrl(url)
    return {
      repository: parsed.fullName,
      branch: parsed.defaultBranch ?? 'main',
      commit: 'demo000000000000000000000000000000000000',
      manifestPath: 'dsh-profile.yaml' as const,
      profileName: 'pack-demo',
      description: '演示 GitHub Profile 仓库。',
      version: '1.0.0',
      dshVersion: demoSettings.dshVersion ?? '0.1.0-rc.7',
      dshVersionInstalled: true,
      plugins: [{
        packageName: 'dsh-demo-plugin', enabled: true, order: 0, source: 'npm' as const,
        repository: null, version: '0.1.0', commit: null, match: 'declared' as const, candidates: [],
      }],
      hasFullPackage: true,
      fullPackagePluginBodies: [],
      differences: [],
      blockers: [],
    }
  },
  importProfileRepository: async (_url, options) => demoApi.createProfile({ name: options.name ?? 'imported-profile' }),
  matchProfilePlugin: async packageName => ({ packageName, source: 'npm', enabled: true }),
  togglePlugin: async (packageName, enabled) => {
    const selected = demoPlugins.find(plugin => plugin.packageName === packageName)
    demoPlugins = renumber(demoPlugins.map(plugin => plugin.packageName === packageName ? { ...plugin, enabled } : plugin))
    const linked = Boolean(selected?.repositoryFullName && demoInstalledApplications.some(application =>
      application.repository.toLowerCase() === selected.repositoryFullName?.toLowerCase(),
    ))
    if (selected?.repositoryFullName) {
      demoInstalledApplications = demoInstalledApplications.map(application =>
        application.repository.toLowerCase() === selected.repositoryFullName?.toLowerCase()
          ? { ...application, enabled }
          : application,
      )
    }
    if (selected) syncDemoMarketPluginState({ ...selected, enabled })
    return { profile: profile(), installedApplications: demoInstalledApplications, linked }
  },
  reorderPlugins: async packageNames => {
    const active = packageNames.map(name => demoPlugins.find(plugin => plugin.packageName === name)!).filter(Boolean)
    const inactive = demoPlugins.filter(plugin => !plugin.enabled)
    demoPlugins = renumber([...active, ...inactive])
    return profile()
  },
  discoverCatalog: async (query, sort, page): Promise<CatalogDiscoveryResult> => {
    const needle = query.trim().toLowerCase()
    const matchingRepositories = demoRepositories
      // 演示目录与真实目录保持一致：不再把仅有 dsh-skill 来源的仓库
      // 当作独立市场结果，但混合仓库仍然保留并在检测后识别 Skill 组件。
      .filter(repo => repo.kind === 'dsh' || repo.candidateTypes.some(type => type !== 'skill'))
      .filter(repo => !needle || `${repo.fullName} ${repo.description}`.toLowerCase().includes(needle))
      .sort((a, b) => sort === 'stars' ? b.stars - a.stars : b.updatedAt.localeCompare(a.updatedAt))
    const start = (Math.max(1, page) - 1) * 30
    const repositories = matchingRepositories.slice(start, start + 30)
    return {
      repositories,
      topicTotals: { plugin: 3_257, skill: 0, application: 8 },
      page: Math.max(1, page),
      pageCount: 34,
      rateRemaining: 9,
      warnings: [],
      dshInstallation: demoDshInstallation,
      installedRepositories: demoPlugins.map(plugin => plugin.repositoryFullName).filter((value): value is string => Boolean(value)),
      installedSkills: demoInstalledSkills,
      installedApplications: demoInstalledApplications,
      installedPresets: demoInstalledPresets,
    }
  },
  refreshCatalogIndex: async (): Promise<CatalogIndexEntry[]> => demoRepositories.map(repository => {
    const analysis = demoCatalogAnalysis(repository.fullName, repository.defaultBranch)
    const tags = analysis.kind === 'dsh'
      ? ['dsh']
      : analysis.kind === 'invalid'
        ? ['invalid']
        : analysis.componentKinds.map(kind => kind === 'application' ? 'runtime' : kind)
    return {
      repository: repository.fullName,
      defaultBranch: repository.defaultBranch,
      repositoryUpdatedAt: repository.updatedAt,
      tags: tags as CatalogIndexEntry['tags'],
    }
  }),
  analyzeCatalogRepository: demoAnalyzeCatalogRepository,
  importCatalogUrl: async (url): Promise<CatalogImportResult> => {
    const parsed = parseGitHubImportUrl(url)
    const branch = parsed.defaultBranch
    const existing = demoRepositories.find(repo => repo.fullName.toLowerCase() === parsed.fullName.toLowerCase())
    const repository: CatalogRepositoryResult = existing
      ? { ...existing, defaultBranch: branch ?? existing.defaultBranch }
      : {
          id: -Math.abs(parsed.fullName.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0)),
          fullName: parsed.fullName,
          name: parsed.fullName.split('/')[1],
          owner: parsed.fullName.split('/')[0],
          description: '通过 GitHub 链接导入的仓库。',
          url: `https://github.com/${parsed.fullName}`,
          stars: 0,
          language: null,
          updatedAt: new Date().toISOString(),
          topics: [],
          defaultBranch: branch ?? 'main',
          kind: parsed.fullName.toLowerCase() === DSH_REPOSITORY ? 'dsh' : 'repository',
          candidateTypes: [],
        }
    const analysis = demoCatalogAnalysis(parsed.fullName, branch ?? repository.defaultBranch)
    return { repository, analysis }
  },
  loadDshMarket: async (): Promise<DshMarketCatalog> => {
    dshMarketProgressListeners.forEach(listener => listener({ name: '', phase: 'loading', percent: null, message: '正在读取 dsh-market 精选目录' }))
    await wait(180)
    return demoDshMarketCatalog()
  },
  installDshMarketPlugin: async name => {
    const plugin = demoDshMarketPlugins.find(item => item.name === name)
    if (!plugin) throw new Error('插件不在 dsh-market 精选目录中。')
    dshMarketProgressListeners.forEach(listener => listener({ name, phase: 'downloading', percent: 52, message: '正在下载插件及依赖' }))
    await wait(500)
    plugin.installed = true; plugin.enabled = true; plugin.version = '1.0.0'
    upsertDemoPluginFromMarket(plugin)
    return demoDshMarketPlugins.filter(item => item.installed)
  },
  updateDshMarketPlugin: async name => {
    const plugin = demoDshMarketPlugins.find(item => item.name === name)
    if (!plugin?.installed) throw new Error('插件尚未安装，不能更新。')
    dshMarketProgressListeners.forEach(listener => listener({ name, phase: 'verifying', percent: 86, message: '正在检查插件更新' }))
    await wait(450)
    plugin.updateAvailable = false; plugin.updateVersion = null
    upsertDemoPluginFromMarket(plugin)
    return demoDshMarketPlugins.filter(item => item.installed)
  },
  uninstallDshMarketPlugin: async name => {
    const plugin = demoDshMarketPlugins.find(item => item.name === name)
    if (!plugin?.installed) throw new Error('插件尚未安装。')
    await wait(300)
    plugin.installed = false; plugin.enabled = false; plugin.version = null
    removeDemoPluginFromMarket(plugin)
    return demoDshMarketPlugins.filter(item => item.installed)
  },
  toggleDshMarketPlugin: async (name, enabled) => {
    const plugin = demoDshMarketPlugins.find(item => item.name === name)
    if (!plugin?.installed) throw new Error('插件尚未安装。')
    plugin.enabled = enabled
    syncDemoPluginStateFromMarket(plugin)
    return demoDshMarketPlugins.filter(item => item.installed)
  },
  checkDshMarketUpdates: async (): Promise<Record<string, { kind: 'npm'; current: string | null; latest: string | null; updateAvailable: boolean }>> => ({}),
  installPlugin: async request => {
    const fullName = typeof request === 'string' ? request : request.repository
    const repo = demoRepositories.find(item => item.fullName === fullName)
    const kind = repo?.kind === 'dsh' ? 'dsh' : 'plugin'
    installProgressListeners.forEach(listener => listener({ repository: fullName, kind, phase: 'resolving', percent: 18, message: kind === 'dsh' ? '正在解析 DSH 安装包' : '正在解析插件仓库' }))
    await wait(350)
    installProgressListeners.forEach(listener => listener({ repository: fullName, kind, phase: 'downloading', percent: 28, message: kind === 'dsh' ? '正在下载并安装 DSH' : '正在下载并安装插件', indeterminate: true, downloadedBytes: 19_341_312 }))
    await wait(900)
    installProgressListeners.forEach(listener => listener({ repository: fullName, kind, phase: 'configuring', percent: 90, message: kind === 'dsh' ? '正在切换本地启动命令' : '正在更新插件配置' }))
    await wait(350)
    if (kind === 'dsh') {
      demoDshInstallation = { installed: true, version: '0.1.0-rc.6', executable: `${demoSettings.dshInstallPath}\\node_modules\\.bin\\dsh.cmd`, source: 'launcher' }
      demoSettings = { ...demoSettings, launchExecutable: demoDshInstallation.executable!, launchArgs: ['web'] }
    } else if (repo && !demoPlugins.some(plugin => plugin.repositoryFullName === fullName)) {
      demoPlugins = renumber([...demoPlugins, {
        packageName: `@${repo.owner}/${repo.name.toLowerCase()}`,
        displayName: repo.name,
        version: 'github',
        description: repo.description,
        repository: repo.url,
        repositoryFullName: repo.fullName,
        enabled: true,
        builtin: false,
        locked: false,
        compatible: true,
        order: 0,
      }])
    }
    installProgressListeners.forEach(listener => listener({ repository: fullName, kind, phase: 'complete', percent: 100, message: kind === 'dsh' ? 'DSH 已安装' : '插件安装完成' }))
    const analysis = kind === 'plugin' ? demoAnalysis(fullName, repo?.defaultBranch ?? 'main') : null
    return {
      kind,
      profile: profile(),
      settings: demoSettings,
      dshInstallation: demoDshInstallation,
      installedProfileName: analysis?.targets[0].profileName,
      packageName: analysis?.targets[0].packageName,
    }
  },
  uninstallPlugin: async packageName => {
    demoPlugins = renumber(demoPlugins.filter(plugin => plugin.packageName !== packageName))
    return profile()
  },
  trialPlugin: async (packageName, profileName = demoSettings.profileName) => {
    const startedAt = new Date().toISOString()
    const running: PluginTrialResult = {
      packageName, profileName, phase: 'running', message: '正在隔离启动 DSH 核心与当前插件…', diagnostics: '',
      startedAt, testedAt: null, durationMs: null, url: null,
    }
    pluginTrialListeners.forEach(listener => listener(running))
    await wait(900)
    const failed = packageName.includes('desktop') || packageName.includes('tui')
    const failureDiagnostic = packageName.includes('desktop')
      ? 'dsh-plugin-desktop: pending (waiting for service: desktopRuntime)'
      : 'terminal plugin cannot activate inside the isolated web host'
    const result: PluginTrialResult = {
      ...running,
      phase: failed ? 'failed' : 'passed',
      message: failed ? '插件依赖当前隔离 Web 宿主未提供的服务。' : '隔离 Web 服务已启动，插件通过试运行。',
      diagnostics: failed ? failureDiagnostic : 'Web service listening on http://127.0.0.1:3180/',
      testedAt: new Date().toISOString(),
      durationMs: 900,
      url: failed ? null : 'http://127.0.0.1:3180/',
    }
    demoPluginTrials.set(`${profileName}:${packageName}`, result)
    pluginTrialListeners.forEach(listener => listener(result))
    return result
  },
  readPluginTrials: async () => [...demoPluginTrials.values()],
  installSkill: async request => {
    const analysis = demoSkillAnalysis(request.repository, request.defaultBranch)
    const target = analysis.targets.find(item => item.id === request.targetId)
    if (!target) throw new Error('Skill 安装目标无效。')
    installProgressListeners.forEach(listener => listener({ repository: request.repository, kind: 'skill', phase: 'downloading', percent: 42, message: '正在下载 Skill' }))
    await wait(500)
    const installedSkill: InstalledSkill = {
      name: target.name,
      description: target.description,
      path: `${demoSettings.dshHome}\\skills\\${target.name}`,
      format: target.format,
      enabled: true,
      modelInvocable: target.modelInvocable,
      userInvocable: target.userInvocable,
    }
    demoInstalledSkills = [...demoInstalledSkills.filter(skill => skill.name !== target.name), installedSkill]
    installProgressListeners.forEach(listener => listener({ repository: request.repository, kind: 'skill', phase: 'complete', percent: 100, message: `${target.name} 已安装` }))
    return { installedSkill, installedSkills: demoInstalledSkills }
  },
  readInstalledSkills: async () => demoInstalledSkills,
  toggleSkill: async (name, enabled) => {
    demoInstalledSkills = demoInstalledSkills.map(skill => skill.name === name ? { ...skill, enabled } : skill)
    return demoInstalledSkills
  },
  installApplication: async request => {
    const analysis = demoApplicationAnalysis(request.repository, request.defaultBranch)
    const target = analysis.targets.find(item => item.id === request.targetId)
    if (!target) throw new Error('应用加载项目标无效。')
    installProgressListeners.forEach(listener => listener({ repository: request.repository, kind: 'application', phase: 'downloading', percent: 28, message: `正在下载并安装 ${target.name}`, indeterminate: true }))
    await wait(650)
    const now = new Date().toISOString()
    const installedAddon: InstalledApplicationAddon = {
      id: target.addonId,
      name: target.name,
      description: target.description,
      repository: request.repository,
      provider: target.provider,
      packageName: target.packageName,
      version: target.version ?? '2.0.0',
      binName: target.binName,
      entryPath: `C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\application-addons\\${target.addonId}\\runtime\\node_modules\\${target.packageName}\\lib\\bin.js`,
      installPath: `C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher\\application-addons\\${target.addonId}`,
      launchMode: target.launchMode,
      launchArgs: target.launchArgs,
      enabled: true,
      verified: target.verified,
      provides: target.provides,
      installedAt: demoInstalledApplications.find(item => item.id === target.addonId)?.installedAt ?? now,
      updatedAt: now,
    }
    demoInstalledApplications = demoInstalledApplications
      .filter(item => item.id !== installedAddon.id)
      .map(item => installedAddon.launchMode === 'runtime-replacement' && item.launchMode === 'runtime-replacement' ? { ...item, enabled: false } : item)
    demoInstalledApplications.push(installedAddon)
    installProgressListeners.forEach(listener => listener({ repository: request.repository, kind: 'application', phase: 'complete', percent: 100, message: `${target.name} 已作为应用加载项安装` }))
    return { installedAddon, installedAddons: demoInstalledApplications, profile: profile() }
  },
  readInstalledApplications: async () => demoInstalledApplications,
  toggleApplication: async (id, enabled) => {
    const selected = demoInstalledApplications.find(application => application.id === id)
    demoInstalledApplications = demoInstalledApplications.map(application => {
      if (application.id === id) return { ...application, enabled }
      if (enabled && selected?.launchMode === 'runtime-replacement' && application.launchMode === 'runtime-replacement') return { ...application, enabled: false }
      return application
    })
    const linked = Boolean(selected && demoPlugins.some(plugin =>
      plugin.repositoryFullName?.toLowerCase() === selected.repository.toLowerCase(),
    ))
    if (selected) {
      demoPlugins = renumber(demoPlugins.map(plugin =>
        plugin.repositoryFullName?.toLowerCase() === selected.repository.toLowerCase()
          ? { ...plugin, enabled }
          : plugin,
      ))
    }
    return { profile: profile(), installedApplications: demoInstalledApplications, linked }
  },
  uninstallApplication: async id => {
    demoInstalledApplications = demoInstalledApplications.filter(application => application.id !== id)
    return demoInstalledApplications
  },
  installPreset: async request => {
    const repo = demoRepositories.find(item => item.fullName === request.repository)
    const analysis = demoCatalogAnalysis(request.repository, repo?.defaultBranch ?? 'main')
    const target = analysis.presetAnalysis?.targets.find(item => item.id === request.targetId)
    if (!target) throw new Error('预设安装目标无效。')
    installProgressListeners.forEach(listener => listener({ repository: request.repository, kind: 'preset', phase: 'downloading', percent: 42, message: '正在下载 Agent 预设' }))
    await wait(500)
    const installedPreset: InstalledPreset = {
      name: target.name,
      path: `${demoSettings.dshHome}\\.agent-presets\\${target.name}`,
      enabled: true,
    }
    demoInstalledPresets = [...demoInstalledPresets.filter(preset => preset.name !== target.name), installedPreset]
    installProgressListeners.forEach(listener => listener({ repository: request.repository, kind: 'preset', phase: 'complete', percent: 100, message: `${target.name} 已安装` }))
    return { installedPreset, installedPresets: demoInstalledPresets }
  },
  readInstalledPresets: async () => demoInstalledPresets,
  togglePreset: async (name, enabled) => {
    demoInstalledPresets = demoInstalledPresets.map(preset => preset.name === name ? { ...preset, enabled } : preset)
    return demoInstalledPresets
  },
  getRuntimeState: async () => demoRuntime,
  startRuntime: async () => {
    const replacement = demoInstalledApplications.find(application => application.enabled && application.launchMode === 'runtime-replacement')
    demoRuntime = replacement
      ? { running: true, pid: 18420, startedAt: new Date().toISOString(), url: null, port: null, launchMode: 'application-replacement', applicationAddonId: replacement.id, applicationAddonName: replacement.name }
      : { running: true, pid: 18420, startedAt: new Date().toISOString(), url: `http://127.0.0.1:${demoSettings.webPort}`, port: demoSettings.webPort, launchMode: 'web', applicationAddonId: null, applicationAddonName: null }
    stateListeners.forEach(listener => listener(demoRuntime))
    outputListeners.forEach(listener => listener({ channel: 'runtime', level: 'success', text: replacement ? `${replacement.name} 已启动。` : `DeepSeek Harness Web UI: http://127.0.0.1:${demoSettings.webPort}`, timestamp: new Date().toISOString() }))
    return demoRuntime
  },
  stopRuntime: async () => {
    demoRuntime = { ...demoRuntime, running: false, pid: null, port: null }
    stateListeners.forEach(listener => listener(demoRuntime))
    return demoRuntime
  },
  openExternal: async () => undefined,
  openPath: async () => undefined,
  setWindowMode: async () => undefined,
  minimizeWindow: async () => undefined,
  toggleMaximizeWindow: async () => false,
  closeWindow: async () => undefined,
  onRuntimeOutput: listener => {
    outputListeners.add(listener)
    return () => outputListeners.delete(listener)
  },
  onRuntimeState: listener => {
    stateListeners.add(listener)
    return () => stateListeners.delete(listener)
  },
  onInstallProgress: listener => {
    installProgressListeners.add(listener)
    return () => installProgressListeners.delete(listener)
  },
  onPluginTrialEvent: listener => {
    pluginTrialListeners.add(listener)
    return () => pluginTrialListeners.delete(listener)
  },
  aiInstall: async input => {
    demoAiCancelled = false
    setDemoAiStatus({ phase: 'preparing', repository: input.repository, taskKind: 'repository-install', subject: input.repository, startedAt: new Date().toISOString(), sessionId: null, message: '正在准备 ACP 运行时…' })
    emitAiEvent({ kind: 'log', text: `开始研究 ${input.repository}（分支 ${input.defaultBranch}）` })
    await wait(500)
    emitAiEvent({ kind: 'snapshot', snapshotId: `demo-${Date.now()}` })
    emitAiEvent({ kind: 'log', text: '已为当前 profile 生成配置快照。' })
    setDemoAiStatus({ phase: 'running', sessionId: 'demo-session', message: 'AI 正在研究仓库并尝试安装…' })
    await wait(700)
    emitAiEvent({ kind: 'log', text: '读取仓库结构，确认组件形态…' })
    emitAiEvent({ kind: 'auto-approved', toolName: 'read_file', reason: '只读操作，自动放行' })
    await wait(400)
    emitAiEvent({ kind: 'log', text: '发现组件位于 `packages/web-app`，需要写入 profile 配置。' })
    emitAiEvent({ kind: 'approval', request: { id: 'demo-1', toolName: 'bash', toolKind: 'bash', args: 'dsh plugin add @demo/dsh-web-app --profile web', reason: '写文件或运行安装命令，需要确认' } })
    // 挂起等待 aiApprove 裁决；取消由 aiCancel 兜底（resolve(false) 并置 cancelled）。
    const allowed = await new Promise<boolean>(resolve => {
      demoAiResolve = resolve
    })
    if (demoAiCancelled) return { ok: false, message: '用户已取消' }
    emitAiEvent({ kind: 'log', text: allowed ? '已批准安装命令。' : '已拒绝安装命令。' })
    if (allowed) {
      setDemoAiStatus({ phase: 'done', message: 'AI 已完成研究并安装组件。' })
      emitAiEvent({ kind: 'log', text: '组件已写入 profile，安装完成。' })
      emitAiEvent({ kind: 'done', message: 'AI 已完成研究并安装组件。请检查改动；不满意可还原快照。' })
      return { ok: true, message: 'AI 已完成研究并安装组件。' }
    }
    setDemoAiStatus({ phase: 'done', message: 'AI 已完成研究，但安装命令被拒绝。' })
    emitAiEvent({ kind: 'done', message: '安装命令被拒绝，任务结束。快照仍保留，可还原。' })
    return { ok: false, message: '安装命令被拒绝。' }
  },
  aiAdaptPlugin: async input => {
    setDemoAiStatus({ phase: 'preparing', repository: null, taskKind: 'plugin-adaptation', subject: input.packageName, startedAt: new Date().toISOString(), sessionId: null, message: '正在准备插件适配环境…' })
    emitAiEvent({ kind: 'log', text: `正在读取 ${input.packageName} 的隔离试运行诊断。` })
    await wait(500)
    setDemoAiStatus({ phase: 'running', sessionId: 'demo-adaptation', message: 'AI 正在分析试运行诊断并尝试适配插件…' })
    emitAiEvent({ kind: 'log', text: '检测到插件依赖当前 Web 宿主没有提供的服务，建议从 Web bundles 中安全停用。' })
    await wait(700)
    setDemoAiStatus({ phase: 'done', message: 'AI 已完成插件适配分析。' })
    emitAiEvent({ kind: 'done', message: 'AI 已完成分析与修复尝试。请检查结论和改动。' })
    return { ok: true, message: 'AI 已完成插件适配分析。' }
  },
  aiRepairRuntime: async () => {
    setDemoAiStatus({ phase: 'preparing', repository: null, taskKind: 'runtime-repair', subject: demoSettings.profileName, startedAt: new Date().toISOString(), sessionId: null, message: '正在准备启动修复环境…' })
    await wait(500)
    setDemoAiStatus({ phase: 'running', sessionId: 'demo-runtime-repair', message: 'AI 正在分析启动诊断并尝试修复…' })
    emitAiEvent({ kind: 'log', text: '正在检查 Profile 的 Bundle 加载顺序和宿主服务依赖。' })
    await wait(700)
    setDemoAiStatus({ phase: 'done', message: 'AI 已完成启动修复。' })
    emitAiEvent({ kind: 'done', message: 'AI 已完成分析与修复尝试。请重新启动验证。' })
    return { ok: true, message: 'AI 已完成启动修复。' }
  },
  aiApprove: async (requestId, allow) => {
    if (requestId !== 'demo-1' || !demoAiResolve) return false
    demoAiResolve(Boolean(allow))
    demoAiResolve = null
    return true
  },
  aiCancel: async () => {
    demoAiCancelled = true
    if (demoAiResolve) {
      demoAiResolve(false)
      demoAiResolve = null
    }
    setDemoAiStatus({ phase: 'cancelled', message: '用户已取消' })
    emitAiEvent({ kind: 'cancelled', message: '用户已取消任务。快照仍保留，可还原。' })
  },
  aiRollback: async () => {
    emitAiEvent({ kind: 'log', text: '正在还原快照…' })
    await wait(400)
    emitAiEvent({ kind: 'log', text: '配置已还原到任务前状态。' })
    return { restored: 2, profileName: demoSettings.profileName }
  },
  aiStatus: async () => demoAiStatus,
  aiHasSnapshot: async () => demoAiStatus.phase !== 'idle',
  listAiSessions: async () => demoAiSessions.map(session => ({ ...session, messages: session.messages.map(message => ({ ...message })) })),
  createAiSession: async input => demoSession(input),
  sendAiSessionMessage: async (sessionId, text) => {
    const session = demoAiSessions.find(item => item.id === sessionId)
    if (!session) throw new Error('DSH Copilot 会话不存在。')
    const userMessage: AiMessage = { id: `user-${Date.now()}`, role: 'user', text, createdAt: new Date().toISOString() }
    session.messages.push(userMessage)
    session.phase = 'running'
    session.updatedAt = new Date().toISOString()
    session.messageCount = session.messages.length
    emitDemoSession({ kind: 'message', sessionId, message: userMessage })
    emitDemoSession({ kind: 'session-updated', session })
    window.setTimeout(() => {
      const message: AiMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: `已收到：${text}\n\n这是浏览器演示模式中的 DSH Copilot 回复。`,
        createdAt: new Date().toISOString(),
      }
      session.messages.push(message)
      session.phase = 'done'
      session.updatedAt = new Date().toISOString()
      session.messageCount = session.messages.length
      emitDemoSession({ kind: 'message', sessionId, message })
      emitDemoSession({ kind: 'session-updated', session })
    }, 600)
    return session
  },
  cancelAiSession: async sessionId => {
    const session = demoAiSessions.find(item => item.id === sessionId)
    if (session) {
      session.phase = 'cancelled'
      emitDemoSession({ kind: 'session-updated', session })
    }
  },
  approveAiSession: async () => true,
  rollbackAiSession: async () => ({ restored: 2, profileName: demoSettings.profileName }),
  deleteAiSession: async sessionId => {
    demoAiSessions = demoAiSessions.filter(item => item.id !== sessionId)
    emitDemoSession({ kind: 'deleted', sessionId })
  },
  listPacks: async () => demoPacks.map(pack => ({ ...pack, plugins: pack.plugins.map(plugin => ({ ...plugin })) })),
  createPack: async request => {
    const now = new Date().toISOString()
    const id = `pack-${request.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'}`
    const pack: PackStatus = {
      id,
      name: request.name,
      description: request.description ?? '',
      version: '1.0.0',
      dshVersion: request.dshVersion ?? demoSettings.dshVersion ?? '0.1.0-rc.7',
      source: 'created',
      enabled: true,
      state: 'complete',
      plugins: request.packageNames.map(packageName => ({ packageName, enabled: true })),
      ...(request.presetNames?.length ? { presets: request.presetNames.map(name => ({ name, enabled: true })) } : {}),
      installedAt: now,
      updatedAt: now,
    }
    demoPacks = [...demoPacks.filter(item => item.id !== id), pack]
    return { id, installed: [...request.packageNames, ...(request.presetNames ?? [])], failures: [], state: 'complete' }
  },
  analyzePackImport: async () => ({
    // demo 无法读真实 zip，返回 raw 形态样例以演练扫描导入 UI（含可编辑包名）。
    id: '',
    name: '',
    description: '非标准整合包：扫描到 2 个插件、1 个技能。',
    version: '1.0.0',
    dshVersion: null,
    source: 'raw',
    items: [
      { packageName: 'dsh-anchored-standard', available: true, offline: true },
      { packageName: 'dsh-router-standard', available: true, offline: true },
      { packageName: 'git-workflow', available: true, offline: true, kind: 'skill' },
    ],
  }),
  importPack: async (_path, items, _options) => {
    const installed = items?.length ? items : ['dsh-anchored-standard', 'dsh-router-standard', 'git-workflow']
    return { id: 'pack-import-demo', installed, failures: [], state: 'complete' }
  },
  exportPack: async packId => {
    const pack = demoPacks.find(item => item.id === packId)
    return pack ? `C:\\Users\\demo\\Desktop\\${pack.name}.zip` : null
  },
  pickPackFile: async () => 'C:\\Users\\demo\\Downloads\\example-pack.zip',
  activatePack: async packId => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    demoPacks = demoPacks.map(item => ({ ...item, enabled: item.id === packId }))
    demoSettings = { ...demoSettings, activePackId: packId }
    return demoSettings
  },
  deactivatePack: async () => {
    demoPacks = demoPacks.map(item => ({ ...item, enabled: false }))
    demoSettings = { ...demoSettings, activePackId: null }
    return demoSettings
  },
  removePack: async packId => {
    const before = demoPacks.length
    demoPacks = demoPacks.filter(item => item.id !== packId)
    return { removed: before - demoPacks.length }
  },
  rollbackPack: async () => ({ restored: 1, profileName: demoSettings.profileName }),
  packHasSnapshot: async () => false,
  addPackPlugin: async (packId, packageName) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const updated: PackStatus = {
      ...pack,
      plugins: pack.plugins.some(plugin => plugin.packageName === packageName)
        ? pack.plugins
        : [...pack.plugins, { packageName, enabled: true }],
      updatedAt: new Date().toISOString(),
    }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  addPackPreset: async (packId, presetName) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const presets = pack.presets?.some(preset => preset.name === presetName)
      ? pack.presets
      : [...(pack.presets ?? []), { name: presetName, enabled: true }]
    const updated: PackStatus = { ...pack, presets, updatedAt: new Date().toISOString() }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  addPackSkill: async (packId, skillName) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const skills = pack.skills?.some(skill => skill.name === skillName)
      ? pack.skills
      : [...(pack.skills ?? []), { name: skillName, format: 'bundle' as const, enabled: true }]
    const updated: PackStatus = { ...pack, skills, updatedAt: new Date().toISOString() }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  addPackApplication: async (packId, addonId) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const applications = pack.applications?.some(addon => addon.id === addonId)
      ? pack.applications
      : [...(pack.applications ?? []), { id: addonId, name: addonId, enabled: true }]
    const updated: PackStatus = { ...pack, applications, updatedAt: new Date().toISOString() }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  togglePackItem: async (packId, packageName, enabled) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const updated: PackStatus = {
      ...pack,
      plugins: pack.plugins.map(plugin => (plugin.packageName === packageName ? { ...plugin, enabled } : plugin)),
      updatedAt: new Date().toISOString(),
    }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  togglePackPreset: async (packId, presetName, enabled) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const updated: PackStatus = {
      ...pack,
      presets: pack.presets?.map(preset => (preset.name === presetName ? { ...preset, enabled } : preset)),
      updatedAt: new Date().toISOString(),
    }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  togglePackSkill: async (packId, skillName, enabled) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const updated: PackStatus = {
      ...pack,
      skills: pack.skills?.map(skill => (skill.name === skillName ? { ...skill, enabled } : skill)),
      updatedAt: new Date().toISOString(),
    }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  togglePackApplication: async (packId, addonId, enabled) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const updated: PackStatus = {
      ...pack,
      applications: pack.applications?.map(addon => (addon.id === addonId ? { ...addon, enabled } : addon)),
      updatedAt: new Date().toISOString(),
    }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  removePackItem: async (packId, packageName) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const updated: PackStatus = {
      ...pack,
      plugins: pack.plugins.filter(plugin => plugin.packageName !== packageName),
      updatedAt: new Date().toISOString(),
    }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  removePackPreset: async (packId, presetName) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const presets = pack.presets?.filter(preset => preset.name !== presetName)
    const updated: PackStatus = { ...pack, presets: presets?.length ? presets : undefined, updatedAt: new Date().toISOString() }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  removePackSkill: async (packId, skillName) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const skills = pack.skills?.filter(skill => skill.name !== skillName)
    const updated: PackStatus = { ...pack, skills: skills?.length ? skills : undefined, updatedAt: new Date().toISOString() }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  removePackApplication: async (packId, addonId) => {
    const pack = demoPacks.find(item => item.id === packId)
    if (!pack) throw new Error(`未找到整合包：${packId}`)
    const applications = pack.applications?.filter(addon => addon.id !== addonId)
    const updated: PackStatus = { ...pack, applications: applications?.length ? applications : undefined, updatedAt: new Date().toISOString() }
    demoPacks = demoPacks.map(item => (item.id === packId ? updated : item))
    return updated
  },
  onCatalogAnalysisProgress: listener => {
    catalogAnalysisProgressListeners.add(listener)
    return () => catalogAnalysisProgressListeners.delete(listener)
  },
  onDshMarketProgress: listener => {
    dshMarketProgressListeners.add(listener)
    return () => dshMarketProgressListeners.delete(listener)
  },
  onPackProgress: listener => {
    packProgressListeners.add(listener)
    return () => packProgressListeners.delete(listener)
  },
  onAiInstallEvent: listener => {
    aiEventListeners.add(listener)
    return () => aiEventListeners.delete(listener)
  },
  onAiSessionEvent: listener => {
    aiSessionEventListeners.add(listener)
    return () => aiSessionEventListeners.delete(listener)
  },
}
