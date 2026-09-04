import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandOptions } from '../electron/command'
import {
  buildPluginCommandArgs,
  createInstaller,
  resolveInstallProfile,
  validateLocalPluginDirectory,
} from '../electron/installer'
import { analyzeRepository } from '../electron/plugin-catalog'
import { readProfile, removePluginFromProfile } from '../electron/profile'
import { recordPluginInstall, removePluginReceipt } from '../electron/plugin-receipts'
import { analyzeMetaRepository } from '../electron/meta-repo-catalog'
import { analyzeSkillRepository } from '../electron/skill-catalog'
import { analyzeApplicationRepository } from '../electron/application-catalog'
import type { NodeRuntime } from '../electron/node-runtime'
import type { AppSettings, CatalogRepositoryAnalysis, PluginInstallTarget, ProfileState } from '../src/types'

vi.mock('../electron/profile', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/profile')>()
  return { ...actual, readProfile: vi.fn(), removePluginFromProfile: vi.fn().mockResolvedValue(true), removeUnusedSharedPluginBodies: vi.fn().mockResolvedValue(false) }
})

vi.mock('../electron/plugin-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/plugin-catalog')>()
  return { ...actual, analyzeRepository: vi.fn() }
})

vi.mock('../electron/plugin-receipts', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/plugin-receipts')>()
  return { ...actual, recordPluginInstall: vi.fn(), removePluginReceipt: vi.fn() }
})

vi.mock('../electron/skill-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/skill-catalog')>()
  return { ...actual, analyzeSkillRepository: vi.fn() }
})

vi.mock('../electron/application-catalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../electron/application-catalog')>()
  return { ...actual, analyzeApplicationRepository: vi.fn() }
})

vi.mock('../electron/meta-repo-catalog', () => ({
  analyzeMetaRepository: vi.fn(),
}))

const onDemand: AppSettings = {
  dshInstallPath: '/home/tester/.dsh-runtime',
  dshHome: '/home/tester/.dsh',
  profileName: 'web',
  workspace: '/home/tester/Documents',
  launchExecutable: 'npx',
  launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
  webPort: 3080,
  openAfterLaunch: true,
}

describe('buildPluginCommandArgs', () => {
  it('reuses the npx prefix up to and including the package specifier', () => {
    expect(buildPluginCommandArgs(onDemand, 'npx', ['add', 'github:someone/plugin'])).toEqual([
      '--yes', '@deepseek-ai/dsh',
      'plugin', '--profile', 'web',
      'add', 'github:someone/plugin',
    ])
  })

  it('drops the launch subcommand that follows the package specifier', () => {
    // launchArgs 末尾的 web 是启动 DSH 用的，插件命令不能带上它。
    const headless: AppSettings = { ...onDemand, profileName: 'headless' }
    expect(buildPluginCommandArgs(headless, 'npx', ['remove', 'some-plugin'])).toEqual([
      '--yes', '@deepseek-ai/dsh',
      'plugin', '--profile', 'headless',
      'remove', 'some-plugin',
    ])
  })

  it('calls a bound dsh executable directly without a package prefix', () => {
    const bound: AppSettings = {
      ...onDemand,
      launchExecutable: '/opt/dsh/node_modules/.bin/dsh',
      launchArgs: ['web'],
    }
    expect(buildPluginCommandArgs(bound, '/opt/dsh/node_modules/.bin/dsh', ['add', 'github:a/b'])).toEqual([
      'plugin', '--profile', 'web',
      'add', 'github:a/b',
    ])
  })

  it('recognizes the dsh.cmd wrapper used on Windows', () => {
    const executable = path.join('C:', 'runtime', 'node_modules', '.bin', 'dsh.cmd')
    const bound: AppSettings = { ...onDemand, launchExecutable: executable, launchArgs: ['web'] }
    expect(buildPluginCommandArgs(bound, executable, ['add', 'github:a/b'])[0]).toBe('plugin')
  })

  it('falls back to fetching the package when the executable is unrelated', () => {
    const custom: AppSettings = { ...onDemand, launchExecutable: 'node', launchArgs: ['./server.js'] }
    expect(buildPluginCommandArgs(custom, 'node', ['add', 'github:a/b'])).toEqual([
      '--yes', '@deepseek-ai/dsh',
      'plugin', '--profile', 'web',
      'add', 'github:a/b',
    ])
  })

  it('carries a custom profile name through', () => {
    const headless: AppSettings = { ...onDemand, profileName: 'headless' }
    expect(buildPluginCommandArgs(headless, 'npx', ['add', 'github:a/b'])).toContain('headless')
  })
})

// ---------------------------------------------------------------------------
// 测试替身：createInstaller 的 DI 沿用 main.ts 的装配方式，额外注入
// runCommand 命令执行器替身与 readProfile / analyzeRepository 桩。
// ---------------------------------------------------------------------------

