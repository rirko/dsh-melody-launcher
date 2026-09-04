// 整合包（Pack）管理的组装层。
//
// 职责：把底层模块（manifest / zip / export / registry / orchestration /
// installer 适配器）编排成渲染层可用的 PackManager。本模块不直接依赖
// Electron —— 对话框与「写用户选择的文件」由 ipc 层负责；DSH 插件的安装 /
// 卸载 / profile 读取全部委托给注入的 installer 适配器（main.ts 组装真实
// Installer，测试注入 stub）。

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AppSettings,
  ApplicationInstallRequest,
  InstalledApplicationAddon,
  InstalledPreset,
  InstalledSkill,
  PackAnalysis,
  PackAnalysisItem,
  PackCreateRequest,
  PackImportOptions,
  PackInstallResult,
  PackManifest,
  PackInstalledApplication,
  PackInstalledPlugin,
  PackInstalledPreset,
  PackInstalledSkill,
  PackPluginEntry,
  PackProgressEvent,
  PackStatus,
  PluginInstallTarget,
  PresetInstallRequest,
  PresetInstallResult,
  ProfileState,
  ProfileExportMode,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInstallTarget,
} from '../src/types'
import { assertMeaningfulPackName, assertPackDshVersion, buildManifestFromReceipts, isValidPackDshVersion, normalizePackDshVersion, packProfileName, parsePackManifest } from './pack-manifest'
import { extractPackBodiesFromPath, extractPresetBodiesFromPath, findManifestInArchiveFromPath, inspectPackZipFromPath } from './pack-zip'
import { validateFullArchive } from './profile-repository-import'
import { cleanPackNameHint, extractRawPluginBodiesFromPath, extractRawPresetSourcesFromPath, extractRawSkillSourcesFromPath, scanRawPackZipFromPath, type ExtractByteBudget } from './pack-scan'
import { buildPackExportToFile } from './pack-export'
import {
  readPackRegistry,
  removePackRecord,
  toPackStatus,
  upsertPackRecord,
  type PackRecord,
} from './pack-registry'
import {
  buildInstallResult,
  guardPackStart,
  runSerialInstall,
  type InstallableItem,
} from './pack-orchestration'
import { readPluginReceipts, removePluginReceipt, type PluginInstallReceipt } from './plugin-receipts'
import { readPresetReceipts, type PresetInstallReceipt } from './preset-receipts'
import { readSkillReceipts, type SkillInstallReceipt } from './skill-receipts'
import { createProfileSnapshot, restoreProfileSnapshot, type ProfileSnapshot } from './ai-install'
import { isSafePackageName, isSafeProfileName, reorderPlugins } from './profile'
import { ensureProfileCoreBundles, readProfileMetadata, writeProfileMetadata } from './profile-service'
import { readPackManifest, removePackManifest, writePackManifest } from './pack-manifest-store'

/** 扩展 PluginInstallTarget：携带 GitHub 仓库名，供 github / npm 源重建安装目标。 */
export type PackInstallTarget = PluginInstallTarget & { repository?: string; defaultBranch?: string; targetId?: string; allowBuilds?: string[]; denyBuilds?: string[] }

/** pack 管理器依赖的最小 installer 面（main.ts 组装真实 Installer，测试注入 stub）。 */
export interface InstallInstaller {
  installPluginTarget(target: PackInstallTarget, profileOverride?: string): Promise<unknown>
  installNpmPackage?(request: { packageName: string; version?: string; repository?: string; approvedBuildKeys?: string[]; deniedBuildKeys?: string[] }, profileOverride?: string): Promise<unknown>
  /** raw 整合包导入的技能：从本地源目录/单文件全局安装到 dshHome/skills。 */
  installSkillLocal(dshHome: string, skill: { name: string; format: 'bundle' | 'flat'; sourceDir: string }): Promise<unknown>
  /** 从仓库安装一个 Skill（标准清单导入用）。 */
  installSkill(request: SkillInstallRequest): Promise<SkillInstallResult>
  /** 按固定 pin 安装一个 Skill（标准清单导入用，不重新分析 HEAD）。 */
  installSkillPinned(request: { repository: string; target: SkillInstallTarget }): Promise<InstalledSkill>
  /** 启用或停用一个本地 Skill。 */
  toggleSkill(name: string, enabled: boolean): Promise<InstalledSkill[]>
  /** 安装一个 Agent 预设（全局安装到 DSH 预设目录）。 */
  installPreset(request: PresetInstallRequest): Promise<PresetInstallResult>
  /** 从本地 staging 目录安装 Agent 预设（raw 整合包导入用）。 */
  installPresetLocal(dshHome: string, preset: { name: string; sourceDir: string }): Promise<unknown>
  /** 启用或停用一个本地 Agent 预设。 */
  togglePreset(name: string, enabled: boolean): Promise<InstalledPreset[]>
  remove(packageName: string, profileName?: string): Promise<unknown>
  readProfile(dshHome: string, profileName: string): Promise<ProfileState>
  togglePlugin(dshHome: string, profileName: string, packageName: string, enabled: boolean): Promise<ProfileState>
  reorderPlugins?(dshHome: string, profileName: string, packageNames: string[]): Promise<ProfileState>
}

export interface PackManagerOptions {
  readSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<AppSettings>
  /** packs.json 注册表路径。 */
  registryPath: string
  /** 本地整合包清单目录；每个包一个 YAML，不创建 DSH Profile。 */
  manifestRoot?: string
  /** 快照落盘目录（对齐 ai-install）。 */
  snapshotRoot: string
  /** 插件安装凭据文件路径。 */
  pluginReceiptsPath: string
  /** Agent 预设安装凭据文件路径。 */
  presetReceiptsPath: string
  /** Skill 安装凭据文件路径。 */
  skillReceiptsPath: string
  /** Application Addon 管理器（用于读取/安装/卸载应用加载项）。 */
  applicationAddons: {
    list(): Promise<InstalledApplicationAddon[]>
    install(request: ApplicationInstallRequest): Promise<unknown>
    uninstall(id: string): Promise<InstalledApplicationAddon[]>
    toggle?(id: string, enabled: boolean): Promise<InstalledApplicationAddon[]>
  }
  installer: InstallInstaller
  emitOutput?: (level: 'info' | 'error' | 'success', text: string) => void
  emitEvent: (event: PackProgressEvent) => void
  isRuntimeRunning: () => boolean
  isInstallerBusy: () => boolean
  /** 覆盖 DSH_HOME；缺省从 settings 读取。 */
  dshHome?: string
  /** 新运行态：把每个整合包 id materialize 为 Profile。 */
  unifiedProfiles?: boolean
}

export interface PackManager {
  listPacks(): Promise<PackStatus[]>
  isBusy(): boolean
  createPack(request: PackCreateRequest): Promise<PackInstallResult>
  analyzeImport(filePath: string): Promise<PackAnalysis>
  importPack(filePath: string, items?: string[], options?: PackImportOptions): Promise<PackInstallResult>
  exportPack(packId: string, mode?: ProfileExportMode): Promise<{ zipPath: string; fileName: string }>
  activatePack(packId: string): Promise<AppSettings>
  deactivatePack(): Promise<AppSettings>
  removePack(packId: string): Promise<{ removed: number }>
  rollback(): Promise<{ restored: number; profileName: string }>
  hasSnapshot(): Promise<boolean>
  addPackPlugin(packId: string, packageName: string): Promise<PackStatus>
  addPackPreset(packId: string, presetName: string): Promise<PackStatus>
  addPackSkill(packId: string, skillName: string): Promise<PackStatus>
  addPackApplication(packId: string, addonId: string): Promise<PackStatus>
  togglePackItem(packId: string, packageName: string, enabled: boolean): Promise<PackStatus>
  togglePackPreset(packId: string, presetName: string, enabled: boolean): Promise<PackStatus>
  togglePackSkill(packId: string, skillName: string, enabled: boolean): Promise<PackStatus>
  togglePackApplication(packId: string, addonId: string, enabled: boolean): Promise<PackStatus>
  removePackItem(packId: string, packageName: string): Promise<PackStatus>
  removePackPreset(packId: string, presetName: string): Promise<PackStatus>
  removePackSkill(packId: string, skillName: string): Promise<PackStatus>
  removePackApplication(packId: string, addonId: string): Promise<PackStatus>
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '未知错误'
}

/** 创建/导出整合包时解析当前启动器实际使用的 DSH 精确版本。 */
async function resolvePackDshVersion(settings: AppSettings, requested?: string): Promise<string> {
  const candidates = [requested, settings.dshVersion]
  for (const candidate of candidates) {
    if (isValidPackDshVersion(candidate)) return normalizePackDshVersion(candidate)
  }

  // 兼容旧设置：版本目录名本身包含精确版本。
  const versionMatch = settings.launchExecutable.match(/[\\/]versions[\\/]([^\\/]+)[\\/]/i)
  if (versionMatch?.[1] && isValidPackDshVersion(versionMatch[1])) return normalizePackDshVersion(versionMatch[1])

  // 再从当前 dsh 包的 package.json 读取，避免把范围表达式写入整合包。
  const executable = path.resolve(settings.launchExecutable)
  const runtimeRoot = path.dirname(path.dirname(path.dirname(executable)))
  try {
    const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    if (isValidPackDshVersion(manifest.version)) return normalizePackDshVersion(manifest.version)
  } catch {
    // 下面统一给出缺少精确版本的提示。
  }
  throw new Error('当前 DSH 没有可记录的精确版本，请先在“运行环境”中选择或安装一个 DSH 版本。')
}

