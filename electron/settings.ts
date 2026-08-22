import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PROFILE_NAME, DSH_PACKAGE_NAME } from '../src/constants'
import type { AppSettings, DshInstallationStatus, UiTheme } from '../src/types'
import { managedDshExecutable } from './dsh-install'
import { isSafeProfileName } from './profile'

/**
 * 启动器设置的唯一权威来源：默认值、校验、持久化与内存缓存。
 * 不直接依赖 electron —— 路径与 DSH 检测都由调用方注入，因此可以完整单测。
 */

export interface DefaultSettingsInput {
  /** 环境变量 DSH_HOME，缺省时回落到用户主目录下的 .dsh。 */
  dshHomeFromEnvironment?: string
  homeDirectory: string
  documentsDirectory: string
  /** 系统 npx 的绝对路径；未检测到时使用平台默认名。 */
  systemNpx?: string
  /** 启动器自己管理的 DSH 安装根目录。 */
  dshInstallPath?: string
  platform?: NodeJS.Platform
}

/** 按注入的平台拼路径，让同一份输入在不同平台上可以完整单测。 */
function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts)
}

export function defaultSettings(input: DefaultSettingsInput): AppSettings {
  const platform = input.platform ?? process.platform
  return {
    dshInstallPath: input.dshInstallPath ?? joinForPlatform(platform, input.homeDirectory, '.dsh-runtime'),
    dshHome: input.dshHomeFromEnvironment || joinForPlatform(platform, input.homeDirectory, '.dsh'),
    dshVersion: null,
    nodeVersion: null,
    profileName: DEFAULT_PROFILE_NAME,
    activePackId: null,
    workspace: input.documentsDirectory,
    launchExecutable: input.systemNpx ?? (platform === 'win32' ? 'npx.cmd' : 'npx'),
    launchArgs: ['--yes', DSH_PACKAGE_NAME, 'web'],
    webPort: 3080,
    openAfterLaunch: true,
    uiTheme: 'forest',
    aiDeveloperMode: false,
    aiPrompt: '',
  }
}

const UI_THEMES = new Set<UiTheme>(['forest', 'ocean', 'berry', 'graphite'])

function validUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && UI_THEMES.has(value as UiTheme)
}

function validWebPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
}

function validRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string'
    && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.trim())
}

/** 兼容曾经直接写在启动参数里的 --port。 */
export function webPortFromLaunchArgs(args: unknown): number | null {
  if (!Array.isArray(args)) return null
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--port') {
      const parsed = Number(args[index + 1])
      return validWebPort(parsed) ? parsed : null
    }
    if (typeof value === 'string' && value.startsWith('--port=')) {
      const parsed = Number(value.slice('--port='.length))
      return validWebPort(parsed) ? parsed : null
    }
  }
  return null
}

/** 忽略平台差异的路径比较：Windows 下不区分大小写。 */
export function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

/** 校验并归一化一份来自渲染层的设置。任何一项不合法都直接抛错。 */
export function validateSettings(input: AppSettings): AppSettings {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效。')
  if (!isSafeProfileName(input.profileName)) throw new Error('配置名称只能包含字母、数字、点、横线或下划线。')
  if (!path.isAbsolute(input.dshInstallPath) || !path.isAbsolute(input.dshHome) || !path.isAbsolute(input.workspace)) {
    throw new Error('目录必须使用完整路径。')
  }
  const resolvedInstallPath = path.resolve(input.dshInstallPath)
  if (resolvedInstallPath === path.parse(resolvedInstallPath).root) throw new Error('DSH 本体不能直接安装到磁盘根目录。')
  if (samePath(input.dshInstallPath, input.dshHome)) throw new Error('DSH 本体安装目录不能与 DSH_HOME 相同。')
  if (!input.launchExecutable.trim()) throw new Error('启动命令不能为空。')
  if (!Array.isArray(input.launchArgs) || input.launchArgs.some(value => typeof value !== 'string')) throw new Error('启动参数格式无效。')
  if (!validWebPort(input.webPort)) throw new Error('Web 端口必须是 1 到 65535 之间的整数。')
  return {
    dshInstallPath: input.dshInstallPath,
    dshHome: input.dshHome,
    dshVersion: input.dshVersion == null ? null : validRuntimeVersion(input.dshVersion) ? input.dshVersion.trim() : null,
    nodeVersion: input.nodeVersion == null ? null : validRuntimeVersion(input.nodeVersion) ? input.nodeVersion.trim() : null,
    profileName: input.profileName,
    // Kept only so older settings.json files remain readable. Runtime code
    // selects an environment exclusively through profileName.
    activePackId: null,
    workspace: input.workspace,
    launchExecutable: input.launchExecutable.trim(),
    launchArgs: input.launchArgs,
    webPort: input.webPort,
    openAfterLaunch: Boolean(input.openAfterLaunch),
    uiTheme: validUiTheme(input.uiTheme) ? input.uiTheme : 'forest',
    aiDeveloperMode: Boolean(input.aiDeveloperMode),
    aiPrompt: typeof input.aiPrompt === 'string' ? input.aiPrompt.slice(0, 20_000) : '',
  }
}

