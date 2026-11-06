import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialNameForRoute,
  listCustomApiProviders,
  removeCustomApiProvider,
  saveCustomApiProvider,
  syncCustomApiProviders,
} from '../electron/custom-api'

let temporaryHome = ''

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-custom-api-'))
})

afterEach(async () => {
  await rm(temporaryHome, { recursive: true, force: true })
})

function providerInput(overrides: Record<string, unknown> = {}) {
  return {
    route: 'local-gateway',
    displayName: 'Local Gateway',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'openai-completions' as const,
    modelIds: ['qwen3:8b'],
    ...overrides,
  }
}

describe('custom API providers', () => {
  it('lists an empty configuration without creating files', async () => {
    await expect(listCustomApiProviders(temporaryHome)).resolves.toEqual([])
  })

  it('writes the official provider shape while preserving comments and unrelated settings', async () => {
    const settingsFile = path.join(temporaryHome, 'settings.yaml')
    await writeFile(settingsFile, '# keep root comment\nother-feature:\n  enabled: true\nllm-pi-ai:\n  existingOption: keep\n', 'utf8')

    const providers = await saveCustomApiProvider(temporaryHome, {
      ...providerInput(),
      apiKey: '  secret-value  ',
    })
    const settings = await readFile(settingsFile, 'utf8')
    const credentials = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')
    const parsed = parseDocument(settings).toJS() as Record<string, any>

    expect(settings).toContain('# keep root comment')
    expect(parsed['other-feature']).toEqual({ enabled: true })
    expect(parsed['llm-pi-ai'].existingOption).toBe('keep')
    expect(parsed['llm-pi-ai'].providers['local-gateway']).toMatchObject({
      displayName: 'Local Gateway',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'LOCAL_GATEWAY_API_KEY',
      models: [{ id: 'qwen3:8b' }],
    })
    expect(credentials).toContain('LOCAL_GATEWAY_API_KEY: secret-value')
    expect(providers).toEqual([expect.objectContaining({
      route: 'local-gateway',
      credentialName: 'LOCAL_GATEWAY_API_KEY',
      hasApiKey: true,
    })])
    expect(JSON.stringify(providers)).not.toContain('secret-value')
  })

  it('keeps the existing key and provider-specific fields when an edit leaves the key blank', async () => {
    await writeFile(path.join(temporaryHome, 'settings.yaml'), `llm-pi-ai:
  providers:
    local-gateway:
      displayName: Old name
      apiKeyEnv: CUSTOM_GATEWAY_TOKEN
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      customOption: keep
      models:
        - id: qwen3:8b
          contextWindow: 32768
`, 'utf8')
    await writeFile(path.join(temporaryHome, '.credentials.yaml'), 'CUSTOM_GATEWAY_TOKEN: existing-secret\n', 'utf8')

    await saveCustomApiProvider(temporaryHome, {
      ...providerInput({ displayName: 'Updated name', modelIds: ['qwen3:8b', 'deepseek-r1:8b'] }),
      originalRoute: 'local-gateway',
      apiKey: '',
    })
    const settings = parseDocument(await readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).toJS() as Record<string, any>
    const provider = settings['llm-pi-ai'].providers['local-gateway']
    const credentials = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')

    expect(provider.displayName).toBe('Updated name')
    expect(provider.apiKeyEnv).toBe('CUSTOM_GATEWAY_TOKEN')
    expect(provider.customOption).toBe('keep')
    expect(provider.models).toEqual([
      { id: 'qwen3:8b', contextWindow: 32768 },
      { id: 'deepseek-r1:8b' },
    ])
    expect(credentials).toContain('CUSTOM_GATEWAY_TOKEN: existing-secret')
  })

  it('migrates the key when a route is renamed', async () => {
    await saveCustomApiProvider(temporaryHome, { ...providerInput(), apiKey: 'secret-value' })
    const providers = await saveCustomApiProvider(temporaryHome, {
      ...providerInput({ route: 'renamed-gateway', displayName: 'Renamed Gateway' }),
      originalRoute: 'local-gateway',
      apiKey: '',
    })
    const settings = parseDocument(await readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).toJS() as Record<string, any>
    const credentials = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')

    expect(settings['llm-pi-ai'].providers['local-gateway']).toBeUndefined()
    expect(settings['llm-pi-ai'].providers['renamed-gateway'].apiKeyEnv).toBe('RENAMED_GATEWAY_API_KEY')
    expect(credentials).not.toContain('LOCAL_GATEWAY_API_KEY')
    expect(credentials).toContain('RENAMED_GATEWAY_API_KEY: secret-value')
    expect(providers[0]).toMatchObject({ route: 'renamed-gateway', hasApiKey: true })
  })

  it('supports a local service without authentication', async () => {
    const providers = await saveCustomApiProvider(temporaryHome, providerInput())
    const settings = parseDocument(await readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).toJS() as Record<string, any>

    expect(settings['llm-pi-ai'].providers['local-gateway'].apiKeyEnv).toBeUndefined()
    expect(providers[0]).toMatchObject({ credentialName: null, hasApiKey: false })
  })

  it('removes the provider and its credential without removing other settings', async () => {
    await writeFile(path.join(temporaryHome, 'settings.yaml'), 'llm-pi-ai:\n  otherOption: keep\n', 'utf8')
    await saveCustomApiProvider(temporaryHome, { ...providerInput(), apiKey: 'secret-value' })
    await removeCustomApiProvider(temporaryHome, 'local-gateway')
    const settings = parseDocument(await readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).toJS() as Record<string, any>
    const credentials = await readFile(path.join(temporaryHome, '.credentials.yaml'), 'utf8')

    expect(settings['llm-pi-ai'].otherOption).toBe('keep')
    expect(settings['llm-pi-ai'].providers).toBeUndefined()
    expect(credentials).not.toContain('LOCAL_GATEWAY_API_KEY')
    await expect(listCustomApiProviders(temporaryHome)).resolves.toEqual([])
  })

  it('validates route, URL, protocol and model IDs', async () => {
    await expect(saveCustomApiProvider(temporaryHome, providerInput({ route: 'Bad_Route' }))).rejects.toThrow('路由')
    await expect(saveCustomApiProvider(temporaryHome, providerInput({ baseUrl: 'file:///tmp/model' }))).rejects.toThrow('HTTP')
    await expect(saveCustomApiProvider(temporaryHome, providerInput({ protocol: 'unknown' }))).rejects.toThrow('协议')
    await expect(saveCustomApiProvider(temporaryHome, providerInput({ modelIds: [] }))).rejects.toThrow('模型 ID')
  })

  it('rejects malformed settings documents', async () => {
    await writeFile(path.join(temporaryHome, 'settings.yaml'), '- invalid\n- root\n', 'utf8')
    await expect(listCustomApiProviders(temporaryHome)).rejects.toThrow('顶层必须是配置映射')
  })

  it('derives stable credential names from provider routes', () => {
    expect(credentialNameForRoute('my-openai-proxy')).toBe('MY_OPENAI_PROXY_API_KEY')
  })

  it('reads complete multi-model providers from the current Profile patch', async () => {
    const profileDir = path.join(temporaryHome, 'profiles', 'pack-test')
    await mkdir(profileDir, { recursive: true })
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: dsrc
    model: deepseek-v4.1-flash
    reasoningEffort: max
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      dsrc:
        displayName: dsrc
        api: openai-completions
        baseURL: https://example.com/v1
        apiKeyEnv: DSRC_API_KEY
        models:
          - id: deepseek-v4.1-flash
            contextWindow: 1000000
            maxOutputTokens: 8192
            input: [text, image]
            reasoningEfforts:
              off: null
              low: low
              max: max
          - id: deepseek-chat
            input: [text]
`, 'utf8')
    await writeFile(path.join(temporaryHome, '.credentials.yaml'), 'DSRC_API_KEY: secret\n', 'utf8')

    const providers = await syncCustomApiProviders(temporaryHome, 'pack-test')
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({
      route: 'dsrc',
      modelIds: ['deepseek-v4.1-flash', 'deepseek-chat'],
      defaultModel: 'dsrc/deepseek-v4.1-flash',
      hasApiKey: true,
    })
    expect(providers[0].models?.[0]).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 8192, input: ['text', 'image'] })
    expect(providers[0].models?.[0].reasoningEfforts).toEqual({ off: null, low: 'low', max: 'max' })
    const global = parseDocument(await readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).toJS() as any
    expect(global['llm-pi-ai'].providers.dsrc.models[0]).toMatchObject({ id: 'deepseek-v4.1-flash' })
    expect(global['agent-default-model']).toEqual({ provider: 'dsrc', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
  })

  it('replaces global model providers from the Profile while preserving unrelated settings', async () => {
    const profileDir = path.join(temporaryHome, 'profiles', 'pack-test')
    await mkdir(profileDir, { recursive: true })
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      profile-api:
        displayName: Profile API
        api: openai-completions
        baseURL: https://profile.example/v1
        models:
          - id: profile-model
`, 'utf8')
    await writeFile(path.join(temporaryHome, 'settings.yaml'), `other-feature:
  enabled: true
agent-default-model:
  provider: stale
  model: stale-model
llm-pi-ai:
  keepMe: true
  providers:
    stale:
      displayName: Stale
      api: openai-completions
      baseURL: https://stale.example/v1
      models: [{ id: stale-model }]
`, 'utf8')

    await syncCustomApiProviders(temporaryHome, 'pack-test')
    const settings = parseDocument(await readFile(path.join(temporaryHome, 'settings.yaml'), 'utf8')).toJS() as any
    expect(settings['other-feature']).toEqual({ enabled: true })
    expect(settings['llm-pi-ai'].keepMe).toBe(true)
    expect(Object.keys(settings['llm-pi-ai'].providers)).toEqual(['profile-api'])
    expect(settings['agent-default-model']).toBeUndefined()
  })

  it('writes provider edits back to the Profile patch without flattening it', async () => {
    const profileDir = path.join(temporaryHome, 'profiles', 'pack-test')
    await mkdir(profileDir, { recursive: true })
    await writeFile(path.join(profileDir, 'cordis.patch.yml'), `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    keepMe: true
    providers: {}
- id: ui-conversation
  config:
    busyEnter: queue
`, 'utf8')

    await saveCustomApiProvider(temporaryHome, {
      ...providerInput({
        models: [{ id: 'model-a', contextWindow: 32768, maxOutputTokens: 4096, input: ['text', 'image'], reasoningEfforts: { low: 'low' } }],
      }),
    }, 'pack-test')
    const patch = parseDocument(await readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8')).toJS() as any[]
    expect(patch[0].config.keepMe).toBe(true)
    expect(patch[0].config.providers['local-gateway'].models[0]).toMatchObject({ id: 'model-a', contextWindow: 32768 })
    expect(patch[1].id).toBe('ui-conversation')
  })
})