let temporaryDirectory = ''
let settings: AppSettings
let calls: Array<{ executable: string; args: string[]; options: CommandOptions }>
let purgeStoreCalls: string[]
let syncProfilePoolCalls: string[]

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-installer-test-'))
  calls = []
  purgeStoreCalls = []
  syncProfilePoolCalls = []
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
  vi.mocked(removePluginFromProfile).mockResolvedValue(true)
  vi.mocked(analyzeApplicationRepository).mockResolvedValue({
    repository: 'demo/repository',
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

function createTestInstaller(
  githubFetch?: typeof fetch,
  runCommandOverride?: (executable: string, args: string[], options: CommandOptions) => Promise<{ exitCode: number; output: string }>,
  syncProfilePoolOverride?: (dshHome: string) => Promise<void>,
  resolveGitExecutable?: (environment: NodeJS.ProcessEnv) => string | null,
) {
  const nodeRuntime: NodeRuntime = {
    root: path.join(temporaryDirectory, 'node'),
    node: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(temporaryDirectory, 'node', process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
  const pnpmExecutable = path.join(
    temporaryDirectory,
    'pnpm-runtime',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  )
  const installer = createInstaller({
    readSettings: async () => settings,
    saveSettings: async next => next,
    prepareNodeRuntime: async () => nodeRuntime,
    preparePnpmRuntime: async () => ({ root: path.join(temporaryDirectory, 'pnpm-runtime'), executable: pnpmExecutable }),
    pluginSourceRoot: path.join(temporaryDirectory, 'plugin-source'),
    pluginReceiptsPath: path.join(temporaryDirectory, 'receipts.json'),
    packageStoreRoot: path.join(temporaryDirectory, 'plugin-store'),
    purgePnpmStore: async storeRoot => { purgeStoreCalls.push(storeRoot) },
    syncProfilePool: syncProfilePoolOverride,
    presetReceiptsPath: path.join(temporaryDirectory, 'preset-receipts.json'),
    skillReceiptsPath: path.join(temporaryDirectory, 'skill-receipts.json'),
    skillSourceRoot: path.join(temporaryDirectory, 'skill-source'),
    emitOutput: () => {},
    emitProgress: () => {},
    isRuntimeRunning: () => false,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, options })
      if (runCommandOverride) return runCommandOverride(executable, args, options)
      return { exitCode: 0, output: '' }
    },
    githubFetch,
    resolveGitExecutable,
  })
  return { installer, calls, settings, pnpmExecutable }
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

function localDirectoryTarget(localDirectory: string): PluginInstallTarget {
  return {
    id: 'demo-plugin:.',
    packageName: 'demo-plugin',
    version: null,
    source: 'local-directory',
    profileName: 'web',
    platform: 'unknown',
    subdirectory: null,
    commit: '',
    requiresBuild: false,
    buildScripts: [],
    nodeRange: null,
    localDirectory,
  }
}

describe('resolveInstallProfile', () => {
  it('prefers the explicit profile override over the target profile', () => {
    const target = localDirectoryTarget('/tmp/plugin')
    expect(resolveInstallProfile(target, 'pack-a')).toBe('pack-a')
  })

  it('falls back to the target profile when no override is given', () => {
    const target = { ...localDirectoryTarget('/tmp/plugin'), profileName: 'tui' }
    expect(resolveInstallProfile(target)).toBe('tui')
  })

  it('falls back to the default profile when neither is present', () => {
    const target = { ...localDirectoryTarget('/tmp/plugin'), profileName: undefined } as unknown as PluginInstallTarget
    expect(resolveInstallProfile(target)).toBe('web')
  })
})

describe('validateLocalPluginDirectory', () => {
  it('accepts an existing absolute plugin directory', async () => {
    const localDirectory = await mkdtemp(path.join(temporaryDirectory, 'local-plugin-'))
    await writeFile(path.join(localDirectory, 'package.json'), JSON.stringify({ name: 'demo-plugin' }))
    expect(validateLocalPluginDirectory(localDirectory)).toBe(localDirectory)
  })

  it('rejects a relative path and a missing directory', () => {
    expect(() => validateLocalPluginDirectory('relative/dir')).toThrow(/绝对路径/)
    expect(() => validateLocalPluginDirectory(path.join(temporaryDirectory, 'missing-dir'))).toThrow(/不存在/)
  })
})

describe('installNpmPackage', () => {
  it('installs a manifest-only npm entry into the shared Profile without GitHub analysis', async () => {
    vi.mocked(readProfile).mockImplementation(async (_dshHome, profileName) => profileState(profileName, 'demo-plugin'))
    const { installer, calls } = createTestInstaller(undefined, undefined, async dshHome => {
      syncProfilePoolCalls.push(dshHome)
    })
    const result = await installer.installNpmPackage({ packageName: 'demo-plugin', version: '1.2.3' }, 'web')
    expect(calls.find(call => call.args.includes('add'))?.args).toEqual([
      '--yes', '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', 'demo-plugin@1.2.3',
    ])
    expect(analyzeRepository).not.toHaveBeenCalled()
    expect(recordPluginInstall).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      repository: 'npm:demo-plugin', packageName: 'demo-plugin', profileName: 'web', source: 'npm', version: '1.2.3',
    }))
    expect(result.installedProfileName).toBe('web')
    expect(syncProfilePoolCalls).toEqual([settings.dshHome])
  })

  it('does not fail an otherwise successful install when shared Profile synchronization fails', async () => {
    vi.mocked(readProfile).mockImplementation(async (_dshHome, profileName) => profileState(profileName, 'demo-plugin'))
    const { installer } = createTestInstaller(undefined, undefined, async () => {
      throw new Error('同步测试失败')
    })

    await expect(installer.installNpmPackage({ packageName: 'demo-plugin', version: '1.2.3' }, 'web')).resolves.toMatchObject({
      installedProfileName: 'web',
      packageName: 'demo-plugin',
    })
  })

  it('falls back to npm latest when the requested exact version is unavailable', async () => {
    vi.mocked(readProfile).mockImplementation(async (_dshHome, profileName) => profileState(profileName, 'demo-plugin'))
    let addAttempts = 0
    const { installer, calls } = createTestInstaller(undefined, async (_executable, args) => {
      if (args.includes('add')) {
        addAttempts += 1
        if (addAttempts === 1) {
          return {
            exitCode: 1,
            output: '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for demo-plugin@9.9.9',
          }
        }
      }
      return { exitCode: 0, output: '' }
    })

    await installer.installNpmPackage({ packageName: 'demo-plugin', version: '9.9.9' }, 'web')

    const addCalls = calls.filter(call => call.args.includes('add'))
    expect(addCalls).toHaveLength(2)
    expect(addCalls[0]?.args).toContain('demo-plugin@9.9.9')
    expect(addCalls[1]?.args).toContain('demo-plugin')
    expect(addCalls[1]?.args).not.toContain('demo-plugin@9.9.9')
    expect(recordPluginInstall).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ version: '1.0.0' }))
  })

  it('rejects unsafe package names and versions before invoking DSH', async () => {
    const { installer, calls } = createTestInstaller()
    await expect(installer.installNpmPackage({ packageName: 'bad package' })).rejects.toThrow(/包名/)
    await expect(installer.installNpmPackage({ packageName: 'demo-plugin', version: '1.0.0 latest' })).rejects.toThrow(/版本/)
    expect(calls).toHaveLength(0)
  })
})

