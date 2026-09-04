import { describe, expect, it } from 'vitest'
import { createApiProbe } from '../electron/api-probe'
import type { CustomApiProvider } from '../src/types'

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>

function provider(overrides: Partial<CustomApiProvider> = {}): CustomApiProvider {
  return {
    route: 'demo',
    displayName: 'Demo API',
    baseUrl: 'https://api.demo.test/v1',
    protocol: 'openai-completions',
    modelIds: ['demo-mini'],
    credentialName: 'DEMO_API_KEY',
    hasApiKey: true,
    ...overrides,
  }
}

interface ProbeHarness {
  probe: ReturnType<typeof createApiProbe>['probe']
  requests: RecordedRequest[]
}

function build(options: {
  providers?: CustomApiProvider[]
  officialKey?: string | null
  credentials?: Record<string, string | null>
  fetchImpl: FetchStub
}): ProbeHarness {
  const requests: RecordedRequest[] = []
  const service = createApiProbe({
    readSettings: async () => ({ dshHome: 'C:\\demo' }),
    fetchImpl: async (url, init) => {
      const headers: Record<string, string> = {}
      for (const [key, value] of new Headers(init?.headers ?? {}).entries()) headers[key] = value
      requests.push({ url: String(url), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null })
      return options.fetchImpl(String(url), init)
    },
    listProviders: async () => options.providers ?? [provider()],
    readNamedCredential: async (_dshHome, name) => options.credentials?.[name] ?? null,
    readOfficialApiKey: async () => options.officialKey ?? null,
  })
  return { probe: target => service.probe(target), requests }
}

describe('api probe', () => {
  it('passes when /models responds 2xx with a bearer token', async () => {
    const harness = build({
      credentials: { DEMO_API_KEY: 'sk-demo' },
      fetchImpl: async () => new Response('{"data":[]}', { status: 200 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(true)
    expect(result.usedFallback).toBe(false)
    expect(result.status).toBe(200)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(harness.requests[0].url).toBe('https://api.demo.test/v1/models')
    expect(harness.requests[0].headers['authorization']).toBe('Bearer sk-demo')
  })

  it('falls back to a 1-token chat request when /models is not implemented', async () => {
    const harness = build({
      credentials: { DEMO_API_KEY: 'sk-demo' },
      fetchImpl: async (_url, init) => init?.method === 'GET'
        ? new Response('not found', { status: 404 })
        : new Response('{"id":"x"}', { status: 200 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(true)
    expect(result.usedFallback).toBe(true)
    const fallback = harness.requests[1]
    expect(fallback.url).toBe('https://api.demo.test/v1/chat/completions')
    expect(fallback.method).toBe('POST')
    const body = JSON.parse(fallback.body ?? '{}') as { model?: string; max_tokens?: number }
    expect(body.model).toBe('demo-mini')
    expect(body.max_tokens).toBe(1)
  })

  it('reports rejected credentials on 401 without falling back', async () => {
    const harness = build({
      credentials: { DEMO_API_KEY: 'sk-bad' },
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.usedFallback).toBe(false)
    expect(result.message).toContain('密钥')
    expect(harness.requests).toHaveLength(1)
  })

  it('treats 429 as reachable but rate limited', async () => {
    const harness = build({
      credentials: { DEMO_API_KEY: 'sk-demo' },
      fetchImpl: async () => new Response('slow down', { status: 429 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(true)
    expect(result.status).toBe(429)
    expect(result.message).toContain('限流')
  })

  it('uses anthropic headers and the /v1 endpoint family', async () => {
    const harness = build({
      providers: [provider({ protocol: 'anthropic-messages', credentialName: 'DEMO_API_KEY' })],
      credentials: { DEMO_API_KEY: 'ak-demo' },
      fetchImpl: async (_url, init) => init?.method === 'GET'
        ? new Response('not found', { status: 404 })
        : new Response('{"id":"msg"}', { status: 200 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(true)
    expect(result.usedFallback).toBe(true)
    expect(harness.requests[0].url).toBe('https://api.demo.test/v1/models')
    expect(harness.requests[0].headers['x-api-key']).toBe('ak-demo')
    expect(harness.requests[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(harness.requests[1].url).toBe('https://api.demo.test/v1/messages')
  })

  it('falls back to the responses endpoint for openai-responses providers', async () => {
    const harness = build({
      providers: [provider({ protocol: 'openai-responses' })],
      credentials: { DEMO_API_KEY: 'sk-demo' },
      fetchImpl: async (_url, init) => init?.method === 'GET'
        ? new Response('nope', { status: 405 })
        : new Response('{"id":"resp"}', { status: 200 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(true)
    const fallback = harness.requests[1]
    expect(fallback.url).toBe('https://api.demo.test/v1/responses')
    const body = JSON.parse(fallback.body ?? '{}') as { max_output_tokens?: number }
    expect(body.max_output_tokens).toBe(16)
  })

  it('short-circuits the official endpoint when no key is configured', async () => {
    const harness = build({ officialKey: null, fetchImpl: async () => new Response('{}', { status: 200 }) })
    const result = await harness.probe({ target: 'deepseek-official' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未配置')
    expect(harness.requests).toHaveLength(0)
  })

  it('probes the official endpoint with the well-known base url and model', async () => {
    const harness = build({ officialKey: 'sk-official', fetchImpl: async () => new Response('{"data":[]}', { status: 200 }) })
    const result = await harness.probe({ target: 'deepseek-official' })
    expect(result.ok).toBe(true)
    expect(harness.requests[0].url).toBe('https://api.deepseek.com/models')
    expect(harness.requests[0].headers['authorization']).toBe('Bearer sk-official')
  })

  it('normalizes trailing slashes on custom base urls', async () => {
    const harness = build({
      providers: [provider({ baseUrl: 'https://api.demo.test/v1///' })],
      credentials: { DEMO_API_KEY: null },
      fetchImpl: async () => new Response('{"data":[]}', { status: 200 }),
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(true)
    expect(harness.requests[0].url).toBe('https://api.demo.test/v1/models')
    // 无密钥的本地服务不发 Authorization。
    expect(harness.requests[0].headers['authorization']).toBeUndefined()
  })

  it('reports network failures with a distinct message', async () => {
    const harness = build({
      credentials: { DEMO_API_KEY: 'sk-demo' },
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.message).toContain('网络不可达')
  })

  it('reports timeouts distinctly', async () => {
    const harness = build({
      credentials: { DEMO_API_KEY: 'sk-demo' },
      fetchImpl: async () => {
        const timeout = Object.assign(new Error('The operation was aborted.'), { name: 'TimeoutError' })
        throw timeout
      },
    })
    const result = await harness.probe({ target: 'custom', route: 'demo' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('超时')
  })

  it('throws for unknown custom routes', async () => {
    const harness = build({ fetchImpl: async () => new Response('{}', { status: 200 }) })
    await expect(harness.probe({ target: 'custom', route: 'missing' })).rejects.toThrow('未找到')
  })
})
