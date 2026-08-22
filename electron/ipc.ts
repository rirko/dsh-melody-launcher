import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC, IPC_EVENTS } from '../src/constants'
import type { AiSessionCreateInput, ApplicationInstallRequest, AppSettings, CustomApiProviderInput, PackCreateRequest, PluginInstallRequest, PresetInstallRequest, SkillInstallRequest, WindowMode, ProfileRepositoryImportMode, PackPluginEntry } from '../src/types'
import type { ApplicationAddonManager } from './application-addons'
import { isWindowMode } from './app-window'
import { clearDeepSeekApiKey, getDeepSeekCredentialStatus, setDeepSeekApiKey } from './credentials'
import { listCustomApiProviders, removeCustomApiProvider, saveCustomApiProvider } from './custom-api'
import { searchCatalogRepositories, type DiscoverySort } from './discovery'
import { importCatalogFromUrl } from './github-import'
import type { Installer } from './installer'
import type { LauncherUpdater } from './launcher-update'
import type { AiInstaller } from './ai-install'
import { assertMeaningfulPackName } from './pack-manifest'
import { MAX_RAW_ARCHIVE_BYTES } from './pack-scan'
import type { PackManager } from './pack'
import type { PluginTrialManager } from './plugin-trial'
import type { CatalogSyncService } from './catalog-sync'
import type { DshMarketService } from './dsh-market'
import type { CopilotSessionManager } from './copilot-sessions'
import {
  isSafePackageName,
  isSafeProfileName,
  isSafeRepositoryName,
  readProfile,
  reorderPlugins,
  togglePlugin,
} from './profile'
import type { RuntimeController } from './runtime'
import type { SettingsStore } from './settings'
import type { GitHubAuthService } from './github-auth'
import { createLinkedComponentController } from './linked-components'
import type { RuntimeVersionService } from './runtime-versions'
import type { ProfileService } from './profile-service'
import { inspectPackZipFromPath } from './pack-zip'
import { serializePackManifest } from './pack-manifest'
import { writeProfileMetadata } from './profile-service'
import { readPluginReceipts } from './plugin-receipts'
import { analyzeProfileRepository, applyReceiptMatches, applySelectedMatches, loadProfileRepositoryManifest, manifestText, readProfileRepositoryArchive, validateFullArchive } from './profile-repository-import'

/**
 * 渲染层能触达主进程的全部入口。
 * 集中在一处，便于一眼看全攻击面：每个 handler 都先校验入参再进业务逻辑。
 */

export interface IpcDependencies {
  settings: SettingsStore
  pluginReceiptsPath: string
  runtime: RuntimeController
  installer: Installer
  launcherUpdater: LauncherUpdater
  pluginTrial: PluginTrialManager
  aiInstaller: AiInstaller
  copilot: CopilotSessionManager
  packManager: PackManager
  githubAuth: GitHubAuthService
  applicationAddons: ApplicationAddonManager
  catalogSync: CatalogSyncService
  dshMarket: DshMarketService
  runtimeVersions: RuntimeVersionService
  profiles: ProfileService
  getWindow: () => BrowserWindow | null
  setWindowMode: (mode: WindowMode) => void
}