describe('shared plugin pool synchronization', () => {
  it('runs after the legacy GitHub install path succeeds', async () => {
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const { installer } = createTestInstaller(undefined, undefined, async dshHome => {
      syncProfilePoolCalls.push(dshHome)
    })

    await installer.install('demo/ordinary-plugin')

    expect(syncProfilePoolCalls).toEqual([settings.dshHome])
  })

  it('runs after a validated local plugin install succeeds', async () => {
    const localDirectory = await mkdtemp(path.join(temporaryDirectory, 'direct-local-plugin-'))
    await writeFile(path.join(localDirectory, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }))
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const { installer } = createTestInstaller(undefined, undefined, async dshHome => {
      syncProfilePoolCalls.push(dshHome)
    })

    await installer.installLocalPlugin({ packageName: 'demo-plugin', directory: localDirectory }, 'web')

    expect(syncProfilePoolCalls).toEqual([settings.dshHome])
  })
})

describe('installPluginTarget with local-directory source', () => {
  it('installs from the local directory into the resolved profile without downloading', async () => {
    const localDirectory = await mkdtemp(path.join(temporaryDirectory, 'local-plugin-'))
    await writeFile(path.join(localDirectory, 'package.json'), JSON.stringify({ name: 'demo-plugin' }))

    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [localDirectoryTarget(localDirectory)],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('tui', 'demo-plugin'))

    const { installer, calls, pnpmExecutable } = createTestInstaller(undefined, undefined, async dshHome => {
      syncProfilePoolCalls.push(dshHome)
    })
    const result = await installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'tui',
    )

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall).toBeDefined()
    expect(addCall!.args).toEqual([
      '--yes', '@deepseek-ai/dsh',
      'plugin', '--profile', 'tui',
      'add', `file:${localDirectory}`,
    ])
    // 平台感知：Windows 上 node 运行时会落到 npx.cmd，POSIX 上为 npx。
    expect(path.basename(addCall!.executable).toLowerCase()).toBe(process.platform === 'win32' ? 'npx.cmd' : 'npx')
    const pathKey = Object.keys(addCall!.options.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    expect(addCall!.options.env[pathKey]?.split(path.delimiter)).toContain(path.dirname(pnpmExecutable))
    expect(recordPluginInstall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ packageName: 'demo-plugin', profileName: 'tui', source: 'local-directory' }),
    )
    expect(result.installedProfileName).toBe('tui')
    expect(syncProfilePoolCalls).toEqual([settings.dshHome])
  })

  it('rejects a local-directory target without a valid local directory', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [{ ...localDirectoryTarget(path.join(temporaryDirectory, 'nope')), localDirectory: path.join(temporaryDirectory, 'nope') }],
    })

    const { installer, calls } = createTestInstaller()
    await expect(installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'tui',
    )).rejects.toThrow(/不存在/)
    expect(calls.filter(call => call.args.includes('add'))).toHaveLength(0)
  })

  it('builds a local Bundle when its declared patch output is missing', async () => {
    const localDirectory = await mkdtemp(path.join(temporaryDirectory, 'source-plugin-'))
    await writeFile(path.join(localDirectory, 'package.json'), JSON.stringify({
      name: 'demo-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: './dist/cordis.patch.yml' } },
      scripts: { build: 'node scripts/build.mjs' },
    }))

    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [localDirectoryTarget(localDirectory)],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))

    const { installer, calls } = createTestInstaller(undefined, async (_executable, args) => {
      if (args[0] === 'run' && args[1] === 'build') {
        await mkdir(path.join(localDirectory, 'dist'), { recursive: true })
        await writeFile(path.join(localDirectory, 'dist', 'cordis.patch.yml'), '[]\n')
      }
      return { exitCode: 0, output: '' }
    })

    await installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'web',
    )

    expect(calls.some(call => call.args[0] === 'install' && call.args.includes('--dir'))).toBe(true)
    expect(calls.some(call => call.args[0] === 'run' && call.args[1] === 'build')).toBe(true)
    expect(calls.some(call => call.args.includes('add') && call.args.includes(`file:${localDirectory}`))).toBe(true)
  })

  it('stops before installing a local Bundle when build does not produce its patch', async () => {
    const localDirectory = await mkdtemp(path.join(temporaryDirectory, 'broken-source-plugin-'))
    await writeFile(path.join(localDirectory, 'package.json'), JSON.stringify({
      name: 'broken-plugin',
      dsh: { bundle: { patch: './dist/cordis.patch.yml' } },
      scripts: { build: 'node scripts/build.mjs' },
    }))
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [{ ...localDirectoryTarget(localDirectory), packageName: 'broken-plugin', id: 'broken-plugin:.' }],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'broken-plugin'))

    const { installer, calls } = createTestInstaller()
    await expect(installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'broken-plugin:.' },
      'web',
    )).rejects.toThrow(/仍未生成/)
    expect(calls.some(call => call.args.includes('add'))).toBe(false)
  })
})

