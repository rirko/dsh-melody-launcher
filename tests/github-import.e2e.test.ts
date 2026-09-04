import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandOptions } from '../electron/command'
import { importCatalogFromUrl } from '../electron/github-import'
import { createInstaller } from '../electron/installer'
import { analyzeRepository } from '../electron/plugin-catalog'
import { analyzeApplicationRepository } from '../electron/application-catalog'
import { recordPluginInstall } from '../electron/plugin-receipts'
import { readProfile } from '../electron/profile'
import { analyzeSkillRepository } from '../electron/skill-catalog'
import { readInstalledSkills as readLocalSkills } from '../electron/skill-format'
import { installSkillFromRepository } from '../electron/skill-install'
import type { GitHubRepositoryItem } from '../electron/discovery'
import type { NodeRuntime } from '../electron/node-runtime'
import type {
  AppSettings,
  InstalledSkill,
  PluginInstallTarget,
  ProfileState,
  SkillInstallTarget,
} from '../src/types'

// 沿 installer.test.ts 的替身边界：把会打真实网络的底层（GitHub 分析 API、Skill 归档下载）
// 与读盘逻辑替换为桩，CLI 调用通过 runCommand 记录。分析/安装编排本身跑真实代码。
vi.mock('../electron/profile', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/profile')>()
  return { ...actual, readProfile: vi.fn() }
})

vi.mock('../electron/plugin-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/plugin-catalog')>()
  return { ...actual, analyzeRepository: vi.fn() }
})

vi.mock('../electron/skill-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/skill-catalog')>()
  return { ...actual, analyzeSkillRepository: vi.fn() }
})

vi.mock('../electron/application-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/application-catalog')>()
  return { ...actual, analyzeApplicationRepository: vi.fn() }
})

vi.mock('../electron/plugin-receipts', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/plugin-receipts')>()
  return { ...actual, recordPluginInstall: vi.fn() }
})

vi.mock('../electron/skill-install', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/skill-install')>()
  return { ...actual, installSkillFromRepository: vi.fn() }
})

vi.mock('../electron/skill-format', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/skill-format')>()
  return { ...actual, readInstalledSkills: vi.fn() }
})

let temporaryDirectory = ''
let settings: AppSettings
let calls: Array<{ executable: string; args: string[]; options: CommandOptions }>

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-import-e2e-'))
  calls = []
  settings = {
    dshInstallPath: path.join(temporaryDirectory, 'runtime'),
    dshHome: path.join(temporaryDirectory, 'dsh-home'),
    profileName: 'web',
    workspace: path.join(temporaryDirectory, 'workspace'),
    launchExecutable: 'npx',
    launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
    webPort: 3080,
    openAfterLaunch: true,
  }
  vi.resetAllMocks()
  vi.mocked(analyzeApplicationRepository).mockResolvedValue({
    repository: 'demo/resource',
    defaultBranch: 'main',
    installability: 'invalid',
    summary: 'no application addon',
    targets: [],
  })
})

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

function createTestInstaller() {
  const nodeRuntime: NodeRuntime = {
    root: path.join(temporaryDirectory, 'node'),
    node: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
  const installer = createInstaller({
    readSettings: async () => settings,
    saveSettings: async next => next,
    prepareNodeRuntime: async () => nodeRuntime,
    preparePnpmRuntime: async () => ({
      root: path.join(temporaryDirectory, 'pnpm-runtime'),
      executable: path.join(temporaryDirectory, 'pnpm-runtime', 'node_modules', '.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'),
    }),
    pluginSourceRoot: path.join(temporaryDirectory, 'plugin-source'),
    pluginReceiptsPath: path.join(temporaryDirectory, 'receipts.json'),
    presetReceiptsPath: path.join(temporaryDirectory, 'preset-receipts.json'),
    skillReceiptsPath: path.join(temporaryDirectory, 'skill-receipts.json'),
    skillSourceRoot: path.join(temporaryDirectory, 'skill-source'),
    emitOutput: () => {},
    emitProgress: () => {},
    isRuntimeRunning: () => false,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options })
      return { exitCode: 0, output: '' }
    },
  })
  return { installer, calls, settings }
}

