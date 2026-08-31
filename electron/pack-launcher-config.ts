// 整合包携带的「启动器配置」域：纯函数 + yaml，不依赖 Electron。
// 导出 = 把可迁移的非敏感设置序列化为 launcher-config.yaml；
// 导入 = 解析并校验回到设置对象。凭据、本体/DSH_HOME 路径与 Profile 一律不进。

import { parse, stringify } from 'yaml'
import type { AppSettings, NetworkSettings, PackLauncherConfig, UiTheme } from '../src/types'

export const LAUNCHER_CONFIG_FILENAME = 'launcher-config.yaml'

const UI_THEMES = new Set<UiTheme>(['forest', 'ocean', 'berry', 'graphite'])

function validWebPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
}

function validUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && UI_THEMES.has(value as UiTheme)
}

function validNetworkSettings(value: unknown): NetworkSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const network = value as Record<string, unknown>
  const text = (field: string): string | undefined =>
    typeof network[field] === 'string' && (network[field] as string).trim() !== ''
      ? (network[field] as string).trim()
      : undefined
  const npmRegistry = text('npmRegistry')
  const proxy = text('proxy')
  const githubMirror = text('githubMirror')
  return npmRegistry || proxy || githubMirror ? { npmRegistry, proxy, githubMirror } : undefined
}

/** 序列化配置为 launcher-config.yaml 文本；只挑选换机可迁移的字段。 */
export function packLauncherConfig(settings: AppSettings): string {
  const payload: PackLauncherConfig = {}
  if (settings.workspace) payload.workspace = settings.workspace
  if (Array.isArray(settings.launchArgs) && settings.launchArgs.some(value => typeof value === 'string')) {
    payload.launchArgs = settings.launchArgs.filter(value => typeof value === 'string')
  }
  if (validWebPort(settings.webPort)) payload.webPort = settings.webPort
  if (settings.openAfterLaunch !== undefined) payload.openAfterLaunch = settings.openAfterLaunch
  if (validUiTheme(settings.uiTheme)) payload.uiTheme = settings.uiTheme
  if (settings.network) payload.network = settings.network
  return stringify(payload)
}

/** 解析 launcher-config.yaml；空文本 = 无配置。非法条目逐项跳过，整体结构错误抛错。 */
export function parseLauncherConfig(text: string): PackLauncherConfig {
  if (!text || !text.trim()) return {}
  const raw: unknown = parse(text)
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('整合包配置格式无效。')
  const input = raw as Record<string, unknown>
  const config: PackLauncherConfig = {}
  if (typeof input.workspace === 'string' && input.workspace.trim() !== '') config.workspace = input.workspace.trim()
  if (Array.isArray(input.launchArgs) && input.launchArgs.length > 0
    && input.launchArgs.every(value => typeof value === 'string')) {
    config.launchArgs = input.launchArgs.slice(0, 64)
  }
  if (validWebPort(input.webPort)) config.webPort = input.webPort
  if (typeof input.openAfterLaunch === 'boolean') config.openAfterLaunch = input.openAfterLaunch
  if (validUiTheme(input.uiTheme)) config.uiTheme = input.uiTheme
  const network = validNetworkSettings(input.network)
  if (network) config.network = network
  return config
}