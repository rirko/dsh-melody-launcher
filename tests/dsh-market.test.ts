import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compareDshMarketVersions, createDshMarketService, dshMarketInstallTarget, findDshMarketInstalledAlias, parseDshMarketSourceUrl } from '../electron/dsh-market'
import type { AppSettings } from '../src/types'

const marketSettings: AppSettings = {
  dshInstallPath: 'C:/dsh-runtime',
  dshHome: 'C:/dsh-home-that-does-not-exist',
  profileName: 'web',
  workspace: 'C:/workspace',
  launchExecutable: 'dsh.cmd',
  launchArgs: ['web'],
  webPort: 3090,
  openAfterLaunch: false,
}

describe('dsh-market source rules', () => {
  it('uses npm before GitHub and preserves monorepo subpaths', () => {
    expect(dshMarketInstallTarget({ url: 'https://github.com/a/b', npm: 'dsh-demo' })).toBe('dsh-demo')
    expect(dshMarketInstallTarget({ url: 'https://github.com/a/b', npm: 'dsh-demo' }, '0.1.0-rc.7')).toBe('dsh-demo@0.1.0-rc.7')
    expect(dshMarketInstallTarget({ url: 'https://github.com/a/b/tree/main/packages/demo', npm: null })).toBe('github:a/b#path:/packages/demo')
    expect(parseDshMarketSourceUrl('https://github.com/a/b/tree/main/../secret')).toBeNull()
  })

  it('matches the same curated entry but keeps different GitHub sources apart', () => {
    const entry = { name: 'dsh-demo', owner: 'a', url: 'https://github.com/a/b', npm: null }
    expect(findDshMarketInstalledAlias(entry, { 'dsh-demo': 'github:a/b' })).toBe('dsh-demo')
    expect(findDshMarketInstalledAlias(entry, { 'dsh-demo': 'github:x/y' })).toBeNull()
    expect(findDshMarketInstalledAlias({ ...entry, npm: 'dsh-demo' }, { 'dsh-demo': 'dsh-demo' })).toBe('dsh-demo')
  })

  it('only treats a newer npm version as an update', () => {
    expect(compareDshMarketVersions('1.0.0', '1.1.0')).toBeLessThan(0)
    expect(compareDshMarketVersions('1.1.0', '1.0.0')).toBeGreaterThan(0)
    expect(compareDshMarketVersions('git', '1.0.0')).toBeNull()
  })

  it('does not run remote update checks while reading the catalog', async () => {
    const requests: string[] = []
    const progress: string[] = []
    const service = createDshMarketService({
      readSettings: async () => marketSettings,
      prepareNodeRuntime: async () => { throw new Error('not used while reading') },
      preparePnpmRuntime: async () => { throw new Error('not used while reading') },
      fetchImpl: async input => {
        requests.push(String(input))
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            updated: '2026-08-22',
            count: 1,
            categories: {},
            plugins: [{ name: 'demo', owner: 'owner', url: 'https://github.com/owner/demo', category: 'plugin', npm: 'demo' }],
          }),
        } as unknown as Response
      },
      emitProgress: event => progress.push(event.phase),
      emitOutput: () => undefined,
    })

    const [first, second] = await Promise.all([service.load(), service.load()])
    expect(first.plugins[0]?.name).toBe('demo')
    expect(second.plugins[0]?.name).toBe('demo')
    expect(requests).toEqual(['https://awesome-dsh-plugin.com/plugins.json'])
    expect(progress.at(-1)).toBe('complete')
  })

  it('uninstalls locally without loading the remote market registry', async () => {
    const requests: string[] = []
    const removed: string[] = []
    const service = createDshMarketService({
      readSettings: async () => marketSettings,
      prepareNodeRuntime: async () => { throw new Error('not used by local uninstall') },
      preparePnpmRuntime: async () => { throw new Error('not used by local uninstall') },
      fetchImpl: async input => {
        requests.push(String(input))
        throw new Error('remote request is forbidden during uninstall')
      },
      removePluginLocally: async packageName => { removed.push(packageName) },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await service.uninstall('demo-package')
    expect(removed).toEqual(['demo-package'])
    expect(requests).toEqual([])
  })

  it('migrates an old Profile store before retrying a plugin operation', async () => {
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => marketSettings,
      prepareNodeRuntime: async () => ({ root: 'C:/node', node: 'C:/node/node.exe', npm: 'C:/node/npm.cmd', npx: 'C:/node/npx.cmd', managed: true }),
      preparePnpmRuntime: async () => ({ root: 'C:/pnpm', executable: 'C:/pnpm/pnpm.cmd' }),
      packageStoreRoot: 'C:/launcher/plugin-store',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ plugins: [{ name: 'demo', owner: 'owner', url: 'https://github.com/owner/demo', category: 'plugin' }] }),
      } as unknown as Response),
      runCommand: async (_executable, args, options) => {
        calls.push({ args, cwd: options.cwd, env: options.env })
        if (args.includes('add')) {
          addRuns += 1
          return addRuns === 1
            ? { exitCode: 1, output: '[ERR_PNPM_UNEXPECTED_STORE] linked from the system store' }
            : { exitCode: 0, output: 'done' }
        }
        return { exitCode: 0, output: 'Done in 1s' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    // The fake command does not create a real package, so the post-install
    // verification is expected to fail after the migration/retry sequence.
    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    const migration = calls.find(call => call.args[0] === 'install')
    expect(migration?.cwd).toBe(path.join(marketSettings.dshHome, 'profiles', 'web'))
    expect(migration?.env.PNPM_CONFIG_STORE_DIR).toBe('C:/launcher/plugin-store')
  })
})

