import type { ApiProbeResult, ApiProbeTarget, AppSettings, CustomApiProvider } from '../src/types'
import { readCredential, readDeepSeekApiKey } from './credentials'
import { credentialNameForRoute, listCustomApiProviders } from './custom-api'

/**
 * LLM API 连通性检测。
 *
 * 两级探测：先发零 token 消耗的模型列表请求（GET /models），网关不实现
 * （404/405）时回退一个 1-token 的最小真实请求确认鉴权与端点都可用。
 * 只做可达性判断，不解析业务响应体。
 */

const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_OFFICIAL_MODEL = 'deepseek-chat'
const PROBE_TIMEOUT_MS = 10_000
const ANTHROPIC_VERSION = '2023-06-01'
/** 回退真实请求附带的响应体截断长度，用于错误提示。 */
const ERROR_BODY_LIMIT = 200

export interface ApiProbeOptions {
  readSettings: () => Promise<Pick<AppSettings, 'dshHome'>>
  fetchImpl?: typeof fetch
  /** 以下三项默认连接真实凭据/配置读取，测试时注入替身。 */
  listProviders?: (dshHome: string) => Promise<CustomApiProvider[]>
  readNamedCredential?: (dshHome: string, name: string) => Promise<string | null>
  readOfficialApiKey?: (dshHome: string) => Promise<string | null>
}

export interface ApiProbeService {
  probe(target: ApiProbeTarget): Promise<ApiProbeResult>
}

