import { describe, expect, it } from 'vitest'
import { checkDshUpdate, compareVersions, normalizeVersion } from '../electron/dsh-update'
import type { DshInstallationStatus } from '../src/types'

const installed = (version: string): DshInstallationStatus => ({
  installed: true,
  version,
  executable: '/tmp/dsh',
  source: 'launcher',
})

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function githubFetch(remoteVersion: string, packagePath = 'apps/cli/package.json', packageName = '@deepseek-ai/dsh'): typeof fetch {
  return (async input => {
    const url = String(input)
    if (url.endsWith('/repos/deepseek-ai/deepseek-harness/')) {
      return new Response(JSON.stringify({ default_branch: 'master' }), { status: 200 })
    }
    if (url.includes(`/contents/${packagePath}?ref=master`)) {
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: encoded({ name: packageName, version: remoteVersion }),
      }), { status: 200 })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

describe('DSH update check', () => {
  it('normalizes a leading v for comparison', () => {
    expect(normalizeVersion(' v1.2.3 ')).toBe('1.2.3')
    expect(compareVersions('0.1.0-rc.5', '0.1.0-rc.6')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-rc.6', '0.1.0-rc.5')).toBeLessThan(0)
  })

  it('does not make a network request when DSH is not installed', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('', { status: 500 })
    }) as typeof fetch
    await expect(checkDshUpdate({ installed: false, version: null, executable: null, source: null }, fetchImpl)).resolves.toMatchObject({
      state: 'not-installed',
      localVersion: null,
      remoteVersion: null,
    })
    expect(calls).toBe(0)
  })

  it('reports an update when the official package version differs', async () => {
    await expect(checkDshUpdate(installed('0.1.0-rc.5'), githubFetch('0.1.0-rc.6'))).resolves.toMatchObject({
      state: 'update-available',
      localVersion: '0.1.0-rc.5',
      remoteVersion: '0.1.0-rc.6',
    })
  })

  it('accepts an equivalent v-prefixed remote version', async () => {
    await expect(checkDshUpdate(installed('0.1.0-rc.6'), githubFetch('v0.1.0-rc.6'))).resolves.toMatchObject({
      state: 'up-to-date',
      remoteVersion: 'v0.1.0-rc.6',
    })
  })

  it('does not offer a downgrade when the local version is newer', async () => {
    await expect(checkDshUpdate(installed('0.1.0-rc.6'), githubFetch('0.1.0-rc.5'))).resolves.toMatchObject({
      state: 'up-to-date',
      message: '本地 DSH 0.1.0-rc.6 高于仓库版本 0.1.0-rc.5。',
    })
  })

  it('falls back to the repository root package manifest', async () => {
    await expect(checkDshUpdate(installed('0.1.0-rc.5'), githubFetch('0.1.0-rc.6', 'package.json', '@deepseek-ai/dsh-root'))).resolves.toMatchObject({
      state: 'update-available',
      remoteVersion: '0.1.0-rc.6',
    })
  })

  it('returns an error state without failing the caller when GitHub is unavailable', async () => {
    const fetchImpl = (async () => new Response('', { status: 503 })) as typeof fetch
    await expect(checkDshUpdate(installed('0.1.0-rc.5'), fetchImpl)).resolves.toMatchObject({
      state: 'error',
      localVersion: '0.1.0-rc.5',
      remoteVersion: null,
    })
  })
})

const MIRROR = 'https://registry.npmmirror.com'
const OFFICIAL = 'https://registry.npmjs.org'

/** registry 形态的 fetch：按 URL 前缀决定哪个源可用，其余 404（含 GitHub 路径）。 */
function registryFetch(available: Partial<Record<string, string | 'bad'>>, fallback = 404): typeof fetch {
  return (async input => {
    const url = String(input)
    for (const [base, value] of Object.entries(available)) {
      if (url.startsWith(`${base}/@deepseek-ai%2Fdsh/latest`)) {
        if (value === 'bad') return new Response('not json', { status: 200 })
        return new Response(JSON.stringify({ version: value }), { status: 200 })
      }
    }
    return new Response('', { status: fallback })
  }) as typeof fetch
}

describe('DSH update check via npm registry', () => {
  it('镜像命中即返回版本，不再请求官方源与 GitHub', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith(`${MIRROR}/@deepseek-ai%2Fdsh/latest`)) {
        return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch
    await expect(checkDshUpdate(installed('0.1.0'), fetchImpl, [MIRROR, OFFICIAL])).resolves.toMatchObject({
      state: 'update-available',
      remoteVersion: '0.2.0',
    })
    expect(calls.some(u => u.includes(OFFICIAL) || u.includes('github.com'))).toBe(false)
  })

  it('镜像 404 时回退官方源', async () => {
    await expect(checkDshUpdate(installed('0.1.0'), registryFetch({ [OFFICIAL]: '0.1.0' }), [MIRROR, OFFICIAL])).resolves.toMatchObject({
      state: 'up-to-date',
      remoteVersion: '0.1.0',
    })
  })

  it('registry 返回非法内容视为失败并继续回退', async () => {
    await expect(checkDshUpdate(installed('0.1.0'), registryFetch({ [MIRROR]: 'bad', [OFFICIAL]: '0.3.1' }), [MIRROR, OFFICIAL])).resolves.toMatchObject({
      state: 'update-available',
      remoteVersion: '0.3.1',
    })
  })

  it('registry 全部失败回退 GitHub contents', async () => {
    // githubFetch 对 registry URL 返回 404，对 GitHub 路径返回版本清单。
    const both = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/latest')) return new Response('', { status: 404 })
      return githubFetch('0.1.0-rc.6')(input)
    }) as typeof fetch
    await expect(checkDshUpdate(installed('0.1.0-rc.5'), both, [MIRROR, OFFICIAL])).resolves.toMatchObject({
      state: 'update-available',
      remoteVersion: '0.1.0-rc.6',
    })
  })

  it('重复与空候选去重', async () => {
    await expect(checkDshUpdate(installed('0.1.0'), registryFetch({ [MIRROR]: '0.1.0' }), [MIRROR, `${MIRROR}/`, '  '])).resolves.toMatchObject({
      state: 'up-to-date',
    })
  })
})