export function registerIpcHandlers(deps: IpcDependencies): void {
  const { settings, pluginReceiptsPath, runtime, installer, launcherUpdater, pluginTrial, aiInstaller, copilot, packManager, githubAuth, applicationAddons, catalogSync, dshMarket, runtimeVersions, profiles } = deps
  const linkedComponents = createLinkedComponentController({
    readSettings: () => settings.read(),
    readProfile,
    togglePlugin,
    applications: applicationAddons,
    isRuntimeRunning: () => runtime.isRunning(),
  })

  // 安装、整合包切换、试运行和 AI 均可能改写同一个 Profile 或资源目录。
  // 渲染层只按动作禁用控件；这里作为跨页面的最终保护。
  const assertProfileMutationAvailable = () => {
    if (installer.isBusy()) throw new Error('DSH 或资源安装进行中，请等待完成。')
    if (packManager.isBusy()) throw new Error('整合包操作进行中，请等待完成。')
    if (pluginTrial.isBusy()) throw new Error('插件试运行进行中，请等待完成。')
    if (aiInstaller.isBusy()) throw new Error('AI 任务进行中，请等待完成。')
    if (copilot.isMutationBusy()) throw new Error('DSH Copilot 修改任务进行中，请等待完成。')
    if (applicationAddons.isBusy()) throw new Error('应用加载项操作进行中，请等待完成。')
    if (dshMarket.isBusy()) throw new Error('DSH Market 插件操作进行中，请等待完成。')
    if (runtimeVersions.isBusy()) throw new Error('运行环境版本操作进行中，请等待完成。')
  }

  const resolveLocalPluginBodies = async (dshHome: string, packageNames: string[], receipts: Awaited<ReturnType<typeof readPluginReceipts>>): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    const root = path.resolve(dshHome)
    for (const packageName of packageNames) {
      const candidates = [...new Map(receipts.filter(receipt => receipt.packageName === packageName && receipt.source === 'local-directory' && receipt.repository.startsWith('file:')).map(receipt => [receipt.repository, receipt])).values()]
      if (candidates.length !== 1) continue
      const candidate = path.resolve(candidates[0].repository.slice('file:'.length))
      if (!(candidate === root || candidate.startsWith(`${root}${path.sep}`))) continue
      try {
        const packageManifest = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')) as { name?: unknown }
        if (packageManifest.name !== packageName) continue
        await stat(candidate)
        result[packageName] = candidate
      } catch {
        // Stale receipts are ignored; the normal matcher will report a blocker.
      }
    }
    return result
  }

  ipcMain.handle(IPC.settingsGet, () => settings.read())
  ipcMain.handle(IPC.settingsSave, (_event, next: AppSettings) => {
    assertProfileMutationAvailable()
    return settings.save(next)
  })
  ipcMain.handle(IPC.dshDetect, () => installer.detectDsh())
  ipcMain.handle(IPC.dshUpdateCheck, () => installer.checkDshUpdate())
  ipcMain.handle(IPC.runtimeEnvironmentRead, (_event, refresh?: boolean) => runtimeVersions.read(Boolean(refresh)))
  ipcMain.handle(IPC.runtimeEnvironmentInstallDsh, async (_event, version: string) => {
    assertProfileMutationAvailable()
    if (typeof version !== 'string') throw new Error('DSH 版本格式无效。')
    return runtimeVersions.installDsh(version)
  })
  ipcMain.handle(IPC.runtimeEnvironmentSelectDsh, async (_event, version: string) => {
    assertProfileMutationAvailable()
    if (typeof version !== 'string') throw new Error('DSH 版本格式无效。')
    return runtimeVersions.selectDsh(version)
  })
  ipcMain.handle(IPC.runtimeEnvironmentRemoveDsh, async (_event, version: string) => {
    assertProfileMutationAvailable()
    if (typeof version !== 'string') throw new Error('DSH 版本格式无效。')
    return runtimeVersions.removeDsh(version)
  })
  ipcMain.handle(IPC.runtimeEnvironmentInstallNode, async (_event, version: string) => {
    assertProfileMutationAvailable()
    if (typeof version !== 'string') throw new Error('Node.js 版本格式无效。')
    return runtimeVersions.installNode(version)
  })
  ipcMain.handle(IPC.runtimeEnvironmentSelectNode, async (_event, version: string | null) => {
    assertProfileMutationAvailable()
    if (version !== null && typeof version !== 'string') throw new Error('Node.js 版本格式无效。')
    return runtimeVersions.selectNode(version)
  })
  ipcMain.handle(IPC.runtimeEnvironmentRemoveNode, async (_event, version: string) => {
    assertProfileMutationAvailable()
    if (typeof version !== 'string') throw new Error('Node.js 版本格式无效。')
    return runtimeVersions.removeNode(version)
  })
  ipcMain.handle(IPC.runtimeEnvironmentCancel, () => runtimeVersions.cancel())
  ipcMain.handle(IPC.runtimeEnvironmentOpenDshFolder, async () => {
    const state = await runtimeVersions.read()
    await shell.openPath(state.dshRoot)
  })
  ipcMain.handle(IPC.runtimeEnvironmentOpenNodeFolder, async () => {
    const state = await runtimeVersions.read()
    await shell.openPath(state.nodeRoot)
  })
  ipcMain.handle(IPC.launcherUpdateCheck, () => launcherUpdater.check())
  ipcMain.handle(IPC.launcherUpdateDownload, () => launcherUpdater.download())
  ipcMain.handle(IPC.launcherUpdateApply, () => launcherUpdater.apply())

  ipcMain.handle(IPC.credentialStatus, async () => {
    const current = await settings.read()
    return getDeepSeekCredentialStatus(current.dshHome)
  })
  ipcMain.handle(IPC.credentialSet, async (_event, apiKey: string) => {
    if (typeof apiKey !== 'string') throw new Error('API Key 格式无效。')
    const current = await settings.read()
    return setDeepSeekApiKey(current.dshHome, apiKey)
  })
  ipcMain.handle(IPC.credentialClear, async () => {
    const current = await settings.read()
    return clearDeepSeekApiKey(current.dshHome)
  })
  ipcMain.handle(IPC.customApiList, async () => {
    const current = await settings.read()
    return listCustomApiProviders(current.dshHome)
  })
  ipcMain.handle(IPC.customApiSave, async (_event, input: CustomApiProviderInput) => {
    const current = await settings.read()
    return saveCustomApiProvider(current.dshHome, input)
  })
  ipcMain.handle(IPC.customApiRemove, async (_event, route: string) => {
    if (typeof route !== 'string') throw new Error('自定义 API 路由格式无效。')
    const current = await settings.read()
    return removeCustomApiProvider(current.dshHome, route)
  })

  ipcMain.handle(IPC.githubAuthStatus, () => githubAuth.getStatus())
  ipcMain.handle(IPC.githubAuthTokenLogin, (_event, token: string) => {
    if (typeof token !== 'string') throw new Error('GitHub 访问令牌格式无效。')
    return githubAuth.loginWithToken(token)
  })
  ipcMain.handle(IPC.githubAuthDeviceBegin, async () => {
    const authorization = await githubAuth.beginDeviceLogin()
    await shell.openExternal(authorization.verificationUri)
    return authorization
  })
  ipcMain.handle(IPC.githubAuthDeviceComplete, () => githubAuth.completeDeviceLogin())
  ipcMain.handle(IPC.githubAuthDeviceCancel, () => githubAuth.cancelDeviceLogin())
  ipcMain.handle(IPC.githubAuthLogout, () => githubAuth.logout())
  ipcMain.handle(IPC.githubPullRequests, () => githubAuth.listRecentPullRequests())
  ipcMain.handle(IPC.githubStarStatus, (_event, repository: string) => githubAuth.getStarStatus(repository))
  ipcMain.handle(IPC.githubStarSet, (_event, payload: { repository: string; starred: boolean }) => {
    if (!payload || typeof payload.repository !== 'string') throw new Error('GitHub 仓库名称无效。')
    return githubAuth.setStar(payload.repository, Boolean(payload.starred))
  })

  ipcMain.handle(IPC.chooseDirectory, async (_event, kind: 'dshInstallPath' | 'dshHome' | 'workspace') => {
    const window = deps.getWindow()
    if (!window) return null
    const current = await settings.read()
    const defaultPath = kind === 'dshInstallPath' ? current.dshInstallPath : kind === 'dshHome' ? current.dshHome : current.workspace
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.profileRead, async () => {
    const current = await settings.read()
    return readProfile(current.dshHome, current.profileName, pluginReceiptsPath)
  })
  ipcMain.handle(IPC.profilesList, () => profiles.list())
  ipcMain.handle(IPC.profilesCreate, async (_event, request) => {
    assertProfileMutationAvailable()
    if (!request || typeof request.name !== 'string' || !isSafeProfileName(request.name)) throw new Error('Profile 名称无效。')
    if (request.cloneFrom !== undefined && (typeof request.cloneFrom !== 'string' || !isSafeProfileName(request.cloneFrom))) throw new Error('源 Profile 名称无效。')
    return profiles.create({ name: request.name, description: typeof request.description === 'string' ? request.description : undefined, dshVersion: request.dshVersion ?? null, cloneFrom: request.cloneFrom })
  })
  ipcMain.handle(IPC.profilesClone, async (_event, payload) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.sourceName !== 'string' || typeof payload.targetName !== 'string' || !isSafeProfileName(payload.sourceName) || !isSafeProfileName(payload.targetName)) throw new Error('Profile 名称无效。')
    return profiles.clone(payload.sourceName, payload.targetName, typeof payload.description === 'string' ? payload.description : undefined)
  })
  ipcMain.handle(IPC.profilesSwitch, async (_event, payload: string | { profileName: string; fillMissing?: boolean }) => {
    assertProfileMutationAvailable()
    const profileName = typeof payload === 'string' ? payload : payload?.profileName
    if (typeof profileName !== 'string' || !isSafeProfileName(profileName)) throw new Error('Profile 名称无效。')
    const fillMissing = typeof payload === 'object' && payload?.fillMissing === true
    return profiles.switch(profileName, fillMissing)
  })
  ipcMain.handle(IPC.profilesDelete, async (_event, profileName: string) => {
    assertProfileMutationAvailable()
    if (typeof profileName !== 'string' || !isSafeProfileName(profileName)) throw new Error('Profile 名称无效。')
    return profiles.remove(profileName)
  })
  ipcMain.handle(IPC.profilesMetadata, async (_event, profileName: string) => {
    if (typeof profileName !== 'string' || !isSafeProfileName(profileName)) throw new Error('Profile 名称无效。')
    return profiles.metadata(profileName)
  })
  ipcMain.handle(IPC.profilesExport, async (_event, payload: { profileName: string; mode: string; repositoryPrivate?: boolean }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.profileName !== 'string' || !isSafeProfileName(payload.profileName)) throw new Error('Profile 名称无效。')
    if (!['light', 'full', 'repository'].includes(payload.mode)) throw new Error('Profile 导出模式无效。')
    // PackManager remains the compatibility implementation of the ZIP writer.
    // Its input is now the same profile id, so no second local runtime state is created.
    const mode = payload.mode as 'light' | 'full' | 'repository'
    const { zipPath, fileName } = await packManager.exportPack(payload.profileName, mode)
    if (mode === 'repository') {
      const auth = await githubAuth.getStatus()
      if (!auth.authenticated || !auth.login) throw new Error('仓库化导出需要先登录 GitHub。')
      const currentSettings = await settings.read()
      const existingMetadata = await profiles.metadata(payload.profileName).catch(() => null)
      const sourceRepository = existingMetadata?.source?.kind === 'github' ? existingMetadata.source.repository : null
      const sourceBranch = existingMetadata?.source?.kind === 'github' ? existingMetadata.source.branch ?? 'main' : 'main'
      const repo = sourceRepository
        ? {
            fullName: sourceRepository,
            htmlUrl: `https://github.com/${sourceRepository}`,
            defaultBranch: sourceBranch,
          }
        : await githubAuth.createRepository({
            name: `dsh-profile-${payload.profileName}`,
            description: `DSH Profile：${payload.profileName}`,
            private: payload.repositoryPrivate === true,
          })
      const inspection = await inspectPackZipFromPath(zipPath)
      await githubAuth.upsertRepositoryFile(repo.fullName, 'dsh-profile.yaml', serializePackManifest(inspection.manifest), `更新 Profile ${payload.profileName}` , repo.defaultBranch)
      await githubAuth.upsertRepositoryFile(repo.fullName, 'README.md', `# DSH Profile ${payload.profileName}\n\n此仓库由 DSH Launcher 管理。\n`, `更新 Profile ${payload.profileName} 说明`, repo.defaultBranch)
      // Repository imports use one stable canonical archive name. Local
      // downloads keep the Profile-specific filename for backward compatibility.
      await githubAuth.upsertRepositoryFile(repo.fullName, 'profile.zip', await readFile(zipPath), `更新 Profile ${payload.profileName} 完整包`, repo.defaultBranch)
      await writeProfileMetadata(currentSettings.dshHome, payload.profileName, {
        source: { kind: 'github', repository: repo.fullName, branch: repo.defaultBranch },
        exportedAt: new Date().toISOString(),
      })
      await rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined)
      return repo.htmlUrl
    }
    const window = deps.getWindow()
    if (!window) return null
    try {
      const result = await dialog.showSaveDialog(window, { defaultPath: fileName, filters: [{ name: 'Profile / 整合包', extensions: ['zip'] }] })
      if (result.canceled || !result.filePath) return null
      await copyFile(zipPath, result.filePath)
      return result.filePath
    } finally {
      await rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined)
    }
  })
  ipcMain.handle(IPC.profilesImport, async (_event, payload: { filePath: string; name?: string; overwrite?: boolean }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.filePath !== 'string') throw new Error('Profile 文件路径无效。')
    if (runtime.isRunning()) throw new Error('请先停止 DSH，再导入 Profile。')
    let importPath = payload.filePath
    let temporaryRoot: string | null = null
    let githubSource: { repository: string; branch?: string; commit?: string | null } | null = null
    let localPluginBodies: Record<string, string> = {}
    try {
      if (!path.isAbsolute(importPath)) {
        // Legacy callers keep the lightweight default: a remote repository is
        // imported from its manifest only. Full archive installation is
        // exposed through profilesRepositoryImport with an explicit mode.
        const loaded = await loadProfileRepositoryManifest(githubAuth, importPath)
        const environment = await runtimeVersions.read(false)
        if (!environment.dshInstalled.some(item => item.version === loaded.manifest.dshVersion)) {
          await runtimeVersions.installDsh(loaded.manifest.dshVersion!)
        }
        const receipts = await readPluginReceipts(pluginReceiptsPath)
        const manifest = applyReceiptMatches(loaded.manifest, receipts)
        const dshHome = (await settings.read()).dshHome
        localPluginBodies = await resolveLocalPluginBodies(dshHome, manifest.plugins.map(entry => entry.packageName), receipts)
        const unresolved = manifest.plugins.filter(entry => ((entry.source === 'npm' && !entry.version) || (entry.source !== 'npm' && (!entry.repository || !entry.commit))) && !localPluginBodies[entry.packageName])
        if (unresolved.length > 0) throw new Error(`来源安装无法匹配插件来源：${unresolved.map(entry => entry.packageName).join('、')}`)
        temporaryRoot = await mkdtemp(path.join(path.dirname(pluginReceiptsPath), 'profile-import-'))
        importPath = path.join(temporaryRoot, loaded.file.path)
        await writeFile(importPath, manifestText(manifest), 'utf8')
        githubSource = { repository: loaded.repository, branch: loaded.branch, commit: loaded.commit }
      }
      if (!path.isAbsolute(importPath)) throw new Error('Profile 文件路径无效。')
      const result = await packManager.importPack(importPath, undefined, payload.name || payload.overwrite ? { name: payload.name, overwrite: payload.overwrite === true, localPluginBodies } : { localPluginBodies })
      if (githubSource) {
        const importedSettings = await settings.read()
        await writeProfileMetadata(importedSettings.dshHome, result.id, { source: { kind: 'github', repository: githubSource.repository, ...(githubSource.branch ? { branch: githubSource.branch } : {}), ...(githubSource.commit ? { commit: githubSource.commit } : {}) } })
      }
      return profiles.metadata(result.id)
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  ipcMain.handle(IPC.profilesRepositoryAnalyze, async (_event, url: string) => {
    if (typeof url !== 'string' || !url.trim()) throw new Error('GitHub Profile 仓库链接无效。')
    const preview = await analyzeProfileRepository({ githubAuth, pluginReceiptsPath }, url)
    const existing = (await profiles.list()).find(item => item.source?.kind === 'github' && item.source.repository.toLowerCase() === preview.repository.toLowerCase())
    const environment = await runtimeVersions.read(false)
    const dshVersionInstalled = environment.dshInstalled.some(item => item.version === preview.dshVersion)
    if (!existing) return { ...preview, dshVersionInstalled }
    const current = await settings.read()
    const previous = await readProfile(current.dshHome, existing.id, pluginReceiptsPath)
    const previousPlugins = previous.plugins.filter(item => !item.builtin)
    const incoming = new Map(preview.plugins.map(item => [item.packageName, item]))
    const differences = [...preview.differences]
    for (const item of preview.plugins) {
      const old = previousPlugins.find(candidate => candidate.packageName === item.packageName)
      if (!old) differences.push({ kind: 'added', packageName: item.packageName, detail: '新增插件' })
      else {
        if (old.version && item.version && old.version !== item.version) differences.push({ kind: 'version', packageName: item.packageName, detail: `${old.version} → ${item.version}` })
        if (old.enabled !== item.enabled) differences.push({ kind: 'enabled', packageName: item.packageName, detail: item.enabled ? '启用' : '停用' })
        const oldOrder = previousPlugins.indexOf(old)
        if (oldOrder !== item.order) differences.push({ kind: 'order', packageName: item.packageName, detail: `${oldOrder + 1} → ${item.order + 1}` })
      }
    }
    for (const old of previousPlugins) if (!incoming.has(old.packageName)) differences.push({ kind: 'removed', packageName: old.packageName, detail: '已从清单移除' })
    const previousCommit = existing.source?.kind === 'github' ? existing.source.commit : undefined
    if (previousCommit && preview.commit && previousCommit !== preview.commit) differences.push({ kind: 'commit', packageName: '(仓库)', detail: `${previousCommit.slice(0, 8)} → ${preview.commit.slice(0, 8)}` })
    return { ...preview, dshVersionInstalled, differences }
  })
  ipcMain.handle(IPC.profilesRepositoryImport, async (_event, payload: { url: string; mode: ProfileRepositoryImportMode; name?: string; overwrite?: boolean; resolutions?: Record<string, PackPluginEntry> }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.url !== 'string' || (payload.mode !== 'source' && payload.mode !== 'full')) {
      throw new Error('Profile 仓库导入参数无效。')
    }
    if (runtime.isRunning()) throw new Error('请先停止 DSH，再导入 Profile。')
    const loaded = await loadProfileRepositoryManifest(githubAuth, payload.url)
    const environment = await runtimeVersions.read(false)
    if (!environment.dshInstalled.some(item => item.version === loaded.manifest.dshVersion)) {
      // Install the exact version before creating the Profile. If this fails,
      // packManager has not created or switched any Profile yet.
      await runtimeVersions.installDsh(loaded.manifest.dshVersion!)
    }
    const receipts = await readPluginReceipts(pluginReceiptsPath)
    const manifest = applySelectedMatches(applyReceiptMatches(loaded.manifest, receipts), payload.resolutions, receipts)
    const dshHome = (await settings.read()).dshHome
    const localPluginBodies = await resolveLocalPluginBodies(dshHome, manifest.plugins.map(entry => entry.packageName), receipts)
    const unresolved = manifest.plugins.filter(entry => ((entry.source === 'npm' && !entry.version) || (entry.source !== 'npm' && (!entry.repository || !entry.commit))) && !localPluginBodies[entry.packageName])
    if (payload.mode === 'source' && unresolved.length > 0) {
      throw new Error(`来源安装无法匹配插件来源：${unresolved.map(entry => entry.packageName).join('、')}`)
    }

    const temporaryRoot = await mkdtemp(path.join(path.dirname(pluginReceiptsPath), 'profile-repository-import-'))
    try {
      let importPath: string
      if (payload.mode === 'full') {
        const zip = await readProfileRepositoryArchive(githubAuth, loaded.repository, loaded.branch)
        importPath = path.join(temporaryRoot, 'profile.zip')
        await writeFile(importPath, zip)
        await validateFullArchive(importPath, manifest)
      } else {
        importPath = path.join(temporaryRoot, loaded.file.path)
        await writeFile(importPath, manifestText(manifest), 'utf8')
      }
      const result = await packManager.importPack(importPath, undefined, {
        ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
        ...(payload.overwrite === true ? { overwrite: true } : {}),
        mode: payload.mode,
        ...(payload.mode === 'source' ? { localPluginBodies } : {}),
      })
      const current = await settings.read()
      await writeProfileMetadata(current.dshHome, result.id, {
        source: { kind: 'github', repository: loaded.repository, branch: loaded.branch, ...(loaded.commit ? { commit: loaded.commit } : {}) },
      })
      return profiles.metadata(result.id)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  ipcMain.handle(IPC.profilesMatchPlugin, async (_event, packageName: string) => {
    if (typeof packageName !== 'string' || !isSafePackageName(packageName)) throw new Error('插件名称无效。')
    const current = await settings.read()
    const state = await readProfile(current.dshHome, current.profileName, pluginReceiptsPath)
    const plugin = state.plugins.find(item => item.packageName === packageName)
    if (!plugin) return null
    const receipt = (await readPluginReceipts(pluginReceiptsPath)).find(item => item.profileName === current.profileName && item.packageName === packageName)
    const source = receipt?.source === 'npm' ? 'npm' : receipt?.source === 'github' || plugin.repositoryFullName ? 'github' : 'local'
    const targetId = receipt?.targetId ?? `${packageName}:.`
    return {
      packageName,
      ...(plugin.repositoryFullName ? { repository: plugin.repositoryFullName } : {}),
      source,
      ...(receipt?.defaultBranch ? { defaultBranch: receipt.defaultBranch } : {}),
      ...(receipt?.targetId ? { targetId } : source === 'npm' ? { targetId } : {}),
      ...(receipt?.subdirectory ? { subdirectory: receipt.subdirectory } : {}),
      ...(receipt?.commit ? { commit: receipt.commit } : {}),
      ...(plugin.version && plugin.version !== '未知版本' && plugin.version !== '随 DSH 提供' ? { version: plugin.version } : {}),
      enabled: plugin.enabled,
    }
  })
  ipcMain.handle(IPC.profileToggle, async (_event, payload: { packageName: string; enabled: boolean; profileName?: string }) => {
    assertProfileMutationAvailable()
    if (!isSafePackageName(payload.packageName)) throw new Error('插件名称无效。')
    if (payload.profileName !== undefined && !isSafeProfileName(payload.profileName)) throw new Error('Profile 名称无效。')
    return linkedComponents.togglePlugin(payload.packageName, Boolean(payload.enabled), payload.profileName)
  })
  ipcMain.handle(IPC.profileReorder, async (_event, packageNames: string[]) => {
    assertProfileMutationAvailable()
    if (!Array.isArray(packageNames) || packageNames.some(name => !isSafePackageName(name))) {
      throw new Error('插件顺序无效。')
    }
    const current = await settings.read()
    return reorderPlugins(current.dshHome, current.profileName, packageNames, pluginReceiptsPath)
  })

  ipcMain.handle(IPC.catalogDiscover, async (_event, payload: { query: string; sort: DiscoverySort; page: number }) => {
    const sort: DiscoverySort = payload.sort === 'updated' ? 'updated' : 'stars'
    const page = Math.max(1, Math.floor(Number(payload.page) || 1))
    const [found, dshInstallation, installedRepositories, installedSkills, installedApplications, installedPresets] = await Promise.all([
      searchCatalogRepositories(payload.query ?? '', sort, page, githubAuth.fetch),
      installer.detectDsh(),
      installer.listInstalledRepositories(),
      installer.readInstalledSkills(),
      applicationAddons.list(),
      installer.readInstalledPresets(),
    ])
    return {
      ...found,
      dshInstallation,
      installedRepositories,
      installedSkills,
      installedApplications,
      installedPresets,
    }
  })
  ipcMain.handle(IPC.catalogRefreshIndex, () => catalogSync.refreshIndex())
  ipcMain.handle(IPC.catalogAnalyze, async (event, payload: { fullName: string; defaultBranch: string; repositoryUpdatedAt?: string }) => {
    if (!isSafeRepositoryName(payload.fullName)) throw new Error('GitHub 仓库名称无效。')
    if (payload.repositoryUpdatedAt !== undefined && !Number.isFinite(Date.parse(payload.repositoryUpdatedAt))) {
      throw new Error('GitHub 仓库更新时间无效。')
    }
    return catalogSync.resolve(
      payload.fullName,
      payload.defaultBranch,
      payload.repositoryUpdatedAt,
      componentKinds => installer.analyzeCatalogRepository(payload.fullName, payload.defaultBranch, progress => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC_EVENTS.catalogAnalysisProgress, progress)
      }, { bypassCache: true, componentKinds }),
      message => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC_EVENTS.catalogAnalysisProgress, {
          repository: payload.fullName,
          phase: 'preparing',
          message,
          completed: 0,
          total: 3,
          checks: { plugin: 'pending', skill: 'pending', application: 'pending' },
        })
      },
    )
  })
  // 从 GitHub 链接导入：解析 → 取元数据 → 复用现有分析（只读，无需整合包互斥）。
  ipcMain.handle(IPC.catalogImportUrl, async (event, payload: { url: string }) => {
    if (!payload || typeof payload.url !== 'string' || payload.url.trim().length === 0) {
      throw new Error('请输入 GitHub 仓库链接。')
    }
    if (payload.url.length > 1000) throw new Error('GitHub 仓库链接过长。')
    return importCatalogFromUrl(
      payload.url,
      (fullName, branch, repositoryUpdatedAt) => catalogSync.resolve(
        fullName,
        branch,
        repositoryUpdatedAt,
        componentKinds => installer.analyzeCatalogRepository(fullName, branch, progress => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC_EVENTS.catalogAnalysisProgress, progress)
        }, { bypassCache: true, componentKinds }),
        message => {
          if (!event.sender.isDestroyed()) event.sender.send(IPC_EVENTS.catalogAnalysisProgress, {
            repository: fullName,
            phase: 'preparing',
            message,
            completed: 0,
            total: 3,
            checks: { plugin: 'pending', skill: 'pending', application: 'pending' },
          })
        },
      ),
      githubAuth.fetch,
    )
  })
  ipcMain.handle(IPC.dshMarketLoad, () => dshMarket.load())
  ipcMain.handle(IPC.dshMarketInstall, async (_event, name: string) => {
    assertProfileMutationAvailable()
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) throw new Error('dsh-market 插件名称无效。')
    return dshMarket.install(name)
  })
  ipcMain.handle(IPC.dshMarketUpdate, async (_event, name: string) => {
    assertProfileMutationAvailable()
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) throw new Error('dsh-market 插件名称无效。')
    return dshMarket.update(name)
  })
  ipcMain.handle(IPC.dshMarketUninstall, async (_event, name: string) => {
    assertProfileMutationAvailable()
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) throw new Error('dsh-market 插件名称无效。')
    return dshMarket.uninstall(name)
  })
  ipcMain.handle(IPC.dshMarketToggle, async (_event, payload: { name: string; enabled: boolean }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.name !== 'string' || payload.name.length === 0 || payload.name.length > 200) throw new Error('dsh-market 插件名称无效。')
    return dshMarket.toggle(payload.name, Boolean(payload.enabled))
  })
  ipcMain.handle(IPC.dshMarketUpdates, (_event, force?: boolean) => dshMarket.updates(Boolean(force)))

  ipcMain.handle(IPC.pluginsInstall, async (_event, request: string | PluginInstallRequest) => {
    assertProfileMutationAvailable()
    const fullName = typeof request === 'string' ? request : request.repository
    if (!isSafeRepositoryName(fullName)) throw new Error('GitHub 仓库名称无效。')
    if (typeof request === 'string') return installer.install(fullName)
    return installer.installPluginTarget({
      repository: request.repository,
      defaultBranch: request.defaultBranch,
      targetId: request.targetId,
      // release 源插件：meta-repo 分析得到的 tgz 直链，覆盖重分析得到的 github 源。
      tarballUrl: typeof request.tarballUrl === 'string' ? request.tarballUrl : undefined,
    })
  })
  ipcMain.handle(IPC.pluginsUninstall, async (_event, payload: string | { packageName: string; profileName?: string }) => {
    assertProfileMutationAvailable()
    const packageName = typeof payload === 'string' ? payload : payload?.packageName
    if (!isSafePackageName(packageName)) throw new Error('插件名称无效。')
    const profileName = typeof payload === 'object' ? payload.profileName : undefined
    if (profileName !== undefined && !isSafeProfileName(profileName)) throw new Error('Profile 名称无效。')
    return installer.remove(packageName, profileName)
  })
  ipcMain.handle(IPC.pluginsTrialRead, () => pluginTrial.list())
  ipcMain.handle(IPC.pluginsTrial, async (_event, payload: { packageName: string; profileName?: string }) => {
    assertProfileMutationAvailable()
    if (!payload || !isSafePackageName(payload.packageName)) throw new Error('插件名称无效。')
    if (payload.profileName !== undefined && !isSafeProfileName(payload.profileName)) throw new Error('Profile 名称无效。')
    return pluginTrial.trial(payload.packageName, payload.profileName)
  })

  ipcMain.handle(IPC.skillsInstall, async (_event, request: SkillInstallRequest) => {
    assertProfileMutationAvailable()
    if (!isSafeRepositoryName(request.repository)) throw new Error('GitHub 仓库名称无效。')
    return installer.installSkill(request)
  })
  ipcMain.handle(IPC.skillsReadInstalled, () => installer.readInstalledSkills())
  ipcMain.handle(IPC.skillsToggle, async (_event, payload: { name: string; enabled: boolean }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.name)) {
      throw new Error('Skill 名称无效。')
    }
    return installer.toggleSkill(payload.name, Boolean(payload.enabled))
  })

  ipcMain.handle(IPC.applicationsReadInstalled, () => applicationAddons.list())
  ipcMain.handle(IPC.applicationsInstall, async (_event, request: ApplicationInstallRequest) => {
    assertProfileMutationAvailable()
    if (!request || !isSafeRepositoryName(request.repository)) throw new Error('GitHub 仓库名称无效。')
    if (typeof request.defaultBranch !== 'string' || typeof request.targetId !== 'string') throw new Error('应用加载项请求无效。')

    const installed = await applicationAddons.install(request)
    const current = await settings.read()
    const profile = await readProfile(current.dshHome, current.profileName, pluginReceiptsPath)
    return { ...installed, profile }
  })
  ipcMain.handle(IPC.applicationsToggle, async (_event, payload: { id: string; enabled: boolean }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.id !== 'string') throw new Error('应用加载项标识无效。')
    return linkedComponents.toggleApplication(payload.id, Boolean(payload.enabled))
  })
  ipcMain.handle(IPC.applicationsUninstall, async (_event, id: string) => {
    assertProfileMutationAvailable()
    if (typeof id !== 'string') throw new Error('应用加载项标识无效。')
    return applicationAddons.uninstall(id)
  })

  ipcMain.handle(IPC.presetsInstall, async (_event, request: PresetInstallRequest) => {
    assertProfileMutationAvailable()
    if (!request || typeof request !== 'object') throw new Error('请求格式无效。')
    if (!isSafeRepositoryName(request.repository)) throw new Error('GitHub 仓库名称无效。')
    if (typeof request.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.name)) {
      throw new Error('预设名称无效。')
    }
    return installer.installPreset(request)
  })
  ipcMain.handle(IPC.presetsReadInstalled, () => installer.readInstalledPresets())
  ipcMain.handle(IPC.presetsToggle, async (_event, payload: { name: string; enabled: boolean }) => {
    assertProfileMutationAvailable()
    if (!payload || typeof payload.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.name)) {
      throw new Error('预设名称无效。')
    }
    return installer.togglePreset(payload.name, Boolean(payload.enabled))
  })

  ipcMain.handle(IPC.aiStatus, () => aiInstaller.status())
  ipcMain.handle(IPC.aiHasSnapshot, () => aiInstaller.hasSnapshot())
  ipcMain.handle(IPC.aiInstall, async (_event, input: { repository: string; defaultBranch: string }) => {
    if (!input || !isSafeRepositoryName(input.repository)) throw new Error('GitHub 仓库名称无效。')
    if (typeof input.defaultBranch !== 'string' || input.defaultBranch.length === 0 || input.defaultBranch.length > 200) {
      throw new Error('分支无效。')
    }
    // 主进程内 aiInstaller.start 会重算 analysis，不信任渲染层传入的分类。
    const session = await copilot.beginLegacy('repository-install', 'AI 尝试安装', input.repository)
    copilot.bindLegacy(session.id)
    try {
      return await copilot.runLegacy(session.id, () => aiInstaller.start({ repository: input.repository, defaultBranch: input.defaultBranch }))
    } finally {
      copilot.bindLegacy(null)
    }
  })
  ipcMain.handle(IPC.aiAdaptPlugin, async (_event, input: { packageName: string; profileName?: string }) => {
    if (!input || !isSafePackageName(input.packageName)) throw new Error('插件名称无效。')
    if (input.profileName !== undefined && !isSafeProfileName(input.profileName)) throw new Error('Profile 名称无效。')
    const failure = await pluginTrial.latestFailure(input.packageName, input.profileName)
    const session = await copilot.beginLegacy('plugin-adaptation', 'DSH 安装适配', failure.packageName)
    copilot.bindLegacy(session.id)
    try {
      return await copilot.runLegacy(session.id, () => aiInstaller.adaptPlugin({
        packageName: failure.packageName,
        profileName: failure.profileName,
        diagnostics: failure.diagnostics,
      }))
    } finally {
      copilot.bindLegacy(null)
    }
  })
  ipcMain.handle(IPC.aiRepairRuntime, async () => {
    const failure = runtime.failure()
    if (!failure) throw new Error('没有找到最近一次 DSH 启动失败诊断。')
    const session = await copilot.beginLegacy('runtime-repair', 'DSH 启动修复', failure.profileName)
    copilot.bindLegacy(session.id)
    try {
      return await copilot.runLegacy(session.id, () => aiInstaller.repairRuntime(failure))
    } finally {
      copilot.bindLegacy(null)
    }
  })
  ipcMain.handle(IPC.aiApprove, async (_event, requestId: string, allow: boolean) => {
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('审批请求无效。')
    const result = await aiInstaller.approve(requestId, Boolean(allow))
    if (result) await copilot.clearLegacyApproval(requestId)
    return result
  })
  ipcMain.handle(IPC.aiCancel, () => aiInstaller.cancel())
  ipcMain.handle(IPC.aiRollback, () => aiInstaller.rollback())

  ipcMain.handle(IPC.aiSessionsList, () => copilot.list())
  ipcMain.handle(IPC.aiSessionsCreate, (_event, input?: AiSessionCreateInput) => copilot.create(input))
  ipcMain.handle(IPC.aiSessionsSend, (_event, payload: { sessionId: string; text: string }) => {
    if (!payload || typeof payload.sessionId !== 'string' || typeof payload.text !== 'string') throw new Error('Copilot 消息格式无效。')
    return copilot.send(payload.sessionId, payload.text)
  })
  ipcMain.handle(IPC.aiSessionsCancel, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('Copilot 会话无效。')
    return copilot.cancel(sessionId)
  })
  ipcMain.handle(IPC.aiSessionsApprove, (_event, payload: { sessionId: string; requestId: string; allow: boolean }) => {
    if (!payload || typeof payload.sessionId !== 'string' || typeof payload.requestId !== 'string') throw new Error('Copilot 审批请求无效。')
    return copilot.approve(payload.sessionId, payload.requestId, Boolean(payload.allow))
  })
  ipcMain.handle(IPC.aiSessionsRollback, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('Copilot 会话无效。')
    return copilot.rollback(sessionId)
  })
  ipcMain.handle(IPC.aiSessionsDelete, (_event, sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('Copilot 会话无效。')
    return copilot.remove(sessionId)
  })

  /**
   * 校验文件存在、为绝对路径，且文件体积不超过整合包上限（未读入前的第一道闸门）。
   * 门禁放宽到 raw 扫描上限（4 GiB）：真实整合包远超标准包 64MB 限制；
   * 标准包内部仍由 inspectPackZip 的严格限额保证。
   */
  async function assertPackFilePath(target: unknown): Promise<void> {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('路径无效。')
    let stats
    try {
      stats = await stat(target)
    } catch {
      throw new Error('文件不存在。')
    }
    if (!stats.isFile()) throw new Error('不是文件。')
    if (stats.size > MAX_RAW_ARCHIVE_BYTES) throw new Error('整合包压缩包过大。')
  }

  ipcMain.handle(IPC.packsList, () => packManager.listPacks())

  ipcMain.handle(IPC.packsCreate, async (_event, request: PackCreateRequest) => {
    if (!request || typeof request !== 'object') throw new Error('请求格式无效。')
    if (typeof request.name !== 'string') throw new Error('整合包名称无效。')
    assertMeaningfulPackName(request.name) // 空名/纯中文等退化成无意义标识的名称会抛出中文错误
    if (request.description !== undefined && typeof request.description !== 'string') throw new Error('整合包描述无效。')
    if (!Array.isArray(request.packageNames) || request.packageNames.some(name => !isSafePackageName(name))) {
      throw new Error('插件列表无效。')
    }
    if (request.presetNames !== undefined && (
      !Array.isArray(request.presetNames) || request.presetNames.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    )) {
      throw new Error('预设列表无效。')
    }
    if (request.skillNames !== undefined && (
      !Array.isArray(request.skillNames) || request.skillNames.some(name => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    )) {
      throw new Error('Skill 列表无效。')
    }
    if (request.applicationIds !== undefined && (
      !Array.isArray(request.applicationIds) || request.applicationIds.some(id => !/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(id))
    )) {
      throw new Error('应用加载项列表无效。')
    }
    return packManager.createPack(request)
  })

  ipcMain.handle(IPC.packsAnalyzeImport, async (_event, target: string) => {
    await assertPackFilePath(target)
    return packManager.analyzeImport(target)
  })

  ipcMain.handle(IPC.packsImport, async (_event, target: string, items?: string[], name?: unknown) => {
    await assertPackFilePath(target)
    if (items !== undefined && (!Array.isArray(items) || items.some(item => !isSafePackageName(item)))) {
      throw new Error('插件列表无效。')
    }
    let nameOverride: string | undefined
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('整合包名称无效。')
      assertMeaningfulPackName(name) // 空名/纯中文等退化成无意义标识的名称会抛出中文错误
      nameOverride = name.trim()
    }
    return packManager.importPack(target, items, nameOverride === undefined ? undefined : { name: nameOverride })
  })

  ipcMain.handle(IPC.packsExport, async (_event, packId: string) => {
    if (!isSafeProfileName(packId)) throw new Error('整合包标识无效。')
    const { zipPath, fileName } = await packManager.exportPack(packId)
    const window = deps.getWindow()
    if (!window) {
      await rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined)
      return null
    }
    try {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: fileName,
        filters: [{ name: '整合包', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return null
      await copyFile(zipPath, result.filePath)
      return result.filePath
    } finally {
      await rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined)
    }
  })

  ipcMain.handle(IPC.packsPickFile, async () => {
    const window = deps.getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: '整合包', extensions: ['zip', 'yaml', 'yml'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.packsActivate, async (_event, packId: string) => {
    assertProfileMutationAvailable()
    if (!isSafeProfileName(packId)) throw new Error('整合包标识无效。')
    return packManager.activatePack(packId)
  })

  ipcMain.handle(IPC.packsDeactivate, () => {
    assertProfileMutationAvailable()
    return packManager.deactivatePack()
  })

  ipcMain.handle(IPC.packsRemove, async (_event, packId: string) => {
    assertProfileMutationAvailable()
    if (!isSafeProfileName(packId)) throw new Error('整合包标识无效。')
    return packManager.removePack(packId)
  })

  ipcMain.handle(IPC.packsRollback, () => packManager.rollback())

  ipcMain.handle(IPC.packsHasSnapshot, () => packManager.hasSnapshot())

  ipcMain.handle(IPC.packsAddPlugin, async (_event, payload: { packId: string; packageName: string }) => {
    if (!isSafeProfileName(payload.packId) || !isSafePackageName(payload.packageName)) throw new Error('参数无效。')
    return packManager.addPackPlugin(payload.packId, payload.packageName)
  })

  ipcMain.handle(IPC.packsAddPreset, async (_event, payload: { packId: string; presetName: string }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.presetName)) throw new Error('参数无效。')
    return packManager.addPackPreset(payload.packId, payload.presetName)
  })

  ipcMain.handle(IPC.packsTogglePreset, async (_event, payload: { packId: string; presetName: string; enabled: boolean }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.presetName)) throw new Error('参数无效。')
    return packManager.togglePackPreset(payload.packId, payload.presetName, Boolean(payload.enabled))
  })

  ipcMain.handle(IPC.packsRemovePreset, async (_event, payload: { packId: string; presetName: string }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.presetName)) throw new Error('参数无效。')
    return packManager.removePackPreset(payload.packId, payload.presetName)
  })

  ipcMain.handle(IPC.packsAddSkill, async (_event, payload: { packId: string; skillName: string }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.skillName)) throw new Error('参数无效。')
    return packManager.addPackSkill(payload.packId, payload.skillName)
  })

  ipcMain.handle(IPC.packsToggleSkill, async (_event, payload: { packId: string; skillName: string; enabled: boolean }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.skillName)) throw new Error('参数无效。')
    return packManager.togglePackSkill(payload.packId, payload.skillName, Boolean(payload.enabled))
  })

  ipcMain.handle(IPC.packsRemoveSkill, async (_event, payload: { packId: string; skillName: string }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.skillName)) throw new Error('参数无效。')
    return packManager.removePackSkill(payload.packId, payload.skillName)
  })

  ipcMain.handle(IPC.packsAddApplication, async (_event, payload: { packId: string; addonId: string }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(payload.addonId)) throw new Error('参数无效。')
    return packManager.addPackApplication(payload.packId, payload.addonId)
  })

  ipcMain.handle(IPC.packsToggleApplication, async (_event, payload: { packId: string; addonId: string; enabled: boolean }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(payload.addonId)) throw new Error('参数无效。')
    return packManager.togglePackApplication(payload.packId, payload.addonId, Boolean(payload.enabled))
  })

  ipcMain.handle(IPC.packsRemoveApplication, async (_event, payload: { packId: string; addonId: string }) => {
    if (!isSafeProfileName(payload.packId) || !/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(payload.addonId)) throw new Error('参数无效。')
    return packManager.removePackApplication(payload.packId, payload.addonId)
  })

  ipcMain.handle(IPC.packsToggleItem, async (_event, payload: { packId: string; packageName: string; enabled: boolean }) => {
    if (!isSafeProfileName(payload.packId) || !isSafePackageName(payload.packageName)) throw new Error('参数无效。')
    return packManager.togglePackItem(payload.packId, payload.packageName, Boolean(payload.enabled))
  })

  ipcMain.handle(IPC.packsRemoveItem, async (_event, payload: { packId: string; packageName: string }) => {
    if (!isSafeProfileName(payload.packId) || !isSafePackageName(payload.packageName)) throw new Error('参数无效。')
    return packManager.removePackItem(payload.packId, payload.packageName)
  })

  ipcMain.handle(IPC.runtimeState, () => runtime.state())
  ipcMain.handle(IPC.runtimeStart, async () => {
    assertProfileMutationAvailable()
    // 先启动 DSH，避免网络或 GitHub PR 操作阻塞用户进入本地运行环境。
    const state = await runtime.start()
    // 共享索引提交只作为后台任务执行；失败不会影响本次 DSH 启动。
    void catalogSync.flushPending().catch(() => undefined)
    return state
  })
  ipcMain.handle(IPC.runtimeStop, () => runtime.stop())

  ipcMain.handle(IPC.windowSetMode, (_event, mode: WindowMode) => {
    if (!isWindowMode(mode)) throw new Error('窗口模式无效。')
    deps.setWindowMode(mode)
  })
  ipcMain.handle(IPC.windowMinimize, () => deps.getWindow()?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, () => {
    const window = deps.getWindow()
    if (!window || window.isDestroyed()) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  ipcMain.handle(IPC.windowClose, () => deps.getWindow()?.close())

  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只允许打开网页链接。')
    return shell.openExternal(parsed.toString())
  })
  ipcMain.handle(IPC.openPath, async (_event, target: string) => {
    if (!path.isAbsolute(target)) throw new Error('路径无效。')
    await shell.openPath(target)
  })
}
