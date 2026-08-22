import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
