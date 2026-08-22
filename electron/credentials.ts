import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { CredentialStatus } from '../src/types'

const DEEPSEEK_CREDENTIAL = 'DEEPSEEK_API_KEY'
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertCredentialName(name: string): void {
  if (!CREDENTIAL_NAME.test(name)) throw new Error('凭据名称格式无效。')
}

function credentialsPath(dshHome: string): string {
  return path.join(dshHome, '.credentials.yaml')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readCredentialSource(dshHome: string): Promise<string | null> {
  try {
    return await readFile(credentialsPath(dshHome), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseCredentials(source: string) {
  const document = parseDocument(source || '{}\n', { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error('DSH 凭据文件格式无效，请先在 DSH 中修复后重试。')
  }

  const value = document.toJS() as unknown
  if (value === null) return { document, values: {} as Record<string, string>, modern: false }
  if (!isRecord(value)) {
    throw new Error('DSH 凭据文件必须是 Key 与密钥组成的映射。')
  }

  // DSH 0.1.1+ stores credentials under refs and keeps metadata such as
  // version/records at the document root. The launcher must operate on refs
  // without flattening or validating those metadata fields as secrets.
  const modern = value.version === 1 && Object.prototype.hasOwnProperty.call(value, 'refs')
  const values = modern ? value.refs : value
  if (!isRecord(values)) {
    throw new Error('DSH 凭据文件的 refs 必须是凭据映射。')
  }
  for (const [name, secret] of Object.entries(values)) {
    if (!CREDENTIAL_NAME.test(name) || typeof secret !== 'string' || secret.length === 0) {
      throw new Error('DSH 凭据文件包含无效条目，请先在 DSH 中修复后重试。')
    }
  }
  return { document, values: values as Record<string, string>, modern }
}

async function writeCredentialDocument(dshHome: string, content: string): Promise<void> {
  await mkdir(dshHome, { recursive: true, mode: 0o700 })
  const target = credentialsPath(dshHome)
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

export async function getDeepSeekCredentialStatus(dshHome: string): Promise<CredentialStatus> {
  return { configured: await hasCredential(dshHome, DEEPSEEK_CREDENTIAL) }
}

export async function readCredential(dshHome: string, name: string): Promise<string | null> {
  assertCredentialName(name)
  const source = await readCredentialSource(dshHome)
  if (source === null) return null
  const { values } = parseCredentials(source)
  return values[name] ?? null
}

export async function hasCredential(dshHome: string, name: string): Promise<boolean> {
  return Boolean(await readCredential(dshHome, name))
}

export async function setCredential(dshHome: string, name: string, secret: string): Promise<void> {
  assertCredentialName(name)
  const normalized = secret.trim()
  if (!normalized) throw new Error('API Key 不能为空。')
  const source = await readCredentialSource(dshHome)
  const { document, modern } = parseCredentials(source ?? '{}\n')
  if (modern) document.setIn(['refs', name], normalized)
  else document.set(name, normalized)
  await writeCredentialDocument(dshHome, document.toString({ lineWidth: 0 }))
}

export async function removeCredential(dshHome: string, name: string): Promise<boolean> {
  assertCredentialName(name)
  const source = await readCredentialSource(dshHome)
  if (source === null) return false
  const { document, values, modern } = parseCredentials(source)
  if (!values[name]) return false
  if (modern) document.deleteIn(['refs', name])
  else document.delete(name)
  await writeCredentialDocument(dshHome, document.toString({ lineWidth: 0 }))
  return true
}

/**
 * 内部读取 DeepSeek API Key，仅供主进程 AI 安装时注入 ACP 子进程环境。
 * 文件缺失返回 null。返回值绝不打日志。
 */
export async function readDeepSeekApiKey(dshHome: string): Promise<string | null> {
  return readCredential(dshHome, DEEPSEEK_CREDENTIAL)
}

export async function setDeepSeekApiKey(dshHome: string, apiKey: string): Promise<CredentialStatus> {
  await setCredential(dshHome, DEEPSEEK_CREDENTIAL, apiKey)
  return { configured: true }
}

export async function clearDeepSeekApiKey(dshHome: string): Promise<CredentialStatus> {
  await removeCredential(dshHome, DEEPSEEK_CREDENTIAL)
  return { configured: false }
}