// ---------------------------------------------------------------------------
// 网络镜像 / 构建审批 / workspace→npm 回退
// ---------------------------------------------------------------------------

async function tempProfile(): Promise<{ root: string; profileDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-market-recovery-'))
  const profileDir = path.join(root, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'web', private: true, dependencies: {} }))
  return { root, profileDir }
}

function registryResponse(plugins: Array<{ name: string; owner: string; url: string; category: string; npm?: string | null }>) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ updated: '2026-08-25', count: plugins.length, categories: {}, plugins }),
  } as unknown as Response
}

describe('dsh-market network & recovery paths', () => {
  const node = async () => ({ root: 'C:/node', node: 'C:/node/node.exe', npm: 'C:/node/npm.cmd', npx: 'C:/node/npx.cmd', managed: true })
  const pnpm = async () => ({ root: 'C:/pnpm', executable: 'C:/pnpm/pnpm.cmd' })

  it('parses the monorepo branch from a GitHub tree URL', () => {
    expect(parseDshMarketSourceUrl('https://github.com/a/b/tree/main/packages/demo')).toEqual({ repo: 'a/b', subpath: 'packages/demo', branch: 'main' })
    expect(parseDshMarketSourceUrl('https://github.com/a/b')).toEqual({ repo: 'a/b', subpath: null, branch: null })
  })

  it('matches an installed npm alias back to its curated entry', () => {
    const entry = { name: 'dsh-web-ui#dsh-web-ui-all', owner: 'a', url: 'https://github.com/a/dsh-web-ui/tree/main/packages/dsh-web-ui-all', npm: null }
    expect(findDshMarketInstalledAlias(entry, { '@linxin/dsh-web-ui-all': '0.1.0' })).toBeNull()
    expect(findDshMarketInstalledAlias(entry, { '@linxin/dsh-web-ui-all': '0.1.0' }, '@linxin/dsh-web-ui-all')).toBe('@linxin/dsh-web-ui-all')
  })

  it('auto-approves pnpm-11 git build scripts before retrying the add', async () => {
    const { root, profileDir } = await tempProfile()
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async () => registryResponse([{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }]),
      runCommand: async (_executable, args) => {
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1
          ? {
              exitCode: 1,
              output: 'The git-hosted package "@demo/demo@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.\n' +
                'Hint: Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:\n' +
                'allowBuilds:\n' +
                '  @demo/demo@https://codeload.github.com/a/b/tar.gz/abc#path:/packages/demo: true\n',
            }
          : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    const workspace = parse(await readFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(Object.keys((workspace as { allowBuilds: Record<string, unknown> }).allowBuilds)).toContain('@demo/demo@https://codeload.github.com/a/b/tar.gz/abc#path:/packages/demo')
    await rm(root, { recursive: true, force: true })
  })

  it('defaults to the npmmirror registry and switches to the official registry on network failure', async () => {
    const { root } = await tempProfile()
    const envs: Array<Record<string, string | undefined>> = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async () => registryResponse([{ name: 'demo', owner: 'a', url: 'https://github.com/a/b', npm: 'demo', category: 'plugin' }]),
      runCommand: async (_executable, args, options) => {
        envs.push(options.env)
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1 ? { exitCode: 1, output: 'ERR_PNPM_FETCH_500 ECONNRESET socket hang up' } : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    expect(envs[0].npm_config_registry).toBe('https://registry.npmmirror.com')
    expect(envs[1].npm_config_registry).toBe('https://registry.npmjs.org')
    await rm(root, { recursive: true, force: true })
  })

  it('falls back to the npm package when the git subpackage uses workspace deps', async () => {
    const { root } = await tempProfile()
    const calls: string[] = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async input => {
        const url = String(input)
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ name: '@linxin/demo', version: '0.2.0' }) } as unknown as Response
        }
        return registryResponse([{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }])
      },
      runCommand: async (_executable, args) => {
        calls.push(args.join(' '))
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1
          ? { exitCode: 1, output: 'In C:\dsh: "@linxin/demo@workspace:*" is in the dependencies but no package named "@linxin/demo" is present in the workspace (WORKSPACE_PKG_NOT_FOUND)' }
          : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    expect(calls).toEqual([
      'plugin --profile web add github:a/b#path:/packages/demo',
      'plugin --profile web add @linxin/demo@0.2.0 --ignore-scripts',
    ])
    await rm(root, { recursive: true, force: true })
  })
})

