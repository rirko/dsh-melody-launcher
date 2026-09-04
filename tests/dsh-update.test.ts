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
