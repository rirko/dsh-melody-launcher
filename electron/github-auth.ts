import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  GitHubAuthStatus,
  GitHubDeviceAuthorization,
  GitHubPullRequestSummary,
} from '../src/types'
import { LAUNCHER_REPOSITORY } from '../src/constants'

const GITHUB_API_ROOT = 'https://api.github.com'
const DEVICE_CODE_ENDPOINT = 'https://github.com/login/device/code'
const ACCESS_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token'
const REQUESTED_SCOPES = ['read:user', 'user:email', 'repo', 'workflow'] as const
const GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'uploads.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

interface GitHubStoredSession {
  version: 1
  token: string
  method: 'oauth' | 'token'
  login: string
  name: string | null
  avatarUrl: string | null
  scopes: string[]
}

interface GitHubUserResponse {
  login?: unknown
  name?: unknown
  avatar_url?: unknown
}

interface DeviceCodeResponse {
  device_code?: unknown
  user_code?: unknown
  verification_uri?: unknown
  expires_in?: unknown
  interval?: unknown
  error?: unknown
  error_description?: unknown
}

interface AccessTokenResponse {
  access_token?: unknown
  token_type?: unknown
  scope?: unknown
  error?: unknown
  error_description?: unknown
  interval?: unknown
}

interface PendingDeviceAuthorization {
  deviceCode: string
  expiresAt: number
  intervalSeconds: number
  cancelled: boolean
}

interface GitHubIssueSearchItem {
  number?: unknown
  title?: unknown
  html_url?: unknown
  state?: unknown
  draft?: unknown
  user?: { login?: unknown }
  created_at?: unknown
  updated_at?: unknown
  pull_request?: { merged_at?: unknown }
  head?: { ref?: unknown }
  base?: { ref?: unknown }
}

export interface GitHubTokenCipher {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export interface GitHubAuthOptions {
  filePath: string
  cipher: GitHubTokenCipher
  clientId?: string
  fetchImpl?: typeof fetch
  now?: () => number
  delay?: (milliseconds: number) => Promise<void>
}

export interface GitHubAuthService {
  getStatus(): Promise<GitHubAuthStatus>
  loginWithToken(token: string): Promise<GitHubAuthStatus>
  beginDeviceLogin(): Promise<GitHubDeviceAuthorization>
  completeDeviceLogin(): Promise<GitHubAuthStatus>
  cancelDeviceLogin(): void
  logout(): Promise<GitHubAuthStatus>
  listRecentPullRequests(): Promise<GitHubPullRequestSummary[]>
  getStarStatus(repository: string): Promise<boolean>
  setStar(repository: string, starred: boolean): Promise<boolean>
  createRepository(input: { name: string; description?: string; private?: boolean }): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }>
  upsertRepositoryFile(repository: string, filePath: string, content: string | Uint8Array, message: string, branch?: string): Promise<void>
  readRepositoryFile(repository: string, filePath: string, branch?: string): Promise<Uint8Array>
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseScopes(value: string | null | undefined): string[] {
  return [...new Set((value ?? '')
    .split(/[ ,]+/)
    .map(scope => scope.trim())
    .filter(Boolean))]
}

function rateFromHeaders(headers: Headers): GitHubAuthStatus['rateLimit'] {
  const limit = Number(headers.get('x-ratelimit-limit'))
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null
  return {
    limit,
    remaining,
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  }
}

function isGitHubRequest(input: string | URL | Request): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return GITHUB_HOSTS.has(new URL(raw).hostname.toLowerCase())
  } catch {
    return false
  }
}

function unauthenticatedStatus(oauthAvailable: boolean): GitHubAuthStatus {
  return {
    authenticated: false,
    login: null,
    name: null,
    avatarUrl: null,
    scopes: [],
    method: null,
    oauthAvailable,
    rateLimit: null,
  }
}

