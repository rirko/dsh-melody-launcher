import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitHubAuthService, isGitHubRequest } from '../electron/github-auth'

let temporaryRoot = ''

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-github-auth-'))
})

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

const cipher = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from(`encrypted:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
  decrypt: (value: Buffer) => Buffer.from(value.toString('utf8').replace(/^encrypted:/, ''), 'base64').toString('utf8'),
}

function userResponse(login = 'rirko'): Response {
  return new Response(JSON.stringify({ login, name: 'Rirko', avatar_url: 'https://avatars.githubusercontent.com/u/1' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-oauth-scopes': 'repo, workflow, read:user',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': '1800000000',
    },
  })
}

describe('GitHub account service', () => {
  it('verifies a token, encrypts it at rest, and authenticates every GitHub host request', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const headers = new Headers(init?.headers)
      seen.push({ url, authorization: headers.get('authorization') })
      if (url === 'https://api.github.com/user') return userResponse()
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    const service = createGitHubAuthService({ filePath, cipher, fetchImpl })

    const status = await service.loginWithToken('github_pat_test_token_1234567890')
    expect(status).toMatchObject({
      authenticated: true,
      login: 'rirko',
      method: 'token',
      scopes: ['repo', 'workflow', 'read:user'],
      rateLimit: { limit: 5000, remaining: 4999 },
    })
    expect((await readFile(filePath, 'utf8')).startsWith('encrypted:')).toBe(true)
    expect(await readFile(filePath, 'utf8')).not.toContain('github_pat_test_token_1234567890')

    await service.fetch('https://api.github.com/repos/rirko/example')
    await service.fetch('https://raw.githubusercontent.com/rirko/example/main/package.json')
    await service.fetch('https://codeload.github.com/rirko/example/zip/main')
    await service.fetch('https://registry.npmjs.org/example')

    expect(seen.slice(1, 4).every(request => request.authorization === 'Bearer github_pat_test_token_1234567890')).toBe(true)
    expect(seen[4].authorization).toBeNull()
  })

  it('loads an encrypted session in a new service instance and clears it on logout', async () => {
    const fetchImpl = (async () => userResponse('melody')) as typeof fetch
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    const first = createGitHubAuthService({ filePath, cipher, fetchImpl })
    await first.loginWithToken('github_pat_reload_token_1234567890')

    const reloaded = createGitHubAuthService({ filePath, cipher, fetchImpl })
    await expect(reloaded.getStatus()).resolves.toMatchObject({ authenticated: true, login: 'melody' })
    await expect(reloaded.logout()).resolves.toMatchObject({ authenticated: false })
    await expect(reloaded.getStatus()).resolves.toMatchObject({ authenticated: false })
  })

  it('safeStorage 暂时不可用时不缓存为永久未登录', async () => {
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    let available = true
    const first = createGitHubAuthService({ filePath, cipher: { ...cipher, isAvailable: () => available }, fetchImpl: (async () => userResponse('startup-user')) as typeof fetch })
    await first.loginWithToken('github_pat_startup_token_1234567890')

    available = false
    const reloaded = createGitHubAuthService({ filePath, cipher: { ...cipher, isAvailable: () => available }, fetchImpl: (async () => userResponse('startup-user')) as typeof fetch })
    await expect(reloaded.getStatus()).resolves.toMatchObject({ authenticated: false })
    available = true
    await expect(reloaded.getStatus()).resolves.toMatchObject({ authenticated: true, login: 'startup-user' })
  })

  it('shares the initial session read across concurrent status and GitHub requests', async () => {
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    const first = createGitHubAuthService({ filePath, cipher, fetchImpl: (async () => userResponse('concurrent-user')) as typeof fetch })
    await first.loginWithToken('github_pat_concurrent_token_1234567890')

    const requests: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const headers = new Headers(init?.headers)
      requests.push({ url, authorization: headers.get('authorization') })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const reloaded = createGitHubAuthService({ filePath, cipher, fetchImpl })

    const statusPromise = reloaded.getStatus()
    const requestPromise = reloaded.fetch('https://api.github.com/repos/rirko/example')

    await expect(statusPromise).resolves.toMatchObject({ authenticated: true, login: 'concurrent-user' })
    await requestPromise
    expect(requests).toEqual([{
      url: 'https://api.github.com/repos/rirko/example',
      authorization: 'Bearer github_pat_concurrent_token_1234567890',
    }])
  })

  it('在普通 GitHub 请求收到 401 后先验证 /user，再自动重试一次', async () => {
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    let userChecks = 0
    let repositoryAttempts = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://api.github.com/user') {
        userChecks += 1
        return userResponse(userChecks === 1 ? 'initial-user' : 'refreshed-user')
      }
      if (url === 'https://api.github.com/repos/rirko/example') {
        repositoryAttempts += 1
        return new Response('{}', { status: repositoryAttempts === 1 ? 401 : 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const service = createGitHubAuthService({ filePath, cipher, fetchImpl })

    await service.loginWithToken('github_pat_retry_token_1234567890')
    const response = await service.fetch('https://api.github.com/repos/rirko/example')

    expect(response.status).toBe(200)
    expect(repositoryAttempts).toBe(2)
    expect(userChecks).toBe(2)
    await expect(service.getStatus()).resolves.toMatchObject({ authenticated: true, login: 'refreshed-user' })
    await expect(readFile(filePath)).resolves.toBeTruthy()
  })

  it('只有 /user 确认返回 401 时才清除登录凭据', async () => {
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    let userChecks = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://api.github.com/user') {
        userChecks += 1
        return userChecks === 1 ? userResponse('valid-until-request') : new Response('{}', { status: 401 })
      }
      if (url === 'https://api.github.com/repos/rirko/example') return new Response('{}', { status: 401 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const service = createGitHubAuthService({ filePath, cipher, fetchImpl })

    await service.loginWithToken('github_pat_invalidated_token_1234567890')
    await expect(service.fetch('https://api.github.com/repos/rirko/example')).resolves.toMatchObject({ status: 401 })
    await expect(service.getStatus()).resolves.toMatchObject({ authenticated: false })
    await expect(readFile(filePath)).rejects.toThrow()
  })

  it('验证 /user 遇到网络或服务器错误时保留登录状态', async () => {
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    let userChecks = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://api.github.com/user') {
        userChecks += 1
        return userChecks === 1 ? userResponse('transient-user') : new Response('{}', { status: 503 })
      }
      if (url === 'https://api.github.com/repos/rirko/example') return new Response('{}', { status: 401 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const service = createGitHubAuthService({ filePath, cipher, fetchImpl })

    await service.loginWithToken('github_pat_transient_token_1234567890')
    await expect(service.fetch('https://api.github.com/repos/rirko/example')).resolves.toMatchObject({ status: 401 })
    await expect(service.getStatus()).resolves.toMatchObject({ authenticated: true, login: 'transient-user' })
    await expect(readFile(filePath)).resolves.toBeTruthy()
  })

  it('completes OAuth Device Flow after GitHub reports authorization_pending', async () => {
    let tokenPolls = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/login/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device-secret',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }), { status: 200 })
      }
      if (url.endsWith('/login/oauth/access_token')) {
        tokenPolls += 1
        return tokenPolls === 1
          ? new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 })
          : new Response(JSON.stringify({ access_token: 'gho_device_token_1234567890', scope: 'repo workflow read:user' }), { status: 200 })
      }
      if (url === 'https://api.github.com/user') return userResponse('device-user')
      return new Response('', { status: 404 })
    }) as typeof fetch
    const service = createGitHubAuthService({
      filePath: path.join(temporaryRoot, 'github-auth.bin'),
      cipher,
      clientId: 'Iv1.test-client',
      fetchImpl,
      delay: async () => undefined,
    })

    await expect(service.beginDeviceLogin()).resolves.toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
    })
    await expect(service.completeDeviceLogin()).resolves.toMatchObject({
      authenticated: true,
      login: 'device-user',
      method: 'oauth',
    })
    expect(tokenPolls).toBe(2)
  })

  it('requires an OAuth client ID for browser login and refuses plaintext storage', async () => {
    const filePath = path.join(temporaryRoot, 'github-auth.bin')
    const noOAuth = createGitHubAuthService({ filePath, cipher, fetchImpl: (async () => userResponse()) as typeof fetch })
    await expect(noOAuth.beginDeviceLogin()).rejects.toThrow(/OAuth Client ID/)

    const unavailable = createGitHubAuthService({
      filePath,
      cipher: { ...cipher, isAvailable: () => false },
      fetchImpl: (async () => userResponse()) as typeof fetch,
    })
    await expect(unavailable.loginWithToken('github_pat_plaintext_1234567890')).rejects.toThrow(/安全凭据存储/)
  })

  it('reads and changes repository stars through the authenticated GitHub API', async () => {
    const calls: Array<{ url: string; method: string }> = []
    let starred = false
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url === 'https://api.github.com/user') return userResponse('star-user')
      if (url.endsWith('/user/starred/demo/repository')) {
        if (method === 'GET') return new Response(starred ? null : '', { status: starred ? 204 : 404 })
        starred = method === 'PUT'
        return new Response(null, { status: 204 })
      }
      if (url.includes('/search/issues?')) {
        return new Response(JSON.stringify({ items: [{
          number: 7,
          title: 'catalog: batch update',
          html_url: 'https://github.com/rirko/dsh-melody-launcher/pull/7',
          state: 'open',
          draft: false,
          user: { login: 'star-user' },
          created_at: '2026-08-18T00:00:00Z',
          updated_at: '2026-08-18T01:00:00Z',
          pull_request: { merged_at: null },
        }] }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch
    const service = createGitHubAuthService({ filePath: path.join(temporaryRoot, 'github-auth.bin'), cipher, fetchImpl })
    await service.loginWithToken('github_pat_star_test_token_1234567890')
    await expect(service.getStarStatus('demo/repository')).resolves.toBe(false)
    await expect(service.setStar('demo/repository', true)).resolves.toBe(true)
    await expect(service.setStar('demo/repository', false)).resolves.toBe(false)
    await expect(service.listRecentPullRequests()).resolves.toMatchObject([{ number: 7, author: 'star-user' }])
    expect(calls.filter(call => call.url.endsWith('/user/starred/demo/repository'))).toEqual([
      { url: 'https://api.github.com/user/starred/demo/repository', method: 'GET' },
      { url: 'https://api.github.com/user/starred/demo/repository', method: 'PUT' },
      { url: 'https://api.github.com/user/starred/demo/repository', method: 'DELETE' },
    ])
  })
})

describe('GitHub request host filter', () => {
  it('only authenticates known GitHub hosts', () => {
    expect(isGitHubRequest('https://api.github.com/user')).toBe(true)
    expect(isGitHubRequest('https://raw.githubusercontent.com/a/b/main/x')).toBe(true)
    expect(isGitHubRequest('https://codeload.github.com/a/b/zip/main')).toBe(true)
    expect(isGitHubRequest('https://github.com.evil.example/a/b')).toBe(false)
    expect(isGitHubRequest('https://registry.npmjs.org/a')).toBe(false)
  })
})