function assertSafePackId(packId: string): void {
  if (typeof packId !== 'string' || !isSafeProfileName(packId)) throw new Error('整合包标识无效。')
}

export function createPackManager(options: PackManagerOptions): PackManager {
  let active = false
  let snapshot: ProfileSnapshot | null = null
  /** 兼容旧快照字段；共享 Profile 模式下始终为 false。 */
  let profileWasNew = false
  const manifestRoot = options.manifestRoot ?? path.join(path.dirname(options.registryPath), 'pack-manifests')
  const baselinePath = path.join(manifestRoot, 'default-state.json')

  async function ensureUnifiedProfile(dshHome: string, profileName: string, sourceProfileName: string, metadata: { description?: string; dshVersion?: string | null; source?: 'zip' | 'yaml' | 'local' | 'github' }): Promise<void> {
    const target = path.join(dshHome, 'profiles', profileName)
    if (!existsSync(target)) await mkdir(target, { recursive: true })
    const source = path.join(dshHome, 'profiles', sourceProfileName)
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      const sourceFile = path.join(source, file)
      const targetFile = path.join(target, file)
      if (!existsSync(targetFile) && existsSync(sourceFile)) await cp(sourceFile, targetFile)
    }
    if (!existsSync(path.join(target, 'package.json'))) {
      await writeFile(path.join(target, 'package.json'), `${JSON.stringify({ name: `dsh-profile-${profileName}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2)}\n`, 'utf8')
    }
    await ensureProfileCoreBundles(target)
    await writeProfileMetadata(dshHome, profileName, {
      description: metadata.description ?? '',
      dshVersion: metadata.dshVersion ?? null,
      source: metadata.source === 'github' ? { kind: 'github', repository: '' } : metadata.source === 'zip' || metadata.source === 'yaml' ? { kind: 'import', format: metadata.source } : { kind: 'local' },
    })
  }

  type BaselineState = {
    profileName: string
    activeBundles: string[]
    enabledPlugins: string[]
    skills: string[]
    presets: string[]
    applications: string[]
  }

  const getDshHome = async (): Promise<string> => options.dshHome || (await options.readSettings()).dshHome

  async function resolveImportedProfileId(
    baseId: string,
    dshHome: string,
    records: PackRecord[],
    importOptions?: PackImportOptions,
  ): Promise<string> {
    const occupied = (candidate: string) => records.some(record => record.id === candidate)
      || existsSync(path.join(dshHome, 'profiles', candidate))
    if (importOptions?.overwrite) {
      if (!occupied(baseId)) throw new Error(`无法覆盖不存在的 Profile「${baseId}」。`)
      return baseId
    }
    if (!occupied(baseId)) return baseId
    for (let index = 2; index <= 999; index += 1) {
      const candidate = `${baseId}-${index}`
      if (isSafeProfileName(candidate) && !occupied(candidate)) return candidate
    }
    throw new Error(`Profile「${baseId}」已存在，无法生成新的导入名称。`)
  }

  /** 离线导入的插件本体缓存，不与 DSH Profile 绑定。 */
  function packBodiesDir(dshHome: string, packId: string): string {
    // 离线本体缓存属于启动器，不属于任何 DSH Profile；清单仍是整合包的唯一配置。
    return path.join(dshHome, '.dsh-launcher-pack-bodies', packId)
  }

  /**
   * Imported plugin bodies are immutable package content. Keep one physical
   * copy per package/version and let each Profile retain only its own pnpm
   * link layer and activation order.
   */
  async function sharedPluginBodyDir(dshHome: string, packageName: string, sourceDir: string): Promise<string> {
    if (!options.unifiedProfiles) return sourceDir
    let version = 'local'
    try {
      const manifest = JSON.parse(await readFile(path.join(sourceDir, 'package.json'), 'utf8')) as { version?: unknown }
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        version = manifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
      }
    } catch {
      // The installer will report a precise invalid-body error below.
    }
    const destination = path.join(dshHome, '.dsh-launcher-plugin-bodies', ...packageName.split('/'), version)
    if (!existsSync(destination)) {
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(sourceDir, destination, { recursive: true })
    }
    return destination
  }

  async function readBaseline(): Promise<BaselineState | null> {
    try {
      return JSON.parse(await readFile(baselinePath, 'utf8')) as BaselineState
    } catch {
      return null
    }
  }

  async function saveBaseline(state: BaselineState): Promise<void> {
    await mkdir(manifestRoot, { recursive: true })
    await writeFile(baselinePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  async function clearBaseline(): Promise<void> {
    await rm(baselinePath, { force: true }).catch(() => undefined)
  }

  async function currentBaseline(settings: AppSettings): Promise<BaselineState> {
    const dshHome = await getDshHome()
    const profile = await options.installer.readProfile(dshHome, settings.profileName)
    const skills = (await readSkillReceipts(options.skillReceiptsPath)).map(item => item.name)
    const presets = (await readPresetReceipts(options.presetReceiptsPath)).map(item => item.name)
    const applications = (await options.applicationAddons.list()).filter(item => item.enabled).map(item => item.id)
    return {
      profileName: settings.profileName,
      activeBundles: profile.activeBundles,
      enabledPlugins: profile.plugins.filter(item => item.enabled).map(item => item.packageName),
      skills,
      presets,
      applications,
    }
  }

  async function applyPluginSet(profileName: string, desired: PackInstalledPlugin[], order: string[]): Promise<ProfileState> {
    const dshHome = await getDshHome()
    let profile = await options.installer.readProfile(dshHome, profileName)
    const desiredSet = new Set(desired.filter(item => item.enabled).map(item => item.packageName))
    for (const plugin of profile.plugins) {
      if (plugin.builtin) continue
      const shouldEnable = desiredSet.has(plugin.packageName)
      if (plugin.enabled !== shouldEnable) {
        profile = await options.installer.togglePlugin(dshHome, profileName, plugin.packageName, shouldEnable)
      }
    }
    // 安装器可能在读取 profile 后补齐依赖，再读一次后只把清单中的插件排在前面，核心/依赖保持现有相对顺序。
    profile = await options.installer.readProfile(dshHome, profileName)
    const core = profile.activeBundles.filter(name => profile.plugins.find(item => item.packageName === name)?.builtin)
    const requested = order.filter(name => profile.activeBundles.includes(name) && !core.includes(name))
    const remaining = profile.activeBundles.filter(name => !core.includes(name) && !requested.includes(name))
    const nextOrder = [...core, ...requested, ...remaining]
    if (nextOrder.length === profile.activeBundles.length && nextOrder.some((name, index) => name !== profile.activeBundles[index])) {
      profile = await reorderSharedProfile(profileName, nextOrder)
    }
    return profile
  }

  async function reorderSharedProfile(profileName: string, packageNames: string[]): Promise<ProfileState> {
    const dshHome = await getDshHome()
    const current = await options.installer.readProfile(dshHome, profileName)
    if (packageNames.length !== current.activeBundles.length) return current
    return options.installer.reorderPlugins
      ? options.installer.reorderPlugins(dshHome, profileName, packageNames)
      : reorderPlugins(dshHome, profileName, packageNames)
  }

  async function restoreBaseline(settings: AppSettings): Promise<void> {
    const baseline = await readBaseline()
    if (!baseline) {
      await options.saveSettings({ ...settings, activePackId: null })
      return
    }
    const dshHome = await getDshHome()
    let profile = await options.installer.readProfile(dshHome, baseline.profileName)
    const enabled = new Set(baseline.enabledPlugins)
    for (const plugin of profile.plugins) {
      if (plugin.builtin) continue
      const shouldEnable = enabled.has(plugin.packageName)
      if (plugin.enabled !== shouldEnable) profile = await options.installer.togglePlugin(dshHome, baseline.profileName, plugin.packageName, shouldEnable)
    }
    profile = await options.installer.readProfile(dshHome, baseline.profileName)
    const order = baseline.activeBundles.filter(name => profile.activeBundles.includes(name))
    const remaining = profile.activeBundles.filter(name => !order.includes(name))
    const fullOrder = [...order, ...remaining]
    if (fullOrder.length === profile.activeBundles.length && fullOrder.some((name, index) => name !== profile.activeBundles[index])) {
      await reorderSharedProfile(baseline.profileName, fullOrder)
    }
    await clearBaseline()
    await options.saveSettings({ ...settings, activePackId: null })
  }

  async function reapplyCurrentSelection(settings: AppSettings, fallback: ProfileState): Promise<void> {
    if (settings.activePackId) {
      const activeRecord = await findRecord(settings.activePackId).catch(() => null)
      if (activeRecord) {
        await applyPluginSet(settings.profileName, activeRecord.plugins, activeRecord.plugins.map(item => item.packageName))
        return
      }
    }
    const desired = fallback.plugins
      .filter(item => !item.builtin)
      .map(item => ({ packageName: item.packageName, enabled: item.enabled }))
    await applyPluginSet(settings.profileName, desired, fallback.activeBundles)
  }

  async function writeRecordManifest(record: PackRecord, sourceManifest?: PackManifest): Promise<void> {
    const existing = sourceManifest ?? await readPackManifest(manifestRoot, record.id)
    const existingPlugins = new Map((existing?.plugins ?? []).map(item => [item.packageName, item]))
    const dshVersion = isValidPackDshVersion(record.dshVersion)
      ? normalizePackDshVersion(record.dshVersion)
      : isValidPackDshVersion(existing?.dshVersion)
        ? normalizePackDshVersion(existing.dshVersion)
        : undefined
    const plugins: PackPluginEntry[] = record.plugins.map(item => ({
      ...existingPlugins.get(item.packageName),
      packageName: item.packageName,
      enabled: item.enabled,
    }))
    await writePackManifest(manifestRoot, record.id, {
      name: record.name,
      description: record.description || `DSH 整合包：${record.name}`,
      version: record.version,
      ...(dshVersion ? { dshVersion } : {}),
      plugins,
      ...(record.presets?.length ? { presets: record.presets.map(item => ({ name: item.name })) } : {}),
      ...(record.skills?.length ? { skills: record.skills.map(item => ({ name: item.name, format: item.format })) } : {}),
    })
  }

  /** 新任务开始：占住互斥位、丢弃上一个任务的快照与「是否新建 profile」标记。 */
  function beginTask(): void {
    active = true
    snapshot = null
    profileWasNew = false
  }

  const log = (level: 'info' | 'error' | 'success', text: string): void => {
    options.emitOutput?.(level, text)
  }

  /** manifest 插件条目 → 可安装 target。source 非 npm 且无 repository 时无法联网安装，返回 null。 */
  function manifestEntryToTarget(entry: PackPluginEntry | undefined, profileName: string): PackInstallTarget | null {
    if (!entry || !isSafePackageName(entry.packageName)) return null
    const source: 'npm' | 'github' = entry.source === 'npm' ? 'npm' : 'github'
    const target: PackInstallTarget = {
      id: entry.targetId ?? entry.packageName,
      packageName: entry.packageName,
      version: entry.version ?? null,
      source,
      profileName,
      platform: 'unknown',
      subdirectory: entry.subdirectory ?? null,
      commit: entry.commit ?? '',
      defaultBranch: entry.defaultBranch,
      targetId: entry.targetId,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
      allowBuilds: entry.allowBuilds,
      denyBuilds: entry.denyBuilds,
    }
    if (source === 'github') {
      if (!entry.repository) return null
      target.repository = entry.repository
    }
    return target
  }

  async function installManifestPlugin(target: PackInstallTarget): Promise<void> {
    if (target.source === 'local-directory') {
      await options.installer.installPluginTarget(target, target.profileName)
      return
    }
    if (target.source === 'npm' && options.installer.installNpmPackage) {
      await options.installer.installNpmPackage({
        packageName: target.packageName,
        version: target.version ?? undefined,
        repository: target.repository,
        approvedBuildKeys: target.allowBuilds,
        deniedBuildKeys: target.denyBuilds,
      }, target.profileName)
      return
    }
    if (!options.unifiedProfiles) {
      await options.installer.installPluginTarget(target)
      return
    }
    await options.installer.installPluginTarget({
      repository: target.repository ?? `npm:${target.packageName}`,
      defaultBranch: target.defaultBranch ?? 'main',
      targetId: target.targetId ?? target.id,
      commit: target.commit || undefined,
      version: target.version ?? undefined,
    } as PackInstallTarget, target.profileName)
  }

  function guarded(): string | null {
    return guardPackStart({
      isRuntimeRunning: options.isRuntimeRunning,
      isInstallerBusy: options.isInstallerBusy,
      isPackBusy: () => active,
    })
  }

  async function findRecord(packId: string): Promise<PackRecord> {
    assertSafePackId(packId)
    const records = await readPackRegistry(options.registryPath)
    const record = records.find(item => item.id === packId)
    if (record) return record
    if (options.unifiedProfiles) {
      const dshHome = await getDshHome()
      const profile = await options.installer.readProfile(dshHome, packId)
      if (profile.initialized) {
        const metadata = await readProfileMetadata(dshHome, packId)
        return {
          id: packId,
          name: metadata.name,
          description: metadata.description,
          version: '1.0.0',
          ...(metadata.dshVersion ? { dshVersion: metadata.dshVersion } : {}),
          source: metadata.source?.kind === 'import' && metadata.source.format === 'zip' ? 'zip' : metadata.source?.kind === 'import' && metadata.source.format === 'yaml' ? 'manifest' : 'created',
          installedAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          state: 'complete',
          plugins: profile.plugins.filter(plugin => !plugin.builtin).map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled, version: plugin.version })),
        }
      }
    }
    throw new Error('整合包不存在。')
  }

  function isSelectedProfile(settings: AppSettings, profileName: string): boolean {
    return options.unifiedProfiles ? settings.profileName === profileName : settings.activePackId === profileName
  }

  function selectedPackKey(settings: AppSettings): string | null | undefined {
    return options.unifiedProfiles ? settings.profileName : settings.activePackId
  }

  function toInstalledPlugins(installed: string[]): PackInstalledPlugin[] {
    return installed.map(packageName => ({ packageName, enabled: true }))
  }

  return {
    async listPacks() {
      const settings = await options.readSettings()
      if (options.unifiedProfiles) {
        const dshHome = await getDshHome()
        const profileRoot = path.join(dshHome, 'profiles')
        const names = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
        const statuses: PackStatus[] = []
        for (const entry of names) {
          if (!entry.isDirectory() || !isSafeProfileName(entry.name)) continue
          const profile = await options.installer.readProfile(dshHome, entry.name)
          if (!profile.initialized) continue
          const metadata = await readProfileMetadata(dshHome, entry.name)
          const plugins = profile.plugins.filter(plugin => !plugin.builtin).map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled, version: plugin.version }))
          const missing = plugins.filter(plugin => !existsSync(path.join(dshHome, 'profiles', entry.name, 'node_modules', ...plugin.packageName.split('/'))))
          statuses.push({
            id: entry.name,
            name: metadata.name,
            description: metadata.description,
            version: '1.0.0',
            dshVersion: metadata.dshVersion,
            source: metadata.source?.kind === 'import' && metadata.source.format === 'zip' ? 'zip' : metadata.source?.kind === 'import' && metadata.source.format === 'yaml' ? 'manifest' : 'created',
            enabled: entry.name === settings.profileName,
            state: missing.length > 0 ? 'partial' : 'complete',
            plugins,
            installedAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
          })
        }
        return statuses.sort((a, b) => a.name.localeCompare(b.name))
      }
      const records = await readPackRegistry(options.registryPath)
      await Promise.all(records.map(record => writeRecordManifest(record).catch(() => undefined)))
      return records.map(record => toPackStatus(record, options.unifiedProfiles ? settings.profileName : settings.activePackId))
    },

    isBusy: () => active,

    async createPack(request) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      profileWasNew = false
      try {
        const packId = packProfileName(request.name)
        const existing = await readPackRegistry(options.registryPath)
        if (existing.some(record => record.id === packId)) throw new Error('整合包已存在。')

        const settings = await options.readSettings()
        const dshVersion = await resolvePackDshVersion(settings, request.dshVersion)
        const dshHome = await getDshHome()
        const profileName = settings.profileName
        if (options.unifiedProfiles) await ensureUnifiedProfile(dshHome, packId, profileName, { description: request.description, dshVersion, source: 'local' })
        // 确认当前 profile 可读（顺带校验 profile 名），安装来源仍以 receipt 为准。
        await options.installer.readProfile(dshHome, profileName)

        const receipts = await readPluginReceipts(options.pluginReceiptsPath)
        const presetReceipts = await readPresetReceipts(options.presetReceiptsPath)
        const skippedFailures: { packageName: string; reason: string }[] = []
        const currentProfile = await options.installer.readProfile(dshHome, profileName)
        const installedPluginNames: string[] = []
        for (const packageName of request.packageNames) {
          if (!isSafePackageName(packageName)) {
            skippedFailures.push({ packageName, reason: '插件名称非法。' })
            continue
          }
          const installedPlugin = currentProfile.plugins.find(item => item.packageName === packageName)
          // 核心内置 Bundle 不属于用户可导出资源，直接跳过，不报失败。
          if (installedPlugin?.builtin) continue
          const receipt = receipts.find(item => item.profileName === profileName && item.packageName === packageName)
          if (receipt || installedPlugin) {
            installedPluginNames.push(packageName)
          } else {
            skippedFailures.push({ packageName, reason: '未找到已安装插件本体' })
          }
        }

        // 预设是全局资源：即使没有来源记录，也可以把本地本体打进整合包离线导出。
        const installedPresets: string[] = []
        const presetReceiptsForPack: PresetInstallReceipt[] = []
        for (const presetName of request.presetNames ?? []) {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) {
            skippedFailures.push({ packageName: presetName, reason: '预设名称非法。' })
            continue
          }
          const presetDir = path.join(dshHome, '.agent-presets', presetName)
          if (existsSync(presetDir)) {
            installedPresets.push(presetName)
            const receipt = presetReceipts.find(item => item.name === presetName)
            if (receipt) presetReceiptsForPack.push(receipt)
          } else {
            skippedFailures.push({ packageName: presetName, reason: '未找到已安装预设' })
          }
        }

        // Skill 与 Application 同样只纳入已存在且有来源/安装记录的资源。
        const skillReceipts = await readSkillReceipts(options.skillReceiptsPath)
        const installedSkills: string[] = []
        const skillReceiptsForPack: SkillInstallReceipt[] = []
        for (const skillName of request.skillNames ?? []) {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
            skippedFailures.push({ packageName: skillName, reason: 'Skill 名称非法。' })
            continue
          }
          const receipt = skillReceipts.find(item => item.name === skillName)
          if (!receipt) {
            skippedFailures.push({ packageName: skillName, reason: 'Skill 无来源记录，无法加入整合包' })
            continue
          }
          installedSkills.push(skillName)
          skillReceiptsForPack.push(receipt)
        }

        const applicationAddons = await options.applicationAddons.list()
        const installedApplications: string[] = []
        const applicationAddonsForPack: InstalledApplicationAddon[] = []
        for (const addonId of request.applicationIds ?? []) {
          const addon = applicationAddons.find(item => item.id === addonId)
          if (!addon) {
            skippedFailures.push({ packageName: addonId, reason: '未找到已安装的应用加载项' })
            continue
          }
          installedApplications.push(addonId)
          applicationAddonsForPack.push(addon)
        }

        options.emitEvent({ kind: 'status', message: `正在创建整合包「${request.name}」…` })
        const installedPlugins = installedPluginNames
        const installed = [...installedPlugins, ...installedPresets, ...installedSkills, ...installedApplications]
        const allFailures = skippedFailures
        const result = buildInstallResult(packId, installed, allFailures)

        const record: PackRecord = {
          id: packId,
          name: request.name,
          description: request.description ?? '',
          version: '1.0.0',
          dshVersion,
          source: 'created',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state: result.state,
          plugins: installedPlugins.map(packageName => ({
            packageName,
            enabled: currentProfile.plugins.find(item => item.packageName === packageName)?.enabled ?? false,
          })),
          ...(installedPresets.length > 0 ? { presets: installedPresets.map(name => ({ name, enabled: true })) } : {}),
          ...(installedSkills.length > 0 ? { skills: installedSkills.map(name => ({ name, format: skillReceiptsForPack.find(r => r.name === name)?.format ?? 'bundle', enabled: true })) } : {}),
          ...(installedApplications.length > 0 ? { applications: installedApplications.map(id => ({ id, name: applicationAddonsForPack.find(a => a.id === id)?.name ?? id, enabled: true })) } : {}),
          failures: result.failures.length > 0 ? result.failures : undefined,
        }
        if (options.unifiedProfiles) {
          // A newly-created Profile starts as a clone so it has the DSH core
          // links, but its enabled set and order must be independent from the
          // source Profile. Apply the selected pack state to the new directory
          // before exposing it through the unified Profile API.
          await applyPluginSet(packId, record.plugins, record.plugins.map(item => item.packageName))
        }
        await upsertPackRecord(options.registryPath, record)
        await writeRecordManifest(record)
        const extraParts: string[] = []
        if (installedPresets.length > 0) extraParts.push(`${installedPresets.length} 个预设`)
        if (installedSkills.length > 0) extraParts.push(`${installedSkills.length} 个技能`)
        if (installedApplications.length > 0) extraParts.push(`${installedApplications.length} 个应用`)
        log('success', `整合包「${request.name}」已创建：${installedPlugins.length} 个插件${extraParts.length > 0 ? `、${extraParts.join('、')}` : ''}。`)
        options.emitEvent({ kind: 'done', result })
        return result
      } catch (error) {
        const message = asErrorMessage(error)
        options.emitEvent({ kind: 'error', message })
        throw error
      } finally {
        active = false
      }
    },

    async analyzeImport(filePath) {
      if (/\.ya?ml$/i.test(filePath)) {
        const manifest = parsePackManifest(await readFile(filePath, 'utf8'), { requireDshVersion: true })
        return {
          id: packProfileName(manifest.name),
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          dshVersion: manifest.dshVersion ?? null,
          source: 'manifest' as const,
          items: manifest.plugins.map(entry => ({ packageName: entry.packageName, available: Boolean(entry.repository || entry.source === 'npm'), offline: false, enabled: entry.enabled !== false })),
        }
      }
      const manifestText = await findManifestInArchiveFromPath(filePath)
      if (!manifestText) {
        // 非标准包：扫描包内的标准插件目录与技能，合成为我们格式的整合包。
        const scan = await scanRawPackZipFromPath(filePath)
        const nameHint = cleanPackNameHint(path.basename(filePath)) ?? cleanPackNameHint(scan.topName ?? '') ?? ''
        const items: PackAnalysisItem[] = []
        for (const plugin of scan.plugins) {
          items.push({ packageName: plugin.packageName, available: true, offline: true })
        }
        for (const skill of scan.skills) {
          items.push({ packageName: skill.name, available: true, offline: true, kind: 'skill' })
        }
        for (const preset of scan.presets) {
          items.push({ packageName: preset.name, available: true, offline: true, kind: 'preset' })
        }
        for (const skippedItem of scan.skipped) {
          items.push({ packageName: skippedItem.entryPrefix, available: false, offline: false, reason: skippedItem.reason })
        }
        return {
          id: nameHint ? packProfileName(nameHint) : '',
          name: nameHint,
          description: `非标准整合包：扫描到 ${scan.plugins.length} 个插件、${scan.skills.length} 个技能${scan.presets.length > 0 ? `、${scan.presets.length} 个预设` : ''}。`,
          version: '1.0.0',
          dshVersion: null,
          source: 'raw',
          items,
        }
      }
      const inspection = await inspectPackZipFromPath(filePath)
      const manifest = inspection.manifest
      assertPackDshVersion(manifest)
      const packId = packProfileName(manifest.name)

      const items: PackAnalysisItem[] = []
      if (inspection.hasBodies) {
        // 有 plugin-bodies：按 body 包名逐项列出（全部可离线安装）。
        for (const packageName of inspection.bodyPackageNames) {
          items.push(isSafePackageName(packageName)
            ? { packageName, available: true, offline: true, enabled: manifest.plugins.find(entry => entry.packageName === packageName)?.enabled !== false }
            : { packageName, available: false, offline: false, reason: '插件名称非法。' })
        }
      } else {
        // manifest-only：按 manifest.plugins 逐项列出；缺 repository 且非 npm 源标不可用。
        for (const entry of manifest.plugins) {
          if (!isSafePackageName(entry.packageName)) {
            items.push({ packageName: entry.packageName, available: false, offline: false, reason: '插件名称非法。' })
            continue
          }
          const available = entry.source === 'npm' || Boolean(entry.repository)
          items.push(available
            ? { packageName: entry.packageName, available: true, offline: false, enabled: entry.enabled !== false }
            : { packageName: entry.packageName, available: false, offline: false, reason: '缺少来源仓库，无法联网安装' })
        }
      }
      for (const preset of manifest.presets ?? []) {
        const offline = inspection.presetBodyNames.includes(preset.name)
        const available = offline || Boolean(preset.repository && preset.sourcePath && preset.revision)
        items.push({
          packageName: preset.name,
          available,
          offline,
          kind: 'preset',
          reason: available ? undefined : '缺少仓库/来源路径/版本，无法联网安装',
        })
      }
      for (const skill of manifest.skills ?? []) {
        const available = Boolean(skill.repository && skill.sourcePath && skill.revision)
        items.push({
          packageName: skill.name,
          available,
          offline: false,
          kind: 'skill',
          reason: available ? undefined : '缺少仓库/来源路径/版本，无法联网安装',
        })
      }
      for (const application of manifest.applications ?? []) {
        items.push({
          packageName: application.id,
          available: true,
          offline: false,
          kind: 'application',
        })
      }
      return {
        id: packId,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        dshVersion: manifest.dshVersion ?? null,
        source: inspection.hasBodies ? 'zip' : 'manifest',
        items,
      }
    },

    async importPack(filePath, items, importOptions) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      profileWasNew = false
      let skillStaging: string | null = null
      let presetStaging: string | null = null
      let presetBodiesDir: string | null = null
      try {
        // 本地 YAML 是轻量清单格式：只安装清单引用的插件到共享 Profile，不创建包目录。
        if (/\.ya?ml$/i.test(filePath)) {
          const manifest = parsePackManifest(await readFile(filePath, 'utf8'), { requireDshVersion: true })
          const existing = await readPackRegistry(options.registryPath)
          const dshHome = await getDshHome()
          const packId = await resolveImportedProfileId(
            packProfileName(importOptions?.name ?? manifest.name),
            dshHome,
            existing,
            importOptions,
          )
          const settings = await options.readSettings()
          const profileName = options.unifiedProfiles ? packId : settings.profileName
          if (options.unifiedProfiles) await ensureUnifiedProfile(dshHome, profileName, settings.profileName, { description: manifest.description, dshVersion: manifest.dshVersion, source: 'yaml' })
          const profileBeforeInstall = await options.installer.readProfile(dshHome, profileName)
          if (importOptions?.overwrite && options.unifiedProfiles) {
            snapshot = await createProfileSnapshot(dshHome, profileName, options.snapshotRoot)
            options.emitEvent({ kind: 'snapshot' })
          }
          const requested = items && items.length > 0 ? new Set(items) : null
          const selected = manifest.plugins.filter(entry => !requested || requested.has(entry.packageName))
          const installables: InstallableItem[] = selected.map(entry => {
            const localBody = importOptions?.localPluginBodies?.[entry.packageName]
            const target = localBody
              ? { id: entry.packageName, packageName: entry.packageName, version: entry.version ?? null, source: 'local-directory' as const, profileName, platform: 'unknown' as const, subdirectory: null, commit: '', requiresBuild: false, buildScripts: [], nodeRange: null, localDirectory: localBody }
              : manifestEntryToTarget(entry, profileName)
            return {
              packageName: entry.packageName,
              offline: false,
              install: async () => {
                if (!target) throw new Error('清单中缺少该插件的来源，无法联网安装')
                await installManifestPlugin(target)
              },
            }
          })
          options.emitEvent({ kind: 'status', message: `正在导入整合包清单「${manifest.name}」…` })
          const { installed, failures } = await runSerialInstall(installables, { emitEvent: options.emitEvent })
          if (!options.unifiedProfiles) await reapplyCurrentSelection(settings, profileBeforeInstall)
          const installedPluginNames = selected
            .filter(entry => installed.includes(entry.packageName))
            .map(entry => entry.packageName)
          if (options.unifiedProfiles) {
            // Installation appends bundles to a cloned Profile. Restore the
            // imported manifest order explicitly after all installs finish.
            await applyPluginSet(
              profileName,
              selected
                .filter(entry => installedPluginNames.includes(entry.packageName))
                .map(entry => ({ packageName: entry.packageName, enabled: entry.enabled !== false })),
              installedPluginNames,
            )
          }
          const result = buildInstallResult(packId, installed, failures)
          const record: PackRecord = {
            id: packId,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            dshVersion: manifest.dshVersion,
            source: 'manifest',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: result.state,
            plugins: installedPluginNames.map(packageName => ({ packageName, enabled: manifest.plugins.find(entry => entry.packageName === packageName)?.enabled !== false })),
            failures: result.failures.length > 0 ? result.failures : undefined,
          }
          await upsertPackRecord(options.registryPath, record)
          await writeRecordManifest(record, manifest)
          options.emitEvent({ kind: 'done', result })
          return result
        }
        // 不再整体读入内存：先探测清单，再按分支用文件路径流式解析。
        // 文件被并发删除/移动时（通过 IPC stat 门禁后）这里会抛错，
        // 也能走 catch → finally 复位 active，避免整合包子系统永久卡在「进行中」。
        const manifestText = await findManifestInArchiveFromPath(filePath)
        if (!manifestText) {
          // ---- raw 分支：扫描非标准包内的插件与技能，离线安装，注册为我们格式的整合包。----
          const scan = await scanRawPackZipFromPath(filePath)
          if (scan.plugins.length === 0 && scan.skills.length === 0 && scan.presets.length === 0) {
            throw new Error('未在压缩包内发现可安装的插件、技能或预设。')
          }
          const nameHint = cleanPackNameHint(path.basename(filePath)) ?? cleanPackNameHint(scan.topName ?? '') ?? ''
          const packName = (importOptions?.name ?? '').trim() || nameHint
          if (!packName) throw new Error('无法确定整合包名称，请在预览中手动命名。')
          const existing = await readPackRegistry(options.registryPath)
          const dshHome = await getDshHome()
          const packId = await resolveImportedProfileId(assertMeaningfulPackName(packName), dshHome, existing, importOptions)
          const settings = await options.readSettings()
          const dshVersion = await resolvePackDshVersion(settings)
          const profileName = options.unifiedProfiles ? packId : settings.profileName
          if (options.unifiedProfiles) await ensureUnifiedProfile(dshHome, profileName, settings.profileName, { description: `非标准整合包：${packName}`, dshVersion, source: 'zip' })
          const profileBeforeInstall = await options.installer.readProfile(dshHome, profileName)
          // items 缺省 = 全装；插件名、技能名、预设名各自独立过滤（理论上可能撞名）。
          const wantedPlugins = scan.plugins.filter(plugin => !items || items.includes(plugin.packageName))
          const wantedSkills = scan.skills.filter(skill => !items || items.includes(skill.name))
          const wantedPresets = scan.presets.filter(preset => !items || items.includes(preset.name))

          options.emitEvent({ kind: 'status', message: `正在扫描并导入非标准整合包「${packName}」…` })
          snapshot = await createProfileSnapshot(dshHome, profileName, options.snapshotRoot)
          options.emitEvent({ kind: 'snapshot' })

          const installables: InstallableItem[] = []

          // 插件与技能共用同一解压字节预算：2 GiB 上限按一次导入的累计解出字节封顶，
          // 防止被拆成多个候选各自「达标」而整体绕过（zip-bomb）。
          const extractBudget: ExtractByteBudget = { extracted: 0 }

          // 插件本体解到启动器的共享缓存（file: 引用不悬空，不创建整合包 Profile）。
          if (wantedPlugins.length > 0) {
            const bodiesDir = packBodiesDir(dshHome, packId)
            await rm(bodiesDir, { recursive: true, force: true }).catch(() => undefined)
            const bodies = await extractRawPluginBodiesFromPath(filePath, wantedPlugins, bodiesDir, undefined, extractBudget)
            for (const plugin of wantedPlugins) {
              const bodyDir = bodies.get(plugin.packageName)
              if (!bodyDir) {
                installables.push({ packageName: plugin.packageName, offline: true, install: async () => { throw new Error('插件本体解出失败。') } })
                continue
              }
              const sharedBodyDir = await sharedPluginBodyDir(dshHome, plugin.packageName, bodyDir)
              const target: PackInstallTarget = {
                id: plugin.packageName,
                packageName: plugin.packageName,
                version: plugin.version ?? null,
                source: 'local-directory',
                profileName,
                platform: 'unknown',
                subdirectory: null,
                commit: '',
                requiresBuild: false,
                buildScripts: [],
                nodeRange: null,
                localDirectory: sharedBodyDir,
              }
              installables.push({ packageName: plugin.packageName, offline: true, install: async () => { await installManifestPlugin(target) } })
            }
          }

          // 技能解到 dshHome 内 staging（与 skills/ 同卷），逐项全局安装。
          if (wantedSkills.length > 0) {
            skillStaging = await mkdtemp(path.join(dshHome, '.pack-raw-staging-'))
            const sources = await extractRawSkillSourcesFromPath(filePath, wantedSkills, skillStaging, undefined, extractBudget)
            for (const skill of wantedSkills) {
              const sourceDir = sources.get(skill.name)
              if (!sourceDir) {
                installables.push({ packageName: skill.name, offline: true, install: async () => { throw new Error('技能来源解出失败。') } })
                continue
              }
              const skillInstall = { name: skill.name, format: skill.format, sourceDir }
              installables.push({ packageName: skill.name, offline: true, install: async () => { await options.installer.installSkillLocal(dshHome, skillInstall) } })
            }
          }

          // 预设解到 dshHome 内 staging，再逐项全局安装到 .agent-presets。
          if (wantedPresets.length > 0) {
            presetStaging = await mkdtemp(path.join(dshHome, '.pack-raw-preset-staging-'))
            const sources = await extractRawPresetSourcesFromPath(filePath, wantedPresets, presetStaging, undefined, extractBudget)
            for (const preset of wantedPresets) {
              const sourceDir = sources.get(preset.name)
              if (!sourceDir) {
                installables.push({ packageName: preset.name, offline: true, install: async () => { throw new Error('预设来源解出失败。') } })
                continue
              }
              installables.push({ packageName: preset.name, offline: true, install: async () => { await options.installer.installPresetLocal(dshHome, { name: preset.name, sourceDir }) } })
            }
          }

          const { installed, failures } = await runSerialInstall(installables, { emitEvent: options.emitEvent })
          if (!options.unifiedProfiles) await reapplyCurrentSelection(settings, profileBeforeInstall)
          const result = buildInstallResult(packId, installed, failures)

          const installedPluginNames = wantedPlugins
            .filter(plugin => installed.includes(plugin.packageName))
            .map(plugin => plugin.packageName)
          const installedSkills: PackInstalledSkill[] = wantedSkills
            .filter(skill => installed.includes(skill.name))
            .map(skill => ({ name: skill.name, format: skill.format, enabled: true }))
          const installedPresets: PackInstalledPreset[] = wantedPresets
            .filter(preset => installed.includes(preset.name))
            .map(preset => ({ name: preset.name, enabled: true }))

          if (options.unifiedProfiles) {
            await applyPluginSet(
              profileName,
              installedPluginNames.map(packageName => ({ packageName, enabled: true })),
              installedPluginNames,
            )
          }

          const record: PackRecord = {
            id: packId,
            name: packName,
            description: `非标准整合包：扫描到 ${scan.plugins.length} 个插件、${scan.skills.length} 个技能${scan.presets.length > 0 ? `、${scan.presets.length} 个预设` : ''}。`,
            version: '1.0.0',
            dshVersion,
            source: 'raw',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: result.state,
            plugins: toInstalledPlugins(installedPluginNames),
            skills: installedSkills,
            ...(installedPresets.length > 0 ? { presets: installedPresets } : {}),
            failures: result.failures.length > 0 ? result.failures : undefined,
          }
          await upsertPackRecord(options.registryPath, record)
          await writeRecordManifest(record)
          log('success', `非标准整合包「${packName}」已导入：${installed.length} 项。`)
          options.emitEvent({ kind: 'done', result })
          return result
        }

        const inspection = await inspectPackZipFromPath(filePath)
        const manifest = inspection.manifest
        assertPackDshVersion(manifest)
        if (importOptions?.mode === 'full') {
          // Full repository imports are intentionally strict: the archive is
          // the author's source of truth and must never silently fall back to
          // a newer npm/GitHub copy when a body is missing.
          await validateFullArchive(filePath, manifest)
        }
        const existing = await readPackRegistry(options.registryPath)
        const dshHome = await getDshHome()
        const packId = await resolveImportedProfileId(packProfileName(manifest.name), dshHome, existing, importOptions)
        const settings = await options.readSettings()
        const profileName = options.unifiedProfiles ? packId : settings.profileName
        if (options.unifiedProfiles) await ensureUnifiedProfile(dshHome, profileName, settings.profileName, { description: manifest.description, dshVersion: manifest.dshVersion, source: 'zip' })
        const profileBeforeInstall = await options.installer.readProfile(dshHome, profileName)

        // 决定要安装的包名集合：显式 items 优先，否则有 body 按 body，否则按 manifest。
        // 插件 / 技能 / 预设 / 应用是独立资源，分开处理。
        const requested = items && items.length > 0 ? items : undefined
        const manifestEntries = new Map(manifest.plugins.map(entry => [entry.packageName, entry]))
        const presetEntries = new Map((manifest.presets ?? []).map(entry => [entry.name, entry]))
        const skillEntries = new Map((manifest.skills ?? []).map(entry => [entry.name, entry]))
        const applicationEntries = new Map((manifest.applications ?? []).map(entry => [entry.id, entry]))
        const presetNames = new Set(presetEntries.keys())
        const skillNames = new Set(skillEntries.keys())
        const applicationIds = new Set(applicationEntries.keys())

        const requestedItems = requested ?? []
        const requestedSet = requested ? new Set(requestedItems) : null
        const wantedPlugins = requestedSet
          ? requestedItems.filter(name => !presetNames.has(name) && !skillNames.has(name) && !applicationIds.has(name))
          : inspection.hasBodies
            // Archive entry enumeration is not guaranteed to match the
            // manifest. Use the manifest as the source of display/load order.
            ? manifest.plugins.map(entry => entry.packageName).filter(name => inspection.bodyPackageNames.includes(name))
            : manifest.plugins.map(entry => entry.packageName)
        const wantedPresets = requestedSet
          ? requestedItems.filter(name => presetNames.has(name))
          : [...presetNames]
        const wantedSkills = requestedSet
          ? requestedItems.filter(name => skillNames.has(name))
          : [...skillNames]
        const wantedApplications = requestedSet
          ? requestedItems.filter(name => applicationIds.has(name))
          : [...applicationIds]

        const installables: InstallableItem[] = []

        options.emitEvent({ kind: 'status', message: `正在导入整合包「${manifest.name}」…` })
        snapshot = await createProfileSnapshot(dshHome, profileName, options.snapshotRoot)
        options.emitEvent({ kind: 'snapshot' })

        if (inspection.hasBodies) {
          // 本体解到启动器共享缓存：DSH 通过 file: 引用它，任务结束后不得删除。
          const bodiesDir = packBodiesDir(dshHome, packId)
          await rm(bodiesDir, { recursive: true, force: true }).catch(() => undefined)
          const knownNames = new Set(manifest.plugins.map(entry => entry.packageName))
          const bodies = await extractPackBodiesFromPath(filePath, bodiesDir, undefined, knownNames)
          for (const packageName of wantedPlugins) {
            if (!isSafePackageName(packageName)) {
              installables.push({ packageName, install: async () => { throw new Error('插件名称非法。') } })
              continue
            }
            const bodyDir = bodies.get(packageName)
            if (bodyDir) {
              if (importOptions?.mode === 'full') {
                let bodyManifest: { name?: unknown; version?: unknown }
                try {
                  bodyManifest = JSON.parse(await readFile(path.join(bodyDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
                } catch {
                  throw new Error(`完整安装插件本体缺少 package.json：${packageName}`)
                }
                if (bodyManifest.name !== packageName) throw new Error(`完整安装插件包名不一致：清单 ${packageName}，本体 ${String(bodyManifest.name ?? '未知')}`)
                const expectedVersion = manifestEntries.get(packageName)?.version
                if (expectedVersion && bodyManifest.version !== expectedVersion) {
                  throw new Error(`完整安装插件版本不一致：${packageName} 要求 ${expectedVersion}，本体 ${String(bodyManifest.version ?? '未知')}`)
                }
              }
              const sharedBodyDir = await sharedPluginBodyDir(dshHome, packageName, bodyDir)
              const target: PackInstallTarget = {
                id: packageName,
                packageName,
                version: null,
                source: 'local-directory',
                profileName,
                platform: 'unknown',
                subdirectory: null,
                commit: '',
                requiresBuild: false,
                buildScripts: [],
                nodeRange: null,
                localDirectory: sharedBodyDir,
              }
              installables.push({ packageName, offline: true, install: async () => { await installManifestPlugin(target) } })
            } else if (importOptions?.mode === 'full') {
              installables.push({ packageName, offline: true, install: async () => { throw new Error(`完整安装缺少插件本体：${packageName}`) } })
            } else {
              const target = manifestEntryToTarget(manifestEntries.get(packageName), profileName)
              if (target) {
                installables.push({ packageName, offline: false, install: async () => { await installManifestPlugin(target) } })
              } else {
                installables.push({ packageName, offline: false, install: async () => { throw new Error('清单中缺少该插件的来源，无法联网安装') } })
              }
            }
          }
        } else {
          for (const packageName of wantedPlugins) {
            if (!isSafePackageName(packageName)) {
              installables.push({ packageName, install: async () => { throw new Error('插件名称非法。') } })
              continue
            }
            const target = manifestEntryToTarget(manifestEntries.get(packageName), profileName)
            if (target) {
              installables.push({ packageName, offline: false, install: async () => { await installManifestPlugin(target) } })
            } else {
              installables.push({ packageName, offline: false, install: async () => { throw new Error('清单中缺少该插件的来源，无法联网安装') } })
            }
          }
        }

        // Agent 预设：优先用包内 preset-bodies 离线安装，否则按清单 pin 联网安装。
        presetBodiesDir = path.join(dshHome, '.pack-preset-bodies', packId)
        await rm(presetBodiesDir, { recursive: true, force: true }).catch(() => undefined)
        const presetBodies = await extractPresetBodiesFromPath(filePath, presetBodiesDir)
        for (const presetName of wantedPresets) {
          const preset = presetEntries.get(presetName)!
          const bodyDir = presetBodies.get(presetName)
          if (bodyDir) {
            installables.push({
              packageName: presetName,
              offline: true,
              install: async () => { await options.installer.installPresetLocal(dshHome, { name: presetName, sourceDir: bodyDir }) },
            })
            continue
          }
          if (!preset.repository || !preset.sourcePath || !preset.revision) {
            installables.push({ packageName: presetName, install: async () => { throw new Error('清单中缺少该预设的来源信息') } })
            continue
          }
          installables.push({
            packageName: presetName,
            offline: false,
            install: async () => {
              await options.installer.installPreset({
                repository: preset.repository!,
                targetId: presetName,
                name: presetName,
                sourcePath: preset.sourcePath!,
                revision: preset.revision!,
              })
            },
          })
        }

        // Skill：按清单里的 pin 信息直接安装，不重新分析 HEAD。
        for (const skillName of wantedSkills) {
          const skill = skillEntries.get(skillName)!
          if (!skill.repository || !skill.sourcePath || !skill.revision) {
            installables.push({ packageName: skillName, install: async () => { throw new Error('清单中缺少该 Skill 的来源信息') } })
            continue
          }
          installables.push({
            packageName: skillName,
            offline: false,
            install: async () => {
              await options.installer.installSkillPinned({
                repository: skill.repository!,
                target: {
                  id: `${skillName}:${skill.sourcePath}`,
                  name: skillName,
                  description: '',
                  sourcePath: skill.sourcePath!,
                  format: skill.format,
                  revision: skill.revision!,
                  modelInvocable: false,
                  userInvocable: false,
                },
              })
            },
          })
        }

        // Application Addon：按仓库重新分析安装（暂不支持离线本体）。
        for (const addonId of wantedApplications) {
          const application = applicationEntries.get(addonId)!
          installables.push({
            packageName: addonId,
            offline: false,
            install: async () => {
              await options.applicationAddons.install({
                repository: application.repository,
                defaultBranch: 'main',
                targetId: application.id,
              })
            },
          })
        }

        const { installed, failures } = await runSerialInstall(installables, { emitEvent: options.emitEvent })
        if (!options.unifiedProfiles) await reapplyCurrentSelection(settings, profileBeforeInstall)
        const result = buildInstallResult(packId, installed, failures)

        // Keep the record and Profile order aligned with the manifest even if
        // skills, presets, or archive entries complete in another order.
        const installedPluginNames = wantedPlugins.filter(name => installed.includes(name))
        const installedPresetNames = installed.filter(name => presetNames.has(name))
        const installedSkillNames = installed.filter(name => skillNames.has(name))
        const installedApplicationIds = installed.filter(name => applicationIds.has(name))
        const record: PackRecord = {
          id: packId,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          dshVersion: manifest.dshVersion,
          source: inspection.hasBodies ? 'zip' : 'manifest',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state: result.state,
          plugins: installedPluginNames.map(packageName => ({
            packageName,
            enabled: manifestEntries.get(packageName)?.enabled !== false,
          })),
          ...(installedPresetNames.length > 0 ? { presets: installedPresetNames.map(name => ({ name, enabled: true })) } : {}),
          ...(installedSkillNames.length > 0 ? { skills: installedSkillNames.map(name => ({ name, format: skillEntries.get(name)?.format ?? 'bundle', enabled: true })) } : {}),
          ...(installedApplicationIds.length > 0 ? { applications: installedApplicationIds.map(id => ({ id, name: applicationEntries.get(id)?.name ?? id, enabled: true })) } : {}),
          failures: result.failures.length > 0 ? result.failures : undefined,
        }
        if (options.unifiedProfiles) {
          await applyPluginSet(
            profileName,
            installedPluginNames.map(packageName => ({
              packageName,
              enabled: manifestEntries.get(packageName)?.enabled !== false,
            })),
            installedPluginNames,
          )
        }
        await upsertPackRecord(options.registryPath, record)
        await writeRecordManifest(record, manifest)
        const extraParts: string[] = []
        if (installedPresetNames.length > 0) extraParts.push(`${installedPresetNames.length} 个预设`)
        if (installedSkillNames.length > 0) extraParts.push(`${installedSkillNames.length} 个技能`)
        if (installedApplicationIds.length > 0) extraParts.push(`${installedApplicationIds.length} 个应用`)
        log('success', `整合包「${manifest.name}」已导入：${installedPluginNames.length} 个插件${extraParts.length > 0 ? `、${extraParts.join('、')}` : ''}。`)
        options.emitEvent({ kind: 'done', result })
        return result
      } catch (error) {
        const message = asErrorMessage(error)
        options.emitEvent({ kind: 'error', message })
        throw error
      } finally {
        if (skillStaging) await rm(skillStaging, { recursive: true, force: true }).catch(() => undefined)
        if (presetStaging) await rm(presetStaging, { recursive: true, force: true }).catch(() => undefined)
        if (presetBodiesDir) await rm(presetBodiesDir, { recursive: true, force: true }).catch(() => undefined)
        active = false
      }
    },

    async exportPack(packId, exportMode: ProfileExportMode = 'light') {
      const reason = guarded()
      if (reason) throw new Error(reason)
      active = true
      let exportDir: string | null = null
      try {
        const dshHome = await getDshHome()
        const settings = await options.readSettings()
        const currentProfile = await options.installer.readProfile(dshHome, options.unifiedProfiles ? packId : settings.profileName)
        let record: PackRecord
        try {
          record = await findRecord(packId)
        } catch (error) {
          if (!options.unifiedProfiles || settings.profileName !== packId) throw error
          record = {
            id: packId,
            name: packId.replace(/^pack-/, ''),
            description: '',
            version: '1.0.0',
            ...(settings.dshVersion ? { dshVersion: settings.dshVersion } : {}),
            source: 'created',
            installedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: 'complete',
            plugins: currentProfile.plugins.filter(plugin => !plugin.builtin).map(plugin => ({ packageName: plugin.packageName, enabled: plugin.enabled })),
          }
        }
        const exportProfileName = options.unifiedProfiles ? packId : settings.profileName
        const receipts = (await readPluginReceipts(options.pluginReceiptsPath))
          .filter(item => item.profileName === exportProfileName && record.plugins.some(plugin => plugin.packageName === item.packageName))
        const presetNames = new Set((record.presets ?? []).map(preset => preset.name))
        const presetReceipts = (await readPresetReceipts(options.presetReceiptsPath))
          .filter(item => presetNames.has(item.name))
        const skillNames = new Set((record.skills ?? []).map(skill => skill.name))
        const skillReceipts = (await readSkillReceipts(options.skillReceiptsPath))
          .filter(item => skillNames.has(item.name))
        const applicationIds = new Set((record.applications ?? []).map(addon => addon.id))
        const applicationAddons = (await options.applicationAddons.list())
          .filter(addon => applicationIds.has(addon.id))
        const orderedReceipts = record.plugins
          .map(plugin => receipts.find(receipt => receipt.packageName === plugin.packageName))
          .filter((receipt): receipt is PluginInstallReceipt => receipt !== undefined)
        const dshVersion = isValidPackDshVersion(record.dshVersion)
          ? normalizePackDshVersion(record.dshVersion)
          : await resolvePackDshVersion(settings)
        const manifest = buildManifestFromReceipts(packId, orderedReceipts, presetReceipts, skillReceipts, applicationAddons, dshVersion)
        manifest.plugins = manifest.plugins.map((entry) => {
          const recordPlugin = record.plugins.find(plugin => plugin.packageName === entry.packageName)
          return { ...entry, enabled: recordPlugin?.enabled ?? true }
        })
        // 把没有来源记录、但已安装在本机 Profile 的非内置插件也纳入导出：它们以 local 源 + 本地本体形式离线携带。
        const manifestPluginNames = new Set(manifest.plugins.map(entry => entry.packageName))
        const installedPluginsByPackage = new Map(
          currentProfile.plugins
            .filter(plugin => !plugin.builtin)
            .map(plugin => [plugin.packageName, plugin]),
        )
        for (const plugin of record.plugins) {
          if (manifestPluginNames.has(plugin.packageName)) continue
          const installed = installedPluginsByPackage.get(plugin.packageName)
          if (!installed) continue
          manifest.plugins.push({
            packageName: plugin.packageName,
            source: 'local',
            version: installed.version,
            enabled: plugin.enabled,
          })
          manifestPluginNames.add(plugin.packageName)
        }
        const unresolvedRemote: string[] = []
        manifest.plugins = manifest.plugins.map(entry => {
          const pinned = entry.source === 'npm'
            ? Boolean(entry.version)
            : entry.source === 'github'
              ? Boolean(entry.repository && entry.commit)
              : true
          if (pinned) return entry
          const localDirectory = path.join(dshHome, 'profiles', exportProfileName, 'node_modules', ...entry.packageName.split('/'))
          if (!existsSync(localDirectory)) {
            unresolvedRemote.push(entry.packageName)
            return entry
          }
          // A source that cannot be pinned is made self-contained for light
          // exports instead of silently installing a moving @latest/HEAD.
          return { packageName: entry.packageName, source: 'local', version: entry.version }
        })
        if (unresolvedRemote.length > 0) {
          throw new Error(`导出 Profile「${packId}」失败：无法固定插件来源（${unresolvedRemote.join('、')}），且本地没有可携带的插件本体。`)
        }
        // 预设即使没有来源记录，只要本地本体存在，就纳入 manifest（配合 presetDirs 离线导入）。
        const manifestPresetNames = new Set((manifest.presets ?? []).map(entry => entry.name))
        for (const preset of record.presets ?? []) {
          if (!manifestPresetNames.has(preset.name)) {
            manifest.presets = [...(manifest.presets ?? []), { name: preset.name }]
            manifestPresetNames.add(preset.name)
          }
        }
        // 只收集 manifest 引用的插件本体：profile 里可能混入未被选入包的手动安装插件，不应进包。
        const packageNames = manifest.plugins.map(entry => entry.packageName)
        // 预设本体也打进 zip：换机导入时可完全离线安装。
        const presetDirs = new Map<string, string>()
        for (const preset of record.presets ?? []) {
          const dir = path.join(dshHome, '.agent-presets', preset.name)
          if (existsSync(dir)) presetDirs.set(preset.name, dir)
        }
        const packProfileDir = path.join(dshHome, 'profiles', options.unifiedProfiles ? packId : settings.profileName)
        const exportRoot = path.join(options.snapshotRoot, 'exports')
        await mkdir(exportRoot, { recursive: true })
        exportDir = await mkdtemp(path.join(exportRoot, 'pack-'))
        const zipPath = path.join(exportDir, `${packId}.zip`)
        const bodyNames = exportMode === 'full'
          ? packageNames
          // Lightweight exports carry only local/unmatched bodies. npm
          // entries remain reinstallable from the registry and therefore do
          // not inflate the lightweight archive.
          : manifest.plugins.filter(entry => entry.source === 'local' || (!entry.repository && entry.source !== 'npm')).map(entry => entry.packageName)
        const { missing } = await buildPackExportToFile(packProfileDir, manifest, bodyNames, zipPath, presetDirs)
        if (missing.length > 0) {
          const message = `导出 Profile「${packId}」失败：以下插件缺少本地本体（${missing.join('、')}），无法生成${exportMode === 'full' ? '全量' : '离线'}包。`
          log('error', message)
          throw new Error(message)
        }
        return { zipPath, fileName: `${packId}.zip` }
      } catch (error) {
        if (exportDir) await rm(exportDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      } finally {
        active = false
      }
    },

    async activatePack(packId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        const record = await findRecord(packId)
        const settings = await options.readSettings()
        if (options.unifiedProfiles) {
          const dshHome = await getDshHome()
          const profileDir = path.join(dshHome, 'profiles', packId)
          if (!existsSync(profileDir)) throw new Error(`Profile「${packId}」不存在，请先导入或创建该 Profile。`)
          const metadata = await readProfileMetadata(dshHome, packId)
          return options.saveSettings({ ...settings, profileName: packId, dshVersion: metadata.dshVersion, activePackId: null })
        }
        if (!settings.activePackId) await saveBaseline(await currentBaseline(settings))
        await applyPluginSet(settings.profileName, record.plugins, record.plugins.map(item => item.packageName))
        for (const skill of record.skills ?? []) await options.installer.toggleSkill(skill.name, skill.enabled)
        for (const preset of record.presets ?? []) await options.installer.togglePreset(preset.name, preset.enabled)
        if (options.applicationAddons.toggle) {
          for (const addon of record.applications ?? []) await options.applicationAddons.toggle(addon.id, addon.enabled)
        }
        return options.saveSettings({ ...settings, activePackId: packId })
      } finally {
        active = false
      }
    },

    async deactivatePack() {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        const settings = await options.readSettings()
        if (options.unifiedProfiles) return settings
        if (!settings.activePackId) return settings
        await restoreBaseline(settings)
        return options.readSettings()
      } finally {
        active = false
      }
    },

    async removePack(packId) {
      const settings = await options.readSettings()
      const reason = (options.unifiedProfiles ? settings.profileName === packId : settings.activePackId === packId)
        ? guarded()
        : guardPackStart({
            isRuntimeRunning: () => false,
            isInstallerBusy: options.isInstallerBusy,
            isPackBusy: () => active,
          })
      if (reason) throw new Error(reason)
      beginTask()
      try {
        const record = await findRecord(packId)
        if (options.unifiedProfiles) {
          if (settings.profileName === packId) throw new Error('当前 Profile 不能删除，请先切换到其他 Profile。')
          const dshHome = await getDshHome()
          await rm(path.join(dshHome, 'profiles', packId), { recursive: true, force: true })
          await rm(packBodiesDir(dshHome, packId), { recursive: true, force: true }).catch(() => undefined)
          const profileReceipts = (await readPluginReceipts(options.pluginReceiptsPath)).filter(item => item.profileName === packId)
          for (const receipt of profileReceipts) {
            await removePluginReceipt(options.pluginReceiptsPath, packId, receipt.packageName)
          }
        }
        if (isSelectedProfile(settings, packId)) {
          await restoreBaseline(settings)
        }
        await removePackRecord(options.registryPath, packId)
        await removePackManifest(manifestRoot, packId)
        return {
          removed: record.plugins.length
            + (record.presets?.length ?? 0)
            + (record.skills?.length ?? 0)
            + (record.applications?.length ?? 0),
        }
      } finally {
        active = false
      }
    },

    async rollback() {
      const reason = guarded()
      if (reason) throw new Error(reason)
      if (!snapshot) throw new Error('没有可用快照，无法还原。')
      active = true
      try {
        const result = await restoreProfileSnapshot(snapshot)
        // 共享 Profile 模式下回滚只恢复清单文件，绝不删除当前 Profile 目录。
        if (profileWasNew && snapshot.profileName !== (await options.readSettings()).profileName) {
          await rm(path.join(snapshot.dshHome, 'profiles', snapshot.profileName), { recursive: true, force: true }).catch(() => undefined)
          await removePackRecord(options.registryPath, snapshot.profileName).catch(() => undefined)
        }
        const settings = await options.readSettings()
        await options.saveSettings({ ...settings, activePackId: null })
        options.emitEvent({ kind: 'status', message: `已还原快照 ${snapshot.id}` })
        return { restored: result.restored, profileName: snapshot.profileName }
      } finally {
        active = false
        snapshot = null
        profileWasNew = false
      }
    },

    hasSnapshot: async () => snapshot !== null,

    async addPackPlugin(packId, packageName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      profileWasNew = false
      try {
        assertSafePackId(packId)
        if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')

        const settings = await options.readSettings()
        const dshHome = await getDshHome()
        const currentProfile = await options.installer.readProfile(dshHome, settings.profileName)
        const installedPlugin = currentProfile.plugins.find(item => item.packageName === packageName)
        if (!installedPlugin || installedPlugin.builtin) throw new Error('当前 Profile 中找不到可打包的非内置插件。')
        options.emitEvent({ kind: 'status', message: `正在向整合包添加插件 ${packageName}…` })
        const record = await findRecord(packId)
        const plugins = [...record.plugins.filter(item => item.packageName !== packageName), { packageName, enabled: true }]
        const updated: PackRecord = { ...record, plugins, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await applyPluginSet(settings.profileName, updated.plugins, updated.plugins.map(item => item.packageName))
        return toPackStatus(updated, selectedPackKey(settings))
      } catch (error) {
        options.emitEvent({ kind: 'error', message: asErrorMessage(error) })
        throw error
      } finally {
        active = false
      }
    },

    async addPackPreset(packId, presetName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) throw new Error('预设名称无效。')
        const settings = await options.readSettings()
        const dshHome = await getDshHome()
        if (!existsSync(path.join(dshHome, '.agent-presets', presetName))) throw new Error('当前环境找不到已安装的该预设。')
        const record = await findRecord(packId)
        if (record.presets?.some(item => item.name === presetName)) {
          return toPackStatus(record, selectedPackKey(settings))
        }
        const presets = [...(record.presets ?? []), { name: presetName, enabled: true }]
        const updated: PackRecord = { ...record, presets, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async addPackSkill(packId, skillName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) throw new Error('Skill 名称无效。')
        const settings = await options.readSettings()
        const receipts = await readSkillReceipts(options.skillReceiptsPath)
        const receipt = receipts.find(item => item.name === skillName)
        if (!receipt) throw new Error('当前环境找不到该 Skill 的来源记录。')
        const record = await findRecord(packId)
        if (record.skills?.some(item => item.name === skillName)) {
          return toPackStatus(record, selectedPackKey(settings))
        }
        const skills = [...(record.skills ?? []), { name: skillName, format: receipt.format, enabled: true }]
        const updated: PackRecord = { ...record, skills, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackSkill(packId, skillName, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) throw new Error('Skill 名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const skills = (record.skills ?? []).map(item => item.name === skillName ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, skills, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.toggleSkill(skillName, Boolean(enabled))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackSkill(packId, skillName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) throw new Error('Skill 名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const skills = (record.skills ?? []).filter(item => item.name !== skillName)
        const updated: PackRecord = { ...record, skills: skills.length > 0 ? skills : undefined, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.toggleSkill(skillName, false)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async addPackApplication(packId, addonId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        const settings = await options.readSettings()
        const addons = await options.applicationAddons.list()
        const addon = addons.find(item => item.id === addonId)
        if (!addon) throw new Error('当前环境找不到已安装的应用加载项。')
        const record = await findRecord(packId)
        if (record.applications?.some(item => item.id === addonId)) {
          return toPackStatus(record, selectedPackKey(settings))
        }
        const applications = [...(record.applications ?? []), { id: addonId, name: addon.name, enabled: true }]
        const updated: PackRecord = { ...record, applications, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackApplication(packId, addonId, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        const settings = await options.readSettings()
        if (isSelectedProfile(settings, packId) && options.applicationAddons.toggle) {
          await options.applicationAddons.toggle(addonId, Boolean(enabled))
        }
        const record = await findRecord(packId)
        const applications = (record.applications ?? []).map(item => item.id === addonId ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, applications, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackApplication(packId, addonId) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const applications = (record.applications ?? []).filter(item => item.id !== addonId)
        const updated: PackRecord = { ...record, applications: applications.length > 0 ? applications : undefined, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId) && options.applicationAddons.toggle) await options.applicationAddons.toggle(addonId, false)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackPreset(packId, presetName, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) throw new Error('预设名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const presets = (record.presets ?? []).map(item => item.name === presetName ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, presets, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.togglePreset(presetName, Boolean(enabled))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackPreset(packId, presetName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetName)) throw new Error('预设名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const presets = (record.presets ?? []).filter(item => item.name !== presetName)
        const updated: PackRecord = { ...record, presets: presets.length > 0 ? presets : undefined, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await options.installer.togglePreset(presetName, false)
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async togglePackItem(packId, packageName, enabled) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const plugins = record.plugins.map(item => item.packageName === packageName ? { ...item, enabled: Boolean(enabled) } : item)
        const updated: PackRecord = { ...record, plugins, updatedAt: new Date().toISOString() }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await applyPluginSet(settings.profileName, updated.plugins, updated.plugins.map(item => item.packageName))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },

    async removePackItem(packId, packageName) {
      const reason = guarded()
      if (reason) throw new Error(reason)
      beginTask()
      try {
        assertSafePackId(packId)
        if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
        const settings = await options.readSettings()
        const record = await findRecord(packId)
        const plugins = record.plugins.filter(item => item.packageName !== packageName)
        const updated: PackRecord = { ...record, plugins, updatedAt: new Date().toISOString() }
        if (options.unifiedProfiles && isSelectedProfile(settings, packId)) {
          await options.installer.remove(packageName, settings.profileName)
        }
        await upsertPackRecord(options.registryPath, updated)
        await writeRecordManifest(updated)
        if (isSelectedProfile(settings, packId)) await applyPluginSet(settings.profileName, updated.plugins, updated.plugins.map(item => item.packageName))
        return toPackStatus(updated, selectedPackKey(settings))
      } finally {
        active = false
      }
    },
  }
}