/** 把磁盘上的设置合并到默认值上，丢弃结构不对的字段。 */
export function mergeStoredSettings(defaults: AppSettings, stored: Partial<AppSettings> | null): AppSettings {
  if (!stored || typeof stored !== 'object') return defaults
  const storedPort = validWebPort(stored.webPort)
    ? stored.webPort
    : webPortFromLaunchArgs(stored.launchArgs) ?? defaults.webPort
  return {
    ...defaults,
    ...stored,
    dshVersion: stored.dshVersion == null ? null : validRuntimeVersion(stored.dshVersion) ? stored.dshVersion.trim() : null,
    nodeVersion: stored.nodeVersion == null ? null : validRuntimeVersion(stored.nodeVersion) ? stored.nodeVersion.trim() : null,
    activePackId: null,
    dshInstallPath: typeof stored.dshInstallPath === 'string' && path.isAbsolute(stored.dshInstallPath)
      ? stored.dshInstallPath
      : defaults.dshInstallPath,
    launchArgs: Array.isArray(stored.launchArgs)
      ? stored.launchArgs.filter(value => typeof value === 'string')
      : defaults.launchArgs,
    webPort: storedPort,
    uiTheme: validUiTheme(stored.uiTheme) ? stored.uiTheme : defaults.uiTheme ?? 'forest',
    aiDeveloperMode: Boolean(stored.aiDeveloperMode),
    aiPrompt: typeof stored.aiPrompt === 'string' ? stored.aiPrompt.slice(0, 20_000) : '',
  }
}

/**
 * 判断当前配置是否走「用 npx 临时拉取 DSH」的方式。
 * 是的话说明还没绑定到某个具体安装，可以在检测到本地 DSH 后自动切换过去。
 */
export function usesOnDemandDsh(settings: AppSettings): boolean {
  const executable = path.basename(settings.launchExecutable).toLowerCase()
  return (executable === 'npx' || executable === 'npx.cmd') && settings.launchArgs.includes(DSH_PACKAGE_NAME)
}

/** 已检测到本地 DSH 时，把按需拉取的配置切换为直接调用它。 */
export function adoptDetectedDsh(settings: AppSettings, detected: DshInstallationStatus): AppSettings {
  if (!usesOnDemandDsh(settings) || !detected.installed || !detected.executable) return settings
  return { ...settings, launchExecutable: detected.executable, launchArgs: ['web'] }
}

export interface SettingsStore {
  read(): Promise<AppSettings>
  save(input: AppSettings): Promise<AppSettings>
}

export interface SettingsStoreOptions {
  filePath: string
  createDefaults: () => AppSettings
  /** 首次读取时用于把按需拉取的配置绑定到已安装的 DSH。 */
  detectInstalledDsh: (settings: AppSettings) => Promise<DshInstallationStatus>
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  let cache: AppSettings | null = null

  return {
    async read(): Promise<AppSettings> {
      if (cache) return cache
      const defaults = options.createDefaults()
      let stored: Partial<AppSettings> | null = null
      try {
        stored = JSON.parse(await readFile(options.filePath, 'utf8')) as Partial<AppSettings>
      } catch {
        stored = null
      }
      cache = mergeStoredSettings(defaults, stored)
      if (usesOnDemandDsh(cache)) {
        cache = adoptDetectedDsh(cache, await options.detectInstalledDsh(cache))
      }
      return cache
    },

    async save(input: AppSettings): Promise<AppSettings> {
      const current = cache ?? input
      let next = validateSettings(input)
      if (current.profileName !== next.profileName) next = { ...next, activePackId: null }
      // 用户改动了 DSH 本体安装目录，而启动命令仍指向旧目录里的可执行文件时，跟随切过去。
      const installPathChanged = !samePath(current.dshInstallPath, next.dshInstallPath)
      const usedPreviousManagedExecutable = samePath(next.launchExecutable, managedDshExecutable(current.dshInstallPath))
      if (installPathChanged && usedPreviousManagedExecutable) {
        next = { ...next, launchExecutable: managedDshExecutable(next.dshInstallPath), launchArgs: ['web'] }
      }
      await mkdir(path.dirname(options.filePath), { recursive: true })
      await writeFile(options.filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      cache = next
      return next
    },
  }
}
