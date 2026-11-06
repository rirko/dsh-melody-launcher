import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { CustomApiProvider } from '../src/types'
import { readCredential, readDeepSeekApiKey } from './credentials'
import { credentialNameForRoute, listCustomApiProviders } from './custom-api'

/**
 * Copilot 模型 API 解析。
 *
 * ACP 运行时只注册了 deepseek-official 一个 adapter（OpenAI 兼容
 * /chat/completions，端点可用 DEEPSEEK_BASE_URL 覆盖）。因此自定义 API
 * 统一映射到 deepseek-official + 自定义 baseURL/模型/密钥，而不是把路由
 * 当作 provider id（会报 no adapter registered）。
 *
 * 优先级：
 *  1. agent-default-model 指向自定义 provider 且本地有密钥；
 *  2. DeepSeek 官方 Key（返回 null，走默认路径）；
 *  3. 第一个带本地密钥、openai-completions 协议的自定义 provider。
 */
export interface CopilotAgentApi {
  provider: string
  model: string
  apiKeyEnvName: string
  apiKey: string
  /** 自定义 API 的端点；官方路径为 undefined（用 adapter 默认值）。 */
  baseUrl?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readAgentDefaultModel(dshHome: string, profileName?: string): Promise<Record<string, unknown>> {
  try {
    const profilePath = profileName ? path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml') : null
    const source = profilePath
      ? await readFile(profilePath, 'utf8').catch(() => readFile(path.join(dshHome, 'settings.yaml'), 'utf8'))
      : await readFile(path.join(dshHome, 'settings.yaml'), 'utf8')
    const document = parseDocument(source, { uniqueKeys: true })
    if (document.errors.length > 0) return {}
    const value = document.toJS() as unknown
    if (Array.isArray(value)) {
      const entry = value.find(item => isRecord(item) && item.id === 'agent-default-model')
      return isRecord(entry) && isRecord(entry.config) ? entry.config : {}
    }
    const entry = isRecord(value) ? value['agent-default-model'] : undefined
    return isRecord(entry) ? entry : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function credentialFor(dshHome: string, provider: CustomApiProvider): Promise<string | null> {
  const envName = provider.credentialName ?? credentialNameForRoute(provider.route)
  return readCredential(dshHome, envName).catch(() => null)
}

function customApiToAgentApi(provider: CustomApiProvider, apiKey: string, model?: string): CopilotAgentApi {
  return {
    provider: 'deepseek-official',
    model: model && provider.modelIds.includes(model) ? model : provider.modelIds[0],
    apiKeyEnvName: 'DEEPSEEK_API_KEY',
    apiKey,
    baseUrl: provider.baseUrl.replace(/\/+$/, ''),
  }
}

export async function resolveCopilotAgentApi(dshHome: string, profileName?: string): Promise<CopilotAgentApi | null> {
  const providers = await listCustomApiProviders(dshHome, profileName).catch(() => [])

  // 1. agent-default-model 显式指定的自定义 provider。
  const agentDefault = await readAgentDefaultModel(dshHome, profileName).catch(() => ({} as Record<string, unknown>))
  if (typeof agentDefault.provider === 'string') {
    const provider = providers.find(candidate => candidate.route === agentDefault.provider)
    if (provider && provider.protocol === 'openai-completions' && provider.modelIds.length > 0) {
      const apiKey = await credentialFor(dshHome, provider)
      if (apiKey) {
        const model = typeof agentDefault.model === 'string' ? agentDefault.model : undefined
        return customApiToAgentApi(provider, apiKey, model)
      }
    }
  }

  // 2. DeepSeek 官方 Key 存在时走默认路径。
  if (await readDeepSeekApiKey(dshHome).catch(() => null)) return null

  // 3. 第一个带本地密钥的自定义 provider（仅 openai-completions 协议可映射到 adapter）。
  for (const provider of providers) {
    if (provider.modelIds.length === 0 || provider.protocol !== 'openai-completions') continue
    const apiKey = await credentialFor(dshHome, provider)
    if (apiKey) return customApiToAgentApi(provider, apiKey)
  }
  return null
}

export interface CopilotModelOption {
  /** 稳定标识：deepseek-official 或自定义 provider 路由。 */
  provider: string
  model: string
  label: string
  /** 当前是否可用（官方缺密钥时不可用）。 */
  available: boolean
}

/** Copilot 模型选择器候选：DeepSeek 官方 + 全部自定义 provider 的模型。 */
export async function listCopilotModels(dshHome: string, profileName?: string): Promise<CopilotModelOption[]> {
  const [deepseekKey, providers] = await Promise.all([
    readDeepSeekApiKey(dshHome).catch(() => null),
    listCustomApiProviders(dshHome, profileName).catch(() => [] as CustomApiProvider[]),
  ])
  const options: CopilotModelOption[] = [{
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    label: `DeepSeek 官方 · deepseek-v4-flash`,
    available: Boolean(deepseekKey),
  }]
  for (const provider of providers) {
    const hasKey = await credentialFor(dshHome, provider).then(Boolean)
    for (const model of provider.modelIds) {
      options.push({
        provider: provider.route,
        model,
        label: `${provider.displayName} · ${model}`,
        available: hasKey && provider.protocol === 'openai-completions',
      })
    }
  }
  return options
}

export type CopilotModelResolution =
  | { kind: 'custom'; api: CopilotAgentApi }
  | { kind: 'official' }
  | { kind: 'unavailable'; reason: string }

/** 把模型选择器的 provider/model 解析为 agent 可用的 API 配置。 */
export async function resolveAgentApiForModel(
  dshHome: string,
  providerId: string,
  model: string,
  profileName?: string,
): Promise<CopilotModelResolution> {
  if (providerId === 'deepseek-official') {
    const key = await readDeepSeekApiKey(dshHome).catch(() => null)
    return key
      ? { kind: 'official' }
      : { kind: 'unavailable', reason: 'DeepSeek 官方 Key 未配置，请先在 API 配置中填写。' }
  }
  const providers = await listCustomApiProviders(dshHome, profileName).catch(() => [] as CustomApiProvider[])
  const provider = providers.find(candidate => candidate.route === providerId)
  if (!provider) return { kind: 'unavailable', reason: `自定义 API「${providerId}」已不存在。` }
  if (provider.protocol !== 'openai-completions') {
    return { kind: 'unavailable', reason: `「${provider.displayName}」的协议暂不支持 Copilot（需要 OpenAI 兼容）。` }
  }
  if (!provider.modelIds.includes(model)) {
    return { kind: 'unavailable', reason: `模型 ${model} 已不在「${provider.displayName}」的模型列表中。` }
  }
  const apiKey = await credentialFor(dshHome, provider)
  if (!apiKey) return { kind: 'unavailable', reason: `「${provider.displayName}」缺少本地密钥。` }
  return { kind: 'custom', api: customApiToAgentApi(provider, apiKey, model) }
}