describe('dsh-market npm fallback search & activation', () => {
  const node = async () => ({ root: 'C:/node', node: 'C:/node/node.exe', npm: 'C:/node/npm.cmd', npx: 'C:/node/npx.cmd', managed: true })
  const pnpm = async () => ({ root: 'C:/pnpm', executable: 'C:/pnpm/pnpm.cmd' })

  it('falls back via the npm mirror search when the GitHub raw fetch is unreachable', async () => {
    const { root } = await tempProfile()
    const calls: string[] = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async input => {
        const url = String(input)
        if (url.includes('/-/v1/search')) {
          return {
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ objects: [{ package: { name: '@linxin/demo' } }, { package: { name: 'unrelated-tool' } }] }),
          } as unknown as Response
        }
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: false, status: 404, headers: { get: () => null } } as unknown as Response
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ updated: 'x', count: 1, categories: {}, plugins: [{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }] }),
        } as unknown as Response
      },
      runCommand: async (_executable, args) => {
        calls.push(args.join(' '))
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1 ? { exitCode: 1, output: 'ECONNRESET socket hang up' } : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    expect(calls).toEqual([
      'plugin --profile web add github:a/b#path:/packages/demo',
      'plugin --profile web add @linxin/demo --ignore-scripts',
    ])
    await rm(root, { recursive: true, force: true })
  })

  it('activates the installed npm fallback package into the profile bundles', async () => {
    const { root, profileDir } = await tempProfile()
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async input => {
        const url = String(input)
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ name: '@linxin/demo', version: '0.2.0' }) } as unknown as Response
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ updated: 'x', count: 1, categories: {}, plugins: [{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }] }),
        } as unknown as Response
      },
      runCommand: async (_executable, args) => {
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        if (addRuns === 1) return { exitCode: 1, output: 'WORKSPACE_PKG_NOT_FOUND workspace:*' }
        // 模拟 pnpm add 成功：写入依赖与可加载的 bundle 包。
        const manifestPath = path.join(profileDir, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.dependencies = { '@linxin/demo': '0.2.0' }
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        await mkdir(path.join(profileDir, 'node_modules', '@linxin', 'demo'), { recursive: true })
        await writeFile(
          path.join(profileDir, 'node_modules', '@linxin', 'demo', 'package.json'),
          JSON.stringify({ name: '@linxin/demo', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
          'utf8',
        )
        return { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    const installed = await service.install('demo')
    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('@linxin/demo')
    expect(installed.some(item => item.name === 'demo' && item.installed)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
})