function statusFromSession(
  session: GitHubStoredSession,
  oauthAvailable: boolean,
  rateLimit: GitHubAuthStatus['rateLimit'] = null,
): GitHubAuthStatus {
  return {
    authenticated: true,
    login: session.login,
    name: session.name,
    avatarUrl: session.avatarUrl,
    scopes: [...session.scopes],
    method: session.method,
    oauthAvailable,
    rateLimit,
  }
}

function validateStoredSession(value: unknown): GitHubStoredSession | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<GitHubStoredSession>
  if (raw.version !== 1 || typeof raw.token !== 'string' || !raw.token
    || (raw.method !== 'oauth' && raw.method !== 'token')
    || typeof raw.login !== 'string' || !raw.login) return null
  return {
    version: 1,
    token: raw.token,
    method: raw.method,
    login: raw.login,
    name: optionalString(raw.name),
    avatarUrl: optionalString(raw.avatarUrl),
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
  }
}

function combineHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

async function atomicWrite(filePath: string, contents: Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, contents, { mode: 0o600 })
    await rm(filePath, { force: true })
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function createGitHubAuthService(options: GitHubAuthOptions): GitHubAuthService {
  const fetchImpl = options.fetchImpl ?? fetch
  const clientId = options.clientId?.trim() ?? ''
  const oauthAvailable = clientId.length > 0
  const now = options.now ?? Date.now
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  let loaded = false
  let loading: Promise<GitHubStoredSession | null> | null = null
  let session: GitHubStoredSession | null = null
  let lastRateLimit: GitHubAuthStatus['rateLimit'] = null
  let pending: PendingDeviceAuthorization | null = null

  const load = async (): Promise<GitHubStoredSession | null> => {
    if (loaded) return session
    if (loading) return loading
    loading = (async () => {
      let cacheReadComplete = false
      try {
        // Electron may report safeStorage as unavailable briefly during app
        // startup. Do not cache that transient state as a permanent logout;
        // the next status request should retry reading the encrypted file.
        if (!options.cipher.isAvailable()) return null
        const encrypted = await readFile(options.filePath)
        session = validateStoredSession(JSON.parse(options.cipher.decrypt(encrypted)))
        if (!session) await rm(options.filePath, { force: true })
        cacheReadComplete = true
      } catch {
        session = null
        cacheReadComplete = true
      } finally {
        if (cacheReadComplete) loaded = true
      }
      return session
    })()
    try {
      return await loading
    } finally {
      loading = null
    }
  }

  const save = async (next: GitHubStoredSession): Promise<void> => {
    if (!options.cipher.isAvailable()) {
      throw new Error('当前系统无法使用安全凭据存储，GitHub 登录信息不会以明文保存。')
    }
    // Wait for an in-flight read so it cannot overwrite the newly saved session.
    if (loading) await loading
    const encrypted = options.cipher.encrypt(JSON.stringify(next))
    await atomicWrite(options.filePath, encrypted)
    loaded = true
    session = next
  }

  const clear = async (): Promise<void> => {
    if (loading) await loading
    loaded = true
    session = null
    lastRateLimit = null
    pending = null
    await rm(options.filePath, { force: true })
  }

  const verifyToken = async (
    token: string,
    method: GitHubStoredSession['method'],
    fallbackScopes: string[] = [],
  ): Promise<GitHubStoredSession> => {
    const response = await fetchImpl(`${GITHUB_API_ROOT}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'DSH-Launcher',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (response.status === 401) throw new Error('GitHub 拒绝了该凭据，请检查令牌是否有效。')
    if (!response.ok) throw new Error(`GitHub 登录验证失败（HTTP ${response.status}）。`)
    const user = await response.json() as GitHubUserResponse
    const login = optionalString(user.login)
    if (!login) throw new Error('GitHub 没有返回有效的账号信息。')
    lastRateLimit = rateFromHeaders(response.headers)
    return {
      version: 1,
      token,
      method,
      login,
      name: optionalString(user.name),
      avatarUrl: optionalString(user.avatar_url),
      scopes: parseScopes(response.headers.get('x-oauth-scopes')).length > 0
        ? parseScopes(response.headers.get('x-oauth-scopes'))
        : fallbackScopes,
    }
  }

  const authorizedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const current = await load()
    const headers = combineHeaders(input, init)
    if (current && isGitHubRequest(input) && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${current.token}`)
    }
    const response = await fetchImpl(input, { ...init, headers })
    if (isGitHubRequest(input)) {
      lastRateLimit = rateFromHeaders(response.headers) ?? lastRateLimit
      if (current && response.status === 401) {
        // A single endpoint 401 is not enough evidence that the token is dead:
        // proxies, stale requests, and endpoint-specific authorization can all
        // produce it. Verify the session against GitHub's canonical /user
        // endpoint before changing the persisted login state.
        let verified: GitHubStoredSession | null = null
        let credentialRejected = false
        try {
          verified = await verifyToken(current.token, current.method, current.scopes)
        } catch (error) {
          credentialRejected = error instanceof Error && error.message === 'GitHub 拒绝了该凭据，请检查令牌是否有效。'
          if (!credentialRejected) return response
        }

        if (credentialRejected) {
          // Only a confirmed /user 401 may clear the encrypted session file.
          // An older request must not clear a newer session created while the
          // verification request was in flight.
          if (session !== current) return response
          await clear()
          return response
        }

        if (!verified || session !== current) return response
        // Keep the refreshed account metadata (name/avatar/scopes) in memory and
        // on disk, then retry this request exactly once with the verified token.
        await save(verified)
        const retryHeaders = combineHeaders(input, init)
        retryHeaders.set('Authorization', `Bearer ${verified.token}`)
        const retryResponse = await fetchImpl(input, { ...init, headers: retryHeaders })
        lastRateLimit = rateFromHeaders(retryResponse.headers) ?? lastRateLimit
        return retryResponse
      }
    }
    return response
  }

  const requireSession = async (): Promise<GitHubStoredSession> => {
    const current = await load()
    if (!current) throw new Error('请先登录 GitHub。')
    return current
  }

  const parseRepository = (value: string): { owner: string; repo: string } => {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim())
    if (!match) throw new Error('GitHub 仓库名称无效。')
    return { owner: match[1], repo: match[2] }
  }

  const repositoryApiUrl = (repository: string, suffix = '') => {
    const { owner, repo } = parseRepository(repository)
    return `${GITHUB_API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`
  }

  return {
    async getStatus() {
      const current = await load()
      return current ? statusFromSession(current, oauthAvailable, lastRateLimit) : unauthenticatedStatus(oauthAvailable)
    },

    async loginWithToken(value: string) {
      const token = value.trim()
      if (token.length < 20 || token.length > 512 || /\s/.test(token)) {
        throw new Error('GitHub 访问令牌格式无效。')
      }
      const next = await verifyToken(token, 'token')
      await save(next)
      return statusFromSession(next, oauthAvailable, lastRateLimit)
    },

    async beginDeviceLogin() {
      if (!oauthAvailable) {
        throw new Error('此构建尚未配置 GitHub OAuth Client ID，请暂时使用访问令牌登录。')
      }
      const response = await fetchImpl(DEVICE_CODE_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'DSH-Launcher',
        },
        body: new URLSearchParams({ client_id: clientId, scope: REQUESTED_SCOPES.join(' ') }),
      })
      const result = await response.json() as DeviceCodeResponse
      const deviceCode = optionalString(result.device_code)
      const userCode = optionalString(result.user_code)
      const verificationUri = optionalString(result.verification_uri)
      const expiresIn = Number(result.expires_in)
      const intervalSeconds = Math.max(5, Number(result.interval) || 5)
      if (!response.ok || !deviceCode || !userCode || !verificationUri || !Number.isFinite(expiresIn)) {
        throw new Error(optionalString(result.error_description) ?? '无法启动 GitHub 浏览器登录。')
      }
      pending = {
        deviceCode,
        expiresAt: now() + expiresIn * 1000,
        intervalSeconds,
        cancelled: false,
      }
      return {
        userCode,
        verificationUri,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        intervalSeconds,
      }
    },

    async completeDeviceLogin() {
      const currentPending = pending
      if (!currentPending) throw new Error('没有等待完成的 GitHub 登录。')
      while (!currentPending.cancelled && now() < currentPending.expiresAt) {
        await delay(currentPending.intervalSeconds * 1000)
        if (currentPending.cancelled) break
        const response = await fetchImpl(ACCESS_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'DSH-Launcher',
          },
          body: new URLSearchParams({
            client_id: clientId,
            device_code: currentPending.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        })
        const result = await response.json() as AccessTokenResponse
        const token = optionalString(result.access_token)
        if (response.ok && token) {
          const next = await verifyToken(token, 'oauth', parseScopes(optionalString(result.scope)))
          await save(next)
          pending = null
          return statusFromSession(next, oauthAvailable, lastRateLimit)
        }
        const error = optionalString(result.error)
        if (error === 'authorization_pending') continue
        if (error === 'slow_down') {
          currentPending.intervalSeconds += Math.max(5, Number(result.interval) || 5)
          continue
        }
        pending = null
        if (error === 'access_denied') throw new Error('GitHub 登录已被拒绝。')
        if (error === 'expired_token') throw new Error('GitHub 登录码已过期，请重新登录。')
        throw new Error(optionalString(result.error_description) ?? 'GitHub 登录失败。')
      }
      pending = null
      throw new Error(currentPending.cancelled ? 'GitHub 登录已取消。' : 'GitHub 登录码已过期，请重新登录。')
    },

    cancelDeviceLogin() {
      if (pending) pending.cancelled = true
    },

    async logout() {
      await clear()
      return unauthenticatedStatus(oauthAvailable)
    },

    async listRecentPullRequests() {
      const current = await requireSession()
      const query = new URLSearchParams({
        q: `repo:${LAUNCHER_REPOSITORY} is:pr author:${current.login}`,
        sort: 'updated',
        order: 'desc',
        per_page: '30',
      })
      const response = await authorizedFetch(`${GITHUB_API_ROOT}/search/issues?${query.toString()}`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      const body = await response.json().catch(() => null) as { items?: GitHubIssueSearchItem[] } | null
      if (!response.ok) throw new Error(`读取 Melody 提交失败（HTTP ${response.status}）。`)
      return (body?.items ?? []).flatMap((item): GitHubPullRequestSummary[] => {
        const number = Number(item.number)
        const title = optionalString(item.title)
        const url = optionalString(item.html_url)
        const author = optionalString(item.user?.login)
        const createdAt = optionalString(item.created_at)
        const updatedAt = optionalString(item.updated_at)
        if (!Number.isSafeInteger(number) || !title || !url || !author || !createdAt || !updatedAt) return []
        return [{
          number,
          title,
          url,
          state: item.state === 'open' ? 'open' : 'closed',
          draft: item.draft === true,
          author,
          createdAt,
          updatedAt,
          mergedAt: optionalString(item.pull_request?.merged_at),
          headBranch: optionalString(item.head?.ref) ?? '',
          baseBranch: optionalString(item.base?.ref) ?? '',
        }]
      })
    },

    async getStarStatus(repository) {
      const { owner, repo } = parseRepository(repository)
      await requireSession()
      const response = await authorizedFetch(`${GITHUB_API_ROOT}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (response.status === 204) return true
      if (response.status === 404) return false
      throw new Error(`读取仓库星标状态失败（HTTP ${response.status}）。`)
    },

    async setStar(repository, starred) {
      const { owner, repo } = parseRepository(repository)
      await requireSession()
      const response = await authorizedFetch(`${GITHUB_API_ROOT}/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        method: starred ? 'PUT' : 'DELETE',
        headers: { Accept: 'application/vnd.github+json' },
        ...(starred ? { body: '' } : {}),
      })
      if (!response.ok && response.status !== 204) {
        throw new Error(`${starred ? '添加' : '取消'}仓库星标失败（HTTP ${response.status}）。`)
      }
      return starred
    },

    async createRepository(input) {
      const name = input.name.trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new Error('GitHub Profile 仓库名称无效。')
      const response = await authorizedFetch(`${GITHUB_API_ROOT}/user/repos`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: input.description ?? '', private: input.private === true, auto_init: true }),
      })
      const body = await response.json().catch(() => null) as { full_name?: unknown; html_url?: unknown; default_branch?: unknown } | null
      if (response.status === 422) {
        // A repository created by an older launcher may not be recorded in
        // profile.yaml yet. Resolve the name only after GitHub confirms the
        // create conflict, keeping the normal create path to one request.
        const existingResponse = await authorizedFetch(`${GITHUB_API_ROOT}/user/repos?per_page=100&affiliation=owner&sort=created`, {
          headers: { Accept: 'application/vnd.github+json' },
        })
        const existing = existingResponse.ok
          ? await existingResponse.json().catch(() => null) as Array<{ name?: unknown; full_name?: unknown; html_url?: unknown; default_branch?: unknown }>
          : []
        const found = Array.isArray(existing) ? existing.find(item => typeof item.name === 'string' && item.name.toLowerCase() === name.toLowerCase()) : null
        if (found && typeof found.full_name === 'string' && typeof found.html_url === 'string') {
          return { fullName: found.full_name, htmlUrl: found.html_url, defaultBranch: typeof found.default_branch === 'string' && found.default_branch ? found.default_branch : 'main' }
        }
      }
      if (!response.ok || typeof body?.full_name !== 'string' || typeof body.html_url !== 'string') {
        throw new Error(`创建 GitHub Profile 仓库失败（HTTP ${response.status}）。`)
      }
      return { fullName: body.full_name, htmlUrl: body.html_url, defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main' }
    },

    async upsertRepositoryFile(repository, filePath, content, message, branch) {
      const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized || normalized.split('/').some(part => part === '.' || part === '..' || part === '')) throw new Error('GitHub 文件路径无效。')
      const encodedPath = normalized.split('/').map(encodeURIComponent).join('/')
      const url = repositoryApiUrl(repository, `/contents/${encodedPath}`)
      const current = await authorizedFetch(`${url}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`, { headers: { Accept: 'application/vnd.github+json' } })
      const currentBody = await current.json().catch(() => null) as { sha?: unknown } | null
      if (!current.ok && current.status !== 404) throw new Error(`读取 GitHub Profile 文件失败（HTTP ${current.status}）。`)
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
      const response = await authorizedFetch(url, {
        method: 'PUT',
        headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: bytes.toString('base64'), ...(typeof currentBody?.sha === 'string' ? { sha: currentBody.sha } : {}), ...(branch ? { branch } : {}) }),
      })
      if (!response.ok) throw new Error(`写入 GitHub Profile 文件失败（HTTP ${response.status}）。`)
    },

    async readRepositoryFile(repository, filePath, branch) {
      const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized || normalized.split('/').some(part => part === '.' || part === '..' || part === '')) throw new Error('GitHub 文件路径无效。')
      const encodedPath = normalized.split('/').map(encodeURIComponent).join('/')
      const response = await authorizedFetch(`${repositoryApiUrl(repository, `/contents/${encodedPath}`)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`, { headers: { Accept: 'application/vnd.github+json' } })
      const body = await response.json().catch(() => null) as { content?: unknown; encoding?: unknown } | null
      if (!response.ok || body?.encoding !== 'base64' || typeof body.content !== 'string') throw new Error(`读取 GitHub Profile 文件失败（HTTP ${response.status}）。`)
      return Uint8Array.from(Buffer.from(body.content.replace(/\s+/g, ''), 'base64'))
    },

    fetch: authorizedFetch,
  }
}

export { GITHUB_HOSTS, REQUESTED_SCOPES, isGitHubRequest, parseScopes, rateFromHeaders }