describe('installPluginTarget with github source and pinned commit', () => {
  function githubTarget(commit: string): PluginInstallTarget {
    return {
      id: 'demo-plugin:.',
      packageName: 'demo-plugin',
      version: '1.0.0',
      source: 'github',
      profileName: 'tui',
      platform: 'unknown',
      subdirectory: null,
      commit,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
    }
  }

  it('优先使用请求里的固定 commit 构造 specifier，而不是重新分析得到的 HEAD commit', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [githubTarget('c0ffee11')],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('tui', 'demo-plugin'))

    const { installer, calls } = createTestInstaller()
    await installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.', commit: 'abc1234' },
      'tui',
    )

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall).toBeDefined()
    expect(addCall!.args).toContain('github:demo/plugin#abc1234')
  })

  it('未提供 pin 时回退到分析得到的 commit', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [githubTarget('c0ffee11')],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('tui', 'demo-plugin'))

    const { installer, calls } = createTestInstaller()
    await installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'tui',
    )

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall!.args).toContain('github:demo/plugin#c0ffee11')
  })

  it('没有 Git 时使用固定 commit 的 GitHub archive 安装根目录 Bundle', async () => {
    const commit = 'd'.repeat(40)
    const zip = new AdmZip()
    zip.addFile('repository-main/package.json', Buffer.from(JSON.stringify({
      name: 'demo-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })))
    zip.addFile('repository-main/cordis.patch.yml', Buffer.from('[]\n'))
    const archive = zip.toBuffer()
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [githubTarget(commit)],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const githubFetch = (async () => new Response(new Uint8Array(archive))) as typeof fetch
    const { installer, calls } = createTestInstaller(githubFetch, undefined, undefined, () => null)

    await installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'web',
    )

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall?.args.some(arg => arg.startsWith('file:'))).toBe(true)
    expect(recordPluginInstall).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      source: 'archive-subdirectory',
      actualSource: 'github',
      commit,
    }))
  })

  it('Git 检测误判但 pnpm 报 Git 缺失时自动重试固定 archive', async () => {
    const commit = 'f'.repeat(40)
    const zip = new AdmZip()
    zip.addFile('repository-main/package.json', Buffer.from(JSON.stringify({
      name: 'demo-plugin',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })))
    zip.addFile('repository-main/cordis.patch.yml', Buffer.from('[]\n'))
    const archive = zip.toBuffer()
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [githubTarget(commit)],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    let attempts = 0
    const githubFetch = (async () => new Response(new Uint8Array(archive))) as typeof fetch
    const { installer, calls } = createTestInstaller(
      githubFetch,
      async (_executable, args) => {
        attempts += 1
        return args.some(arg => arg.startsWith('github:')) && attempts === 1
          ? { exitCode: 1, output: 'git command not found' }
          : { exitCode: 0, output: '' }
      },
      undefined,
      () => 'C:\\stale\\git.exe',
    )

    await installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'web',
    )

    const addCalls = calls.filter(call => call.args.includes('add'))
    expect(addCalls).toHaveLength(2)
    expect(addCalls.at(-1)?.args.some(arg => arg.startsWith('file:'))).toBe(true)
    expect(recordPluginInstall).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      source: 'archive-subdirectory',
      actualSource: 'github',
      commit,
    }))
  })

  it('没有 Git 且没有 GitHub archive 客户端时立即给出明确错误', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin', defaultBranch: 'main', installability: 'ready', summary: 'ok',
      targets: [githubTarget('e'.repeat(40))],
    })
    const { installer, calls } = createTestInstaller(undefined, undefined, undefined, () => null)

    await expect(installer.installPluginTarget(
      { repository: 'demo/plugin', defaultBranch: 'main', targetId: 'demo-plugin:.' },
      'web',
    )).rejects.toThrow(/未找到 Git/)
    expect(calls).toHaveLength(0)
  })
})