function profileState(profileName: string, packageName: string): ProfileState {
  return {
    initialized: true,
    profileDir: path.join('dsh-home', 'profiles', profileName),
    manifestPath: path.join('dsh-home', 'profiles', profileName, 'package.json'),
    plugins: [{
      packageName,
      displayName: packageName,
      version: '1.0.0',
      description: '',
      enabled: true,
      builtin: false,
      locked: false,
      compatible: true,
      order: 1,
    }],
    activeBundles: [packageName],
    dependencyCount: 1,
    disabledCount: 0,
  }
}

function pluginTarget(packageName: string, commit: string): PluginInstallTarget {
  return {
    id: `${packageName}:.`,
    packageName,
    version: '1.0.0',
    source: 'github',
    profileName: 'web',
    platform: 'unknown',
    subdirectory: null,
    commit,
    requiresBuild: false,
    buildScripts: [],
    nodeRange: null,
  }
}

function skillTarget(name: string): SkillInstallTarget {
  return {
    id: name,
    name,
    description: 'Demo skill',
    sourcePath: 'skills/demo',
    format: 'bundle',
    revision: 'main',
    modelInvocable: true,
    userInvocable: true,
  }
}

const pluginItem: GitHubRepositoryItem = {
  id: 9001,
  full_name: 'demo/dsh-plugin',
  name: 'dsh-plugin',
  owner: { login: 'demo' },
  description: 'Demo plugin',
  html_url: 'https://github.com/demo/dsh-plugin',
  stargazers_count: 5,
  language: 'TypeScript',
  updated_at: '2026-08-01T00:00:00Z',
  topics: ['dsh-plugin'],
  default_branch: 'main',
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

function importWith(installer: ReturnType<typeof createTestInstaller>['installer'], fetchImpl: typeof fetch = fetch) {
  return (url: string) => importCatalogFromUrl(
    url,
    (fullName, branch) => installer.analyzeCatalogRepository(fullName, branch),
    fetchImpl,
  )
}

describe('从 GitHub 链接导入并安装 —— 端到端', () => {
  it('插件仓库：链接导入出市场行与分析，安装复用 installPluginTarget 的 dsh 命令', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/dsh-plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [pluginTarget('demo-plugin', 'c0ffee11')],
    })
    vi.mocked(analyzeSkillRepository).mockResolvedValue({
      repository: 'demo/dsh-plugin',
      defaultBranch: 'main',
      installability: 'invalid',
      summary: 'no skill',
      targets: [],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))

    const { installer, calls } = createTestInstaller()
    const fetchImpl = (async () => jsonResponse(pluginItem)) as typeof fetch

    const result = await importWith(installer, fetchImpl)('https://github.com/demo/dsh-plugin')

    // 导入：真实分析管道产出市场行 + 分析。
    expect(result.repository.fullName).toBe('demo/dsh-plugin')
    expect(result.repository.defaultBranch).toBe('main')
    expect(result.repository.kind).toBe('repository')
    expect(result.repository.candidateTypes).toEqual([])
    expect(result.analysis.kind).toBe('plugin')
    expect(result.analysis.pluginAnalysis?.targets).toHaveLength(1)
    expect(result.analysis.warnings).toEqual([])

    // 市场「安装」按钮走同一 installPluginTarget 路径，最终落到 dsh CLI。
    await installer.installPluginTarget({
      repository: 'demo/dsh-plugin',
      defaultBranch: 'main',
      targetId: 'demo-plugin:.',
    })

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall).toBeDefined()
    expect(addCall!.args).toEqual([
      '--yes', '@deepseek-ai/dsh',
      'plugin', '--profile', 'web',
      'add', 'github:demo/dsh-plugin#c0ffee11',
    ])
    expect(recordPluginInstall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ packageName: 'demo-plugin', profileName: 'web', source: 'github' }),
    )
  })

  it('技能仓库：链接导入出 skill 分析，安装复用 installSkill 的目标解析与落盘边界', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/dsh-skill',
      defaultBranch: 'main',
      installability: 'invalid',
      summary: 'no plugin',
      targets: [],
    })
    vi.mocked(analyzeSkillRepository).mockResolvedValue({
      repository: 'demo/dsh-skill',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [skillTarget('my-skill')],
    })
    const installedSkill: InstalledSkill = {
      name: 'my-skill',
      description: 'Demo skill',
      path: path.join(settings.dshHome, 'skills', 'my-skill'),
      format: 'bundle',
      enabled: true,
      modelInvocable: true,
      userInvocable: true,
    }
    vi.mocked(installSkillFromRepository).mockResolvedValue(installedSkill)
    vi.mocked(readLocalSkills).mockResolvedValue([installedSkill])

    const { installer } = createTestInstaller()
    const fetchImpl = (async () => jsonResponse({ ...pluginItem, full_name: 'demo/dsh-skill', name: 'dsh-skill' })) as typeof fetch

    const result = await importWith(installer, fetchImpl)('https://github.com/demo/dsh-skill')

    expect(result.analysis.kind).toBe('skill')
    expect(result.analysis.skillAnalysis?.targets).toHaveLength(1)
    expect(result.analysis.pluginAnalysis?.targets).toEqual([])

    // 市场「安装」按钮走同一 installSkill 路径。
    const skillResult = await installer.installSkill({
      repository: 'demo/dsh-skill',
      defaultBranch: 'main',
      targetId: 'my-skill',
    })
    expect(skillResult.installedSkill.name).toBe('my-skill')
    expect(installSkillFromRepository).toHaveBeenCalledWith(
      expect.stringContaining('skill-source'),
      settings.dshHome,
      'demo/dsh-skill',
      expect.objectContaining({ name: 'my-skill', format: 'bundle' }),
      expect.any(Function),
      // 此用例未注入 githubFetch，占位 undefined；最后是由 settings.skillMaxArchiveMb 推导的安装限制。
      undefined,
      expect.objectContaining({ archiveMb: 64 }),
    )
  })

  it('链接里的 /tree/<branch> 作为分析分支传递', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/dsh-plugin',
      defaultBranch: 'develop',
      installability: 'ready',
      summary: 'ok',
      targets: [pluginTarget('demo-plugin', 'deadbeef')],
    })
    vi.mocked(analyzeSkillRepository).mockResolvedValue({
      repository: 'demo/dsh-plugin',
      defaultBranch: 'develop',
      installability: 'invalid',
      summary: 'no skill',
      targets: [],
    })

    const { installer } = createTestInstaller()
    const fetchImpl = (async () => jsonResponse(pluginItem)) as typeof fetch

    const result = await importWith(installer, fetchImpl)('https://github.com/demo/dsh-plugin/tree/develop')

    expect(result.repository.defaultBranch).toBe('develop')
    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledWith('demo/dsh-plugin', 'develop', 'web')
    expect(vi.mocked(analyzeSkillRepository)).toHaveBeenCalledWith('demo/dsh-plugin', 'develop')
  })

  it('DSH 本体链接导入为 dsh 行（复用 analyzeCatalogRepository 的本体分支）', async () => {
    const { installer } = createTestInstaller()
    const fetchImpl = (async () => jsonResponse({
      ...pluginItem,
      id: 1,
      full_name: 'deepseek-ai/deepseek-harness',
      name: 'deepseek-harness',
      default_branch: 'master',
    })) as typeof fetch

    const result = await importWith(installer, fetchImpl)('https://github.com/deepseek-ai/deepseek-harness')

    expect(result.repository.kind).toBe('dsh')
    expect(result.repository.defaultBranch).toBe('master')
    expect(result.analysis.kind).toBe('dsh')
  })

  it('非法链接报中文错误，且不产生任何 CLI 调用', async () => {
    const { installer, calls } = createTestInstaller()
    await expect(importWith(installer)('https://gitlab.com/x/y')).rejects.toThrow(/只支持 GitHub/)
    expect(calls).toHaveLength(0)
  })
})
