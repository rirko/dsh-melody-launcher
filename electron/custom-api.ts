import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { CustomApiModel, CustomApiProtocol, CustomApiProvider, CustomApiProviderInput } from '../src/types'
import { hasCredential, readCredential, removeCredential, setCredential } from './credentials'

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const CREDENTIAL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROTOCOLS = new Set<CustomApiProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function settingsPath(dshHome: string): string {
  return path.join(dshHome, 'settings.yaml')
}

function profilePatchPath(dshHome: string, profileName?: string): string | null {
  if (!profileName || !/^[A-Za-z0-9._-]+$/.test(profileName) || profileName === 'node_modules') return null
  return path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml')
}

async function readSettingsSource(dshHome: string): Promise<string | null> {
  try {
    return await readFile(settingsPath(dshHome), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readProfileSource(dshHome: string, profileName?: string): Promise<string | null> {
  const target = profilePatchPath(dshHome, profileName)
  if (!target) return null
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseSettings(source: string | null) {
  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error('DSH settings.yaml 格式无效，请先修复配置文件后重试。')
  }
  const value = document.toJS() as unknown
  if (value !== null && !isRecord(value)) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  return { document, values: (value ?? {}) as JsonRecord }
}

async function writeSettingsDocument(dshHome: string, content: string): Promise<void> {
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  const target = settingsPath(dshHome)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
    await chmod(target, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeProfileDocument(dshHome: string, profileName: string, content: string): Promise<void> {
  const target = profilePatchPath(dshHome, profileName)
  if (!target) throw new Error('当前 Profile 名称无效。')
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
    await chmod(target, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export function credentialNameForRoute(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

function providerMap(values: JsonRecord): JsonRecord {
  const namespace = values['llm-pi-ai']
  if (!isRecord(namespace)) return {}
  const providers = namespace.providers
  return isRecord(providers) ? providers : {}
}

function providerCredentialName(route: string, provider: JsonRecord): string | null {
  return typeof provider.apiKeyEnv === 'string' && CREDENTIAL_PATTERN.test(provider.apiKeyEnv)
    ? provider.apiKeyEnv
    : null
}

function modelIdsFromProvider(provider: JsonRecord): string[] {
  if (!Array.isArray(provider.models)) return []
  return provider.models.flatMap(model => {
    if (typeof model === 'string') return model.trim() ? [model.trim()] : []
    if (isRecord(model) && typeof model.id === 'string' && model.id.trim()) return [model.id.trim()]
    return []
  })
}

function normalizedModel(model: unknown): CustomApiModel | null {
  if (typeof model === 'string') {
    const id = model.trim()
    return id ? { id, input: ['text'], reasoningEfforts: {} } : null
  }
  if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) return null
  const input = Array.isArray(model.input)
    ? model.input.filter(value => value === 'text' || value === 'image') as Array<'text' | 'image'>
    : ['text'] as Array<'text' | 'image'>
  const reasoningEfforts: Record<string, string | null> = {}
  if (isRecord(model.reasoningEfforts)) {
    for (const [key, value] of Object.entries(model.reasoningEfforts)) {
      if (typeof value === 'string' || value === null) reasoningEfforts[key] = value
    }
  }
  const result: CustomApiModel = { id: model.id.trim(), input: input.length > 0 ? input : ['text'], reasoningEfforts }
  if (typeof model.name === 'string' && model.name.trim()) result.name = model.name.trim()
  if (Number.isFinite(model.contextWindow)) result.contextWindow = Number(model.contextWindow)
  if (Number.isFinite(model.maxOutputTokens)) result.maxOutputTokens = Number(model.maxOutputTokens)
  return result
}

function modelsFromProvider(provider: JsonRecord): CustomApiModel[] {
  if (!Array.isArray(provider.models)) return []
  return provider.models.map(normalizedModel).filter((model): model is CustomApiModel => model !== null)
}

function providerMapFromDocument(documentValues: unknown): JsonRecord {
  return isRecord(documentValues) && isRecord((documentValues as JsonRecord)['llm-pi-ai'])
    && isRecord(((documentValues as JsonRecord)['llm-pi-ai'] as JsonRecord).providers)
    ? ((documentValues as JsonRecord)['llm-pi-ai'] as JsonRecord).providers as JsonRecord
    : {}
}

function readDefaultModel(values: unknown): string | null {
  if (!Array.isArray(values)) return null
  const entry = values.find(item => isRecord(item) && item.id === 'agent-default-model')
  if (!isRecord(entry) || !isRecord(entry.config) || typeof entry.config.model !== 'string') return null
  const provider = typeof entry.config.provider === 'string' ? entry.config.provider.trim() : ''
  return provider ? `${provider}/${entry.config.model.trim()}` : entry.config.model.trim()
}

/** Read the model-related entries from a Profile patch for explicit sync. */
function parseProfileModelConfig(source: string): {
  providers: JsonRecord
  defaultModel: JsonRecord | null
} {
  const document = parseDocument(source, { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error('DSH 模型配置格式无效，请先修复当前 Profile 的 cordis.patch.yml。')
  const values = document.toJS() as unknown
  if (!Array.isArray(values)) throw new Error('当前 Profile 的 cordis.patch.yml 顶层必须是补丁列表。')

  const providerEntry = values.find(item => isRecord(item) && item.id === 'llm-pi-ai')
  const providerConfig = isRecord(providerEntry) && isRecord(providerEntry.config) ? providerEntry.config : null
  const providers = providerConfig && isRecord(providerConfig.providers) ? providerConfig.providers : {}
  const defaultEntry = values.find(item => isRecord(item) && item.id === 'agent-default-model')
  const defaultConfig = isRecord(defaultEntry) && isRecord(defaultEntry.config) ? defaultEntry.config : null
  return { providers, defaultModel: defaultConfig }
}

function patchProviderPath(values: unknown, document: ReturnType<typeof parseDocument>): Array<string | number> {
  if (!Array.isArray(values)) return ['llm-pi-ai', 'providers']
  const index = values.findIndex(item => isRecord(item) && item.id === 'llm-pi-ai')
  if (index >= 0) return [index, 'config', 'providers']
  document.add({ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } })
  const nextIndex = Array.isArray(document.toJS()) ? (document.toJS() as unknown[]).length - 1 : 0
  return [nextIndex, 'config', 'providers']
}

function normalizeInput(input: CustomApiProviderInput): Omit<CustomApiProviderInput, 'originalRoute' | 'apiKey'> & {
  originalRoute: string
  apiKey: string
} {
  if (!input || typeof input !== 'object') throw new Error('自定义 API 配置无效。')
  const route = typeof input.route === 'string' ? input.route.trim() : ''
  const originalRoute = typeof input.originalRoute === 'string' ? input.originalRoute.trim() : route
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''

  if (!ROUTE_PATTERN.test(route) || route.length > 64) {
    throw new Error('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
  }
  if (!ROUTE_PATTERN.test(originalRoute) || originalRoute.length > 64) throw new Error('原路由格式无效。')
  if (!displayName || displayName.length > 80) throw new Error('显示名称不能为空，且不能超过 80 个字符。')
  if (!PROTOCOLS.has(input.protocol)) throw new Error('API 协议不受支持。')
  if (!baseUrl || baseUrl.length > 2048) throw new Error('Base URL 不能为空。')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('Base URL 不是有效的网址。')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error('Base URL 必须是 HTTP(S) 地址，且不能包含账号或密码。')
  }
  if (!Array.isArray(input.modelIds)) throw new Error('模型列表格式无效。')
  const modelIds = [...new Set(input.modelIds.map(id => typeof id === 'string' ? id.trim() : ''))]
    .filter(Boolean)
  if (modelIds.length === 0) throw new Error('至少需要填写一个模型 ID。')
  if (modelIds.length > 100 || modelIds.some(id => id.length > 200 || /[\r\n\0]/.test(id))) {
    throw new Error('模型 ID 数量或格式无效。')
  }
  if (apiKey.length > 32_768) throw new Error('API Key 过长。')

  const models = Array.isArray(input.models)
    ? input.models.map(normalizedModel).filter((model): model is CustomApiModel => model !== null)
    : undefined
  return { route, originalRoute, displayName, baseUrl, protocol: input.protocol, modelIds, models, apiKey }
}

function preservedModels(existing: JsonRecord | undefined, modelIds: string[]): Array<JsonRecord> {
  const existingModels = Array.isArray(existing?.models) ? existing.models : []
  const byId = new Map<string, JsonRecord>()
  for (const model of existingModels) {
    if (isRecord(model) && typeof model.id === 'string') byId.set(model.id, model)
  }
  return modelIds.map(id => ({ ...(byId.get(id) ?? {}), id }))
}

export async function listCustomApiProviders(dshHome: string, profileName?: string): Promise<CustomApiProvider[]> {
  const profileSource = await readProfileSource(dshHome, profileName)
  const source = profileSource ?? await readSettingsSource(dshHome)
  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error('DSH 模型配置格式无效，请先修复当前 Profile 的 cordis.patch.yml。')
  const values = document.toJS() as unknown
  if (Array.isArray(values) && profileSource === null) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  const providers = Array.isArray(values) ? {} : providerMap(values as JsonRecord)
  const patchProviders = Array.isArray(values)
    ? (values.find(item => isRecord(item) && item.id === 'llm-pi-ai') as JsonRecord | undefined)
    : undefined
  let actualProviders = isRecord(patchProviders) && isRecord(patchProviders.config)
    ? providerMapFromDocument({ 'llm-pi-ai': patchProviders.config })
    : providers
  // 兼容旧版本：Profile 尚未写入模型配置时，保留 DSH_HOME/settings.yaml 中的 Provider。
  if (profileSource !== null && Object.keys(actualProviders).length === 0) {
    const legacy = parseSettings(await readSettingsSource(dshHome))
    actualProviders = providerMap(legacy.values)
  }
  const defaultModel = readDefaultModel(values)
  const parsed = Object.entries(actualProviders).flatMap(([route, value]) => {
    if (!ROUTE_PATTERN.test(route) || !isRecord(value)) return []
    const protocol = value.api
    const baseUrl = value.baseURL
    const models = modelsFromProvider(value)
    const modelIds = models.length > 0 ? models.map(model => model.id) : modelIdsFromProvider(value)
    if (!PROTOCOLS.has(protocol as CustomApiProtocol) || typeof baseUrl !== 'string' || modelIds.length === 0) return []
    const credentialName = providerCredentialName(route, value)
    return [{
      route,
      displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : route,
      baseUrl,
      protocol: protocol as CustomApiProtocol,
      modelIds,
      models,
      defaultModel,
      credentialName,
    }]
  })

  const withStatus = await Promise.all(parsed.map(async provider => ({
    ...provider,
    hasApiKey: provider.credentialName ? await hasCredential(dshHome, provider.credentialName) : false,
  })))
  return withStatus.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
}

export async function saveCustomApiProvider(
  dshHome: string,
  input: CustomApiProviderInput,
  profileName?: string,
): Promise<CustomApiProvider[]> {
  const normalized = normalizeInput(input)
  const profileSource = await readProfileSource(dshHome, profileName)
  const source = profileSource ?? await readSettingsSource(dshHome)
  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error('DSH 模型配置格式无效，请先修复当前 Profile 的配置文件。')
  const values = document.toJS() as unknown
  const patchMode = Array.isArray(values)
  if (patchMode && profileSource === null) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  const providerRoot = patchProviderPath(values, document)
  const providers = patchMode
    ? (() => {
        const entry = values.find(item => isRecord(item) && item.id === 'llm-pi-ai') as JsonRecord | undefined
        return isRecord(entry) && isRecord(entry.config) ? providerMapFromDocument({ 'llm-pi-ai': entry.config }) : {}
      })()
    : providerMap(values as JsonRecord)
  const existing = isRecord(providers[normalized.originalRoute]) ? providers[normalized.originalRoute] as JsonRecord : undefined
  const oldCredentialName = existing ? providerCredentialName(normalized.originalRoute, existing) : null
  const routeChanged = normalized.originalRoute !== normalized.route
  if (routeChanged && providers[normalized.route] !== undefined) throw new Error('目标路由已存在，请换一个路由名称。')

  let nextCredentialName: string | null = !routeChanged && oldCredentialName
    ? oldCredentialName
    : null
  let migratedSecret: string | null = null
  if (normalized.apiKey) {
    nextCredentialName = routeChanged || !oldCredentialName ? credentialNameForRoute(normalized.route) : oldCredentialName
    await setCredential(dshHome, nextCredentialName, normalized.apiKey)
  } else if (routeChanged && oldCredentialName) {
    migratedSecret = await readCredential(dshHome, oldCredentialName)
    if (migratedSecret) {
      nextCredentialName = credentialNameForRoute(normalized.route)
      await setCredential(dshHome, nextCredentialName, migratedSecret)
    }
  }

  if (routeChanged && existing) {
    document.deleteIn([...providerRoot, normalized.originalRoute])
    document.setIn([...providerRoot, normalized.route], document.createNode({ ...existing }))
  } else if (!existing) {
    document.setIn([...providerRoot, normalized.route], document.createNode({}))
  }
  const basePath = [...providerRoot, normalized.route]
  document.setIn([...basePath, 'displayName'], normalized.displayName)
  document.setIn([...basePath, 'api'], normalized.protocol)
  document.setIn([...basePath, 'baseURL'], normalized.baseUrl)
  const models = normalized.models && normalized.models.length > 0
    ? normalized.models
    : preservedModels(existing, normalized.modelIds)
  document.setIn([...basePath, 'models'], models)
  if (nextCredentialName) document.setIn([...basePath, 'apiKeyEnv'], nextCredentialName)
  else document.deleteIn([...basePath, 'apiKeyEnv'])

  const serialized = document.toString({ lineWidth: 0 })
  if (patchMode && profileName) await writeProfileDocument(dshHome, profileName, serialized)
  else await writeSettingsDocument(dshHome, serialized)
  if (routeChanged && oldCredentialName && oldCredentialName !== nextCredentialName) {
    await removeCredential(dshHome, oldCredentialName)
  }
  return listCustomApiProviders(dshHome, profileName)
}

export async function removeCustomApiProvider(dshHome: string, route: string, profileName?: string): Promise<CustomApiProvider[]> {
  const normalizedRoute = typeof route === 'string' ? route.trim() : ''
  if (!ROUTE_PATTERN.test(normalizedRoute)) throw new Error('自定义 API 路由格式无效。')
  const profileSource = await readProfileSource(dshHome, profileName)
  const source = profileSource ?? await readSettingsSource(dshHome)
  const document = parseDocument(source ?? '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) throw new Error('DSH 模型配置格式无效，请先修复当前 Profile 的配置文件。')
  const values = document.toJS() as unknown
  const patchMode = Array.isArray(values)
  if (patchMode && profileSource === null) throw new Error('DSH settings.yaml 顶层必须是配置映射。')
  const providerRoot = patchProviderPath(values, document)
  const providers = patchMode
    ? (() => {
        const entry = values.find(item => isRecord(item) && item.id === 'llm-pi-ai') as JsonRecord | undefined
        return isRecord(entry) && isRecord(entry.config) ? providerMapFromDocument({ 'llm-pi-ai': entry.config }) : {}
      })()
    : providerMap(values as JsonRecord)
  const existing = providers[normalizedRoute]
  if (!isRecord(existing)) throw new Error('没有找到该自定义 API。')
  const credentialName = providerCredentialName(normalizedRoute, existing) ?? credentialNameForRoute(normalizedRoute)

  document.deleteIn([...providerRoot, normalizedRoute])
  const remainingProviders = { ...providers }
  delete remainingProviders[normalizedRoute]
  if (Object.keys(remainingProviders).length === 0) document.deleteIn(providerRoot)
  const serialized = document.toString({ lineWidth: 0 })
  if (patchMode && profileName) await writeProfileDocument(dshHome, profileName, serialized)
  else await writeSettingsDocument(dshHome, serialized)
  await removeCredential(dshHome, credentialName)
  return listCustomApiProviders(dshHome, profileName)
}

/**
 * 手动把当前 Profile 的模型配置同步到 DSH_HOME/settings.yaml。
 * Profile 中的 Provider 会完整替换全局 providers，其他全局设置保留。
 */
export async function syncCustomApiProviders(dshHome: string, profileName: string): Promise<CustomApiProvider[]> {
  const profileSource = await readProfileSource(dshHome, profileName)
  if (profileSource === null) throw new Error('当前 Profile 没有可同步的 DSH 模型配置。')
  const profile = parseProfileModelConfig(profileSource)
  if (Object.keys(profile.providers).length === 0) {
    throw new Error('当前 Profile 没有可同步的 DSH Provider 配置。')
  }

  const global = parseSettings(await readSettingsSource(dshHome))
  global.document.setIn(['llm-pi-ai', 'providers'], global.document.createNode(profile.providers))
  if (profile.defaultModel) {
    global.document.setIn(['agent-default-model'], global.document.createNode(profile.defaultModel))
  } else {
    global.document.deleteIn(['agent-default-model'])
  }
  await writeSettingsDocument(dshHome, global.document.toString({ lineWidth: 0 }))
  return listCustomApiProviders(dshHome, profileName)
}