describe('remove with profileName', () => {
  it('removes the matching Profile locally without invoking the DSH CLI', async () => {
    vi.mocked(readProfile).mockResolvedValue(profileState('tui', 'some-plugin'))
    const { installer, calls } = createTestInstaller()

    await installer.remove('some-plugin', 'tui')

    const removeCall = calls.find(call => call.args.includes('remove'))
    expect(removeCall).toBeUndefined()
    expect(removePluginReceipt).toHaveBeenCalledWith(expect.any(String), 'tui', 'some-plugin')
  })

  it('only prunes the controlled pnpm store when explicitly requested', async () => {
    vi.mocked(readProfile).mockResolvedValue(profileState('tui', 'some-plugin'))
    const { installer } = createTestInstaller()

    await installer.remove('some-plugin', 'tui')
    expect(purgeStoreCalls).toHaveLength(0)

    await installer.remove('some-plugin', 'tui', { purgeStore: true })
    expect(purgeStoreCalls).toEqual([path.join(temporaryDirectory, 'plugin-store')])
  })

  it('defaults to the settings profile when no profileName is given', async () => {
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'some-plugin'))
    const { installer, calls } = createTestInstaller()

    await installer.remove('some-plugin')

    const removeCall = calls.find(call => call.args.includes('remove'))
    expect(removeCall).toBeUndefined()
    expect(removePluginReceipt).toHaveBeenCalledWith(expect.any(String), 'web', 'some-plugin')
  })

  it('未指定 Profile 时清理本机所有 Profile 中的插件', async () => {
    await mkdir(path.join(settings.dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(path.join(settings.dshHome, 'profiles', 'tui'), { recursive: true })
    vi.mocked(readProfile).mockImplementation(async (_dshHome, profileName) => profileState(profileName, 'some-plugin'))
    const { installer, calls } = createTestInstaller()

    await installer.remove('some-plugin')

    expect(calls.filter(call => call.args.includes('remove'))).toHaveLength(0)
    expect(removePluginReceipt).toHaveBeenCalledWith(expect.any(String), 'web', 'some-plugin')
    expect(removePluginReceipt).toHaveBeenCalledWith(expect.any(String), 'tui', 'some-plugin')
  })

  it('彻底清除即使指定来源 Profile 也会同步清理所有 Profile', async () => {
    await mkdir(path.join(settings.dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(path.join(settings.dshHome, 'profiles', 'tui'), { recursive: true })
    vi.mocked(readProfile).mockImplementation(async (_dshHome, profileName) => profileState(profileName, 'some-plugin'))
    const { installer, calls } = createTestInstaller()

    await installer.remove('some-plugin', 'tui', { purgeStore: true })

    expect(calls.filter(call => call.args.includes('remove'))).toHaveLength(0)
    expect(removePluginFromProfile).toHaveBeenCalledWith(settings.dshHome, 'web', 'some-plugin')
    expect(removePluginFromProfile).toHaveBeenCalledWith(settings.dshHome, 'tui', 'some-plugin')
    expect(removePluginReceipt).toHaveBeenCalledWith(expect.any(String), 'web', 'some-plugin')
    expect(removePluginReceipt).toHaveBeenCalledWith(expect.any(String), 'tui', 'some-plugin')
    expect(purgeStoreCalls).toEqual([path.join(temporaryDirectory, 'plugin-store')])
  })

  it('遇到损坏的 Profile 清单时不会回收共享缓存', async () => {
    await mkdir(path.join(settings.dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(path.join(settings.dshHome, 'profiles', 'tui'), { recursive: true })
    await writeFile(path.join(settings.dshHome, 'profiles', 'tui', 'package.json'), '{ not-json\n')
    vi.mocked(readProfile).mockImplementation(async (_dshHome, profileName) => profileState(profileName, 'some-plugin'))
    const { installer } = createTestInstaller()

    await expect(installer.remove('some-plugin', 'web', { purgeStore: true })).rejects.toThrow(/tui.*无法读取 Profile 配置/)
    expect(purgeStoreCalls).toHaveLength(0)
  })
})

describe('analyzeCatalogRepository meta-repo 展开', () => {
  const metaAnalysis: CatalogRepositoryAnalysis = {
    repository: 'yjh051108/dsh-routing-suite',
    defaultBranch: 'main',
    kind: 'hybrid',
    componentKinds: ['plugin', 'skill'],
    summary: '聚合仓库',
    pluginAnalysis: {
      repository: 'yjh051108/dsh-routing-suite',
      defaultBranch: 'main',
      installability: 'choice',
      summary: '2 plugins',
      targets: [],
    },
    skillAnalysis: {
      repository: 'yjh051108/dsh-routing-suite',
      defaultBranch: 'main',
      installability: 'ready',
      summary: '1 skill',
      targets: [],
    },
    applicationAnalysis: null,
    presetAnalysis: null,
    warnings: [],
  }

  it('plugin 判为 application（聚合仓库信号）时展开子模块并返回 meta 分析', async () => {
    const { installer } = createTestInstaller()
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'yjh051108/dsh-routing-suite',
      defaultBranch: 'main',
      installability: 'application',
      summary: '聚合仓库',
      targets: [],
    })
    vi.mocked(analyzeSkillRepository).mockResolvedValue({
      repository: 'yjh051108/dsh-routing-suite',
      defaultBranch: 'main',
      installability: 'invalid',
      summary: 'no skill',
      targets: [],
    })
    vi.mocked(analyzeMetaRepository).mockResolvedValue(metaAnalysis)

    const result = await installer.analyzeCatalogRepository('yjh051108/dsh-routing-suite', 'main')

    expect(result).toBe(metaAnalysis)
    expect(analyzeMetaRepository).toHaveBeenCalledTimes(1)
    expect(analyzeMetaRepository).toHaveBeenCalledWith(
      'yjh051108/dsh-routing-suite',
      'main',
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('plugin 不是 application 时直接常规分类，不触发 meta 展开', async () => {
    const { installer } = createTestInstaller()
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'plugin',
      targets: [{
        id: 'demo-plugin:.',
        packageName: 'demo-plugin',
        version: '1.0.0',
        source: 'npm',
        profileName: 'web',
        platform: 'web',
        subdirectory: null,
        commit: 'a'.repeat(40),
        requiresBuild: false,
        buildScripts: [],
        nodeRange: null,
      }],
    })
    vi.mocked(analyzeSkillRepository).mockResolvedValue({
      repository: 'demo/plugin',
      defaultBranch: 'main',
      installability: 'invalid',
      summary: 'no skill',
      targets: [],
    })

    const result = await installer.analyzeCatalogRepository('demo/plugin', 'main')

    expect(analyzeMetaRepository).not.toHaveBeenCalled()
    expect(result.kind).toBe('plugin')
  })

  it('plugin 为 application 但 meta 展开无结果时回落常规分类', async () => {
    const { installer } = createTestInstaller()
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'acme/app',
      defaultBranch: 'main',
      installability: 'application',
      summary: '应用工作区',
      targets: [],
    })
    vi.mocked(analyzeSkillRepository).mockResolvedValue({
      repository: 'acme/app',
      defaultBranch: 'main',
      installability: 'invalid',
      summary: 'no skill',
      targets: [],
    })
    vi.mocked(analyzeMetaRepository).mockResolvedValue(null)

    const result = await installer.analyzeCatalogRepository('acme/app', 'main')

    expect(analyzeMetaRepository).toHaveBeenCalled()
    expect(result.kind).toBe('invalid')
  })
})

describe('installPluginTarget release 源（meta-repo tgz 直链）', () => {
  function githubTarget(commit: string): PluginInstallTarget {
    return {
      id: 'demo-plugin:.',
      packageName: 'demo-plugin',
      version: '1.0.0',
      source: 'github',
      profileName: 'web',
      platform: 'web',
      subdirectory: null,
      commit,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
    }
  }

  it('请求带 tarballUrl 时下载官方 tgz 并用 `add file:<tgz>` 安装，tgz 持久保留', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [githubTarget('c'.repeat(40))],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const tgz = Buffer.from('fake tgz content')
    const githubFetch = (async () => new Response(new Uint8Array(tgz), {
      status: 200,
      headers: { 'content-length': String(tgz.byteLength) },
    })) as typeof fetch

    const { installer, calls } = createTestInstaller(githubFetch)
    const result = await installer.installPluginTarget({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      targetId: 'demo-plugin:.',
      tarballUrl: 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.3/dsh-super-injector-0.3.3.tgz',
    })

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall).toBeDefined()
    const fileSpecifier = addCall!.args.find(arg => arg.startsWith('file:'))
    expect(fileSpecifier).toBeDefined()
    expect(fileSpecifier!.endsWith('.tgz')).toBe(true)
    const tgzPath = fileSpecifier!.slice('file:'.length)
    expect(tgzPath.startsWith(path.join(temporaryDirectory, 'plugin-source'))).toBe(true)
    // tgz 是 file: 依赖的持久来源，装完后必须保留，否则后续 pnpm 操作会 ENOENT。
    await expect(access(tgzPath)).resolves.toBeUndefined()
    expect(recordPluginInstall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ packageName: 'demo-plugin', source: 'release' }),
    )
    expect(result.installedProfileName).toBe('web')
  })

  it('分析为 github 源且请求无 tarballUrl 时保持 github pin 安装', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [githubTarget('c'.repeat(40))],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const githubFetch = (async () => new Response(new Uint8Array(Buffer.from('x')), { status: 200 })) as typeof fetch

    const { installer, calls } = createTestInstaller(githubFetch)
    await installer.installPluginTarget({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      targetId: 'demo-plugin:.',
    })

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall).toBeDefined()
    expect(addCall!.args).toContain(`github:yjh051108/dsh-super-injector#${'c'.repeat(40)}`)
  })

  it('清单声明 GitHub 时不会被同名 npm 候选改写', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'omdsh-dev/dsh-at-file',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [{
        id: 'dsh-at-file:.',
        packageName: 'dsh-at-file',
        version: '0.6.3',
        source: 'npm',
        profileName: 'web',
        platform: 'web',
        subdirectory: null,
        commit: 'r'.repeat(40),
        requiresBuild: false,
        buildScripts: [],
        nodeRange: null,
      }],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'dsh-at-file'))
    const { installer, calls } = createTestInstaller(undefined, undefined, undefined, () => 'C:\\git.exe')

    await installer.installPluginTarget({
      repository: 'omdsh-dev/dsh-at-file',
      defaultBranch: 'main',
      targetId: 'dsh-at-file:.',
      source: 'github',
      commit: 'p'.repeat(40),
      version: '0.6.0',
    })

    const addCall = calls.find(call => call.args.includes('add'))
    expect(addCall?.args).toContain(`github:omdsh-dev/dsh-at-file#${'p'.repeat(40)}`)
    expect(addCall?.args.some(arg => arg.includes('@0.6.0'))).toBe(false)
  })
})