interface ResolvedEndpoint {
  label: string
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  baseUrl: string
  model: string | null
  apiKey: string | null
  /** 密钥缺失且该端点必须鉴权时，直接以此消息短路返回。 */
  blockedMessage: string | null
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function bearerHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

function anthropicHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }
  if (apiKey) headers['x-api-key'] = apiKey
  return headers
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function createApiProbe(options: ApiProbeOptions): ApiProbeService {
  const fetchImpl = options.fetchImpl ?? fetch
  const listProviders = options.listProviders ?? listCustomApiProviders
  const readNamedCredential = options.readNamedCredential ?? readCredential
  const readOfficialApiKey = options.readOfficialApiKey ?? readDeepSeekApiKey

  async function resolveEndpoint(target: ApiProbeTarget): Promise<ResolvedEndpoint> {
    const { dshHome } = await options.readSettings()
    if (target.target === 'deepseek-official') {
      const apiKey = await readOfficialApiKey(dshHome).catch(() => null)
      return {
        label: 'DeepSeek 官方 API',
        protocol: 'openai-completions',
        baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
        model: DEEPSEEK_OFFICIAL_MODEL,
        apiKey,
        blockedMessage: apiKey
          ? null
          : '尚未配置 DeepSeek API Key，请先在「API 配置」中保存。',
      }
    }
    const providers = await listProviders(dshHome).catch(() => [] as CustomApiProvider[])
    const provider = providers.find(candidate => candidate.route === target.route)
    if (!provider) {
      throw new Error(`未找到路由为「${target.route}」的自定义 API 配置。`)
    }
    const credentialName = provider.credentialName ?? credentialNameForRoute(provider.route)
    const apiKey = provider.hasApiKey
      ? await readNamedCredential(dshHome, credentialName).catch(() => null)
      : null
    const baseUrl = normalizeBaseUrl(provider.baseUrl)
    if (!baseUrl) {
      throw new Error(`自定义 API「${provider.displayName || provider.route}」缺少 Base URL。`)
    }
    return {
      label: provider.displayName || provider.route,
      protocol: provider.protocol,
      baseUrl,
      model: provider.modelIds[0] ?? null,
      apiKey,
      // 本地免鉴权服务允许无密钥探测；密钥声明已配置却读不到时照常探测，让 401 说话。
      blockedMessage: null,
    }
  }

  async function request(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: string }> {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    let body = ''
    try {
      body = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    } catch {
      // 响应体读取失败不影响状态码判定。
    }
    return { status: response.status, body }
  }

  /** 非 2xx 状态的统一分类：429 视为可达（服务端已应答），401/403 为密钥问题，其余为服务错误。 */
  function classifiedFailure(label: string, status: number, body: string, latencyMs: number, usedFallback: boolean): ApiProbeResult {
    const stage = usedFallback ? '真实请求' : '模型列表'
    if (status === 429) {
      return { ok: true, status, latencyMs, usedFallback, message: `${label} 可达但触发限流（HTTP 429），稍后即可正常使用。` }
    }
    if (status === 401 || status === 403) {
      return { ok: false, status, latencyMs, usedFallback, message: `${label} 拒绝了当前密钥（HTTP ${status}），请检查 API Key。` }
    }
    return { ok: false, status, latencyMs, usedFallback, message: `${label} ${stage}请求返回 HTTP ${status}${body ? `：${body}` : '。'}` }
  }

  async function probeEndpoint(endpoint: ResolvedEndpoint): Promise<ApiProbeResult> {
    const { label, protocol, baseUrl, model, apiKey } = endpoint
    // anthropic 约定端点在 /v1 之下；用户若把 baseUrl 填到 /v1 为止则直接复用。
    const apiRoot = protocol === 'anthropic-messages' && !/\/v1$/.test(baseUrl) ? `${baseUrl}/v1` : baseUrl
    const listUrl = protocol === 'anthropic-messages' ? `${apiRoot}/models` : `${baseUrl}/models`
    const listHeaders = protocol === 'anthropic-messages' ? anthropicHeaders(apiKey) : bearerHeaders(apiKey)

    const startedAt = Date.now()
    try {
      const listed = await request(listUrl, { method: 'GET', headers: listHeaders })
      if (listed.status >= 200 && listed.status < 300) {
        return { ok: true, status: listed.status, latencyMs: Date.now() - startedAt, usedFallback: false, message: `${label} 连接正常（${Date.now() - startedAt}ms）。` }
      }
      if (listed.status !== 404 && listed.status !== 405) {
        return classifiedFailure(label, listed.status, listed.body, Date.now() - startedAt, false)
      }
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - startedAt,
        usedFallback: false,
        message: isTimeoutError(error) ? `${label} 连接超时（${PROBE_TIMEOUT_MS / 1000}s），请检查网络或代理。` : `${label} 网络不可达：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // 网关不实现 /models 时回退最小真实请求确认鉴权。
    if (!model) {
      return {
        ok: false,
        status: 404,
        latencyMs: Date.now() - startedAt,
        usedFallback: false,
        message: `${label} 未实现模型列表接口，且未配置模型 ID，无法进一步探测。`,
      }
    }
    const fallback = fallbackRequest(endpoint)
    try {
      const response = await request(fallback.url, { method: 'POST', headers: fallback.headers, body: JSON.stringify(fallback.body) })
      const latencyMs = Date.now() - startedAt
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, latencyMs, usedFallback: true, message: `${label} 连接正常（${latencyMs}ms，经真实请求确认）。` }
      }
      return classifiedFailure(label, response.status, response.body, latencyMs, true)
    } catch (error) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - startedAt,
        usedFallback: true,
        message: isTimeoutError(error) ? `${label} 连接超时（${PROBE_TIMEOUT_MS / 1000}s），请检查网络或代理。` : `${label} 网络不可达：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  function fallbackRequest(endpoint: ResolvedEndpoint): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const { protocol, baseUrl, model, apiKey } = endpoint
    const apiRoot = protocol === 'anthropic-messages' && !/\/v1$/.test(baseUrl) ? `${baseUrl}/v1` : baseUrl
    if (protocol === 'anthropic-messages') {
      return {
        url: `${apiRoot}/messages`,
        headers: { ...anthropicHeaders(apiKey), 'content-type': 'application/json' },
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      }
    }
    if (protocol === 'openai-responses') {
      return {
        url: `${baseUrl}/responses`,
        headers: { ...bearerHeaders(apiKey), 'content-type': 'application/json' },
        body: { model, input: 'ping', max_output_tokens: 16 },
      }
    }
    return {
      url: `${baseUrl}/chat/completions`,
      headers: { ...bearerHeaders(apiKey), 'content-type': 'application/json' },
      body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false },
    }
  }

  return {
    async probe(target: ApiProbeTarget): Promise<ApiProbeResult> {
      const endpoint = await resolveEndpoint(target)
      if (endpoint.blockedMessage) {
        return { ok: false, status: null, latencyMs: 0, usedFallback: false, message: endpoint.blockedMessage }
      }
      return probeEndpoint(endpoint)
    },
  }
}