describe('pnpm store 升级自动迁移重试', () => {
  it('dsh plugin add 报 ERR_PNPM_UNEXPECTED_STORE 时在 Profile 里跑 pnpm install 迁移后自动重试', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [{
        id: 'demo-plugin:.',
        packageName: 'demo-plugin',
        version: '1.0.0',
        source: 'github',
        profileName: 'web',
        platform: 'web',
        subdirectory: null,
        commit: 'c'.repeat(40),
        requiresBuild: false,
        buildScripts: [],
        nodeRange: null,
      }],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const tgz = Buffer.from('fake tgz content')
    const githubFetch = (async () => new Response(new Uint8Array(tgz), {
      status: 200,
      headers: { 'content-length': String(tgz.byteLength) },
    })) as typeof fetch

    let pluginAddRuns = 0
    const { installer, calls } = createTestInstaller(githubFetch, async (_executable, args, _options) => {
      if (args.includes('add')) {
        pluginAddRuns += 1
        return pluginAddRuns === 1
          ? { exitCode: 1, output: '[ERR_PNPM_UNEXPECTED_STORE] linked from store v10, now wants store v11' }
          : { exitCode: 0, output: 'done' }
      }
      if (args[0] === 'install') return { exitCode: 0, output: 'Done in 1s' }
      return { exitCode: 0, output: '' }
    })

    const result = await installer.installPluginTarget({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      targetId: 'demo-plugin:.',
      tarballUrl: 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.3/dsh-super-injector-0.3.3.tgz',
    })

    // 首次 add 失败 → pnpm install 迁移 → add 重试成功。
    expect(pluginAddRuns).toBe(2)
    const migrateCall = calls.find(call => call.args[0] === 'install')
    expect(migrateCall).toBeDefined()
    expect(migrateCall!.options.cwd).toBe(path.join(settings.dshHome, 'profiles', 'web'))
    expect(migrateCall!.options.env.CI).toBe('true')
    expect(result.installedProfileName).toBe('web')
  })

  it('迁移失败时抛出清晰错误，不再无限重试', async () => {
    vi.mocked(analyzeRepository).mockResolvedValue({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      installability: 'ready',
      summary: 'ok',
      targets: [{
        id: 'demo-plugin:.',
        packageName: 'demo-plugin',
        version: '1.0.0',
        source: 'github',
        profileName: 'web',
        platform: 'web',
        subdirectory: null,
        commit: 'c'.repeat(40),
        requiresBuild: false,
        buildScripts: [],
        nodeRange: null,
      }],
    })
    vi.mocked(readProfile).mockResolvedValue(profileState('web', 'demo-plugin'))
    const githubFetch = (async () => new Response(new Uint8Array(Buffer.from('x')), { status: 200 })) as typeof fetch

    const { installer, calls } = createTestInstaller(githubFetch, async (_executable, args) => {
      if (args.includes('add')) {
        return { exitCode: 1, output: '[ERR_PNPM_UNEXPECTED_STORE] store v10 vs v11' }
      }
      if (args[0] === 'install') return { exitCode: 1, output: 'registry unreachable' }
      return { exitCode: 0, output: '' }
    })

    await expect(installer.installPluginTarget({
      repository: 'yjh051108/dsh-super-injector',
      defaultBranch: 'main',
      targetId: 'demo-plugin:.',
      tarballUrl: 'https://github.com/yjh051108/dsh-super-injector/releases/download/v0.3.3/dsh-super-injector-0.3.3.tgz',
    })).rejects.toThrow(/迁移失败/)
    // 只迁移一次，没有进入死循环。
    const migrateCalls = calls.filter(call => call.args[0] === 'install')
    expect(migrateCalls).toHaveLength(1)
  })
})

describe('installPreset（meta-repo 子模块 agent 预设）', () => {
  it('下载预设 zip 并复制到 .agent-presets/<name>，返回已安装列表，不触发 CLI', async () => {
    const zip = new AdmZip()
    zip.addFile('preset-repo-main/preset/router-standard/preset.yml', Buffer.from('name: router-standard\n'))
    zip.addFile('preset-repo-main/preset/router-standard/routing/rules.yml', Buffer.from('rules'))
    const archive = zip.toBuffer()
    const githubFetch = (async () => new Response(new Uint8Array(archive), {
      status: 200,
      headers: { 'content-length': String(archive.byteLength) },
    })) as typeof fetch

    const { installer, calls } = createTestInstaller(githubFetch)
    const result = await installer.installPreset({
      repository: 'yjh051108/dsh-router-standard',
      targetId: 'router-standard:preset/router-standard',
      name: 'router-standard',
      sourcePath: 'preset/router-standard',
      revision: 'e'.repeat(40),
    })

    expect(result.installedPreset.name).toBe('router-standard')
    expect(result.installedPreset.path).toBe(path.join(settings.dshHome, '.agent-presets', 'router-standard'))
    expect(result.installedPresets.map(preset => preset.name)).toEqual(['router-standard'])
    expect(await readFile(path.join(settings.dshHome, '.agent-presets', 'router-standard', 'preset.yml'), 'utf8')).toContain('name: router-standard')
    expect(await readFile(path.join(settings.dshHome, '.agent-presets', 'router-standard', 'routing', 'rules.yml'), 'utf8')).toBe('rules')
    // 预设是目录复制，不经过 dsh CLI。
    expect(calls).toHaveLength(0)
  })

  it('readInstalledPresets 返回 .agent-presets 里全部已安装预设', async () => {
    const { installer } = createTestInstaller()
    await mkdir(path.join(settings.dshHome, '.agent-presets', 'router-standard'), { recursive: true })
    await writeFile(path.join(settings.dshHome, '.agent-presets', 'router-standard', 'preset.yml'), 'name: router-standard\n')

    const presets = await installer.readInstalledPresets()
    expect(presets.map(preset => preset.name)).toEqual(['router-standard'])
  })
})
