import path from 'node:path'
import os from 'node:os'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adoptDetectedDsh,
  createSettingsStore,
  defaultSettings,
  mergeStoredSettings,
  usesOnDemandDsh,
  validateSettings,
} from '../electron/settings'
import { readProfileMetadata, writeProfileMetadata } from '../electron/profile-service'
import { managedDshExecutable } from '../electron/dsh-install'
import type { AppSettings } from '../src/types'

const baseSettings: AppSettings = {
  dshInstallPath: '/home/tester/.dsh-runtime',
  dshHome: '/home/tester/.dsh',
  profileName: 'web',
  workspace: '/home/tester/Documents',
  launchExecutable: 'npx',
  launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
  webPort: 3080,
  openAfterLaunch: true,
}

const settingsRoots: string[] = []
afterEach(async () => { await Promise.all(settingsRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function settingsFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-settings-profile-'))
  settingsRoots.push(root)
  const defaults = defaultSettings({ homeDirectory: root, documentsDirectory: root })
  const initial: AppSettings = { ...defaults, dshVersion: '0.1.0', launchExecutable: path.join(root, 'runtime', 'dsh'), launchArgs: ['web'] }
  const filePath = path.join(root, 'settings.json')
  await writeFile(filePath, JSON.stringify(initial), 'utf8')
  const store = createSettingsStore({
    filePath, createDefaults: () => defaults,
    detectInstalledDsh: async () => ({ installed: false, executable: null, version: null, source: null }),
  })
  return { root, initial, filePath, store }
}

describe('Profile runtime version authority', () => {
  it('prefers the selected Profile version over stale launcher settings on initial read', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    expect((await env.store.read()).dshVersion).toBe('0.2.0')
    expect((await env.store.read()).launchExecutable).toBe(managedDshExecutable(path.join(env.initial.dshInstallPath, 'versions', '0.2.0')))
    expect(JSON.parse(await readFile(env.filePath, 'utf8')).dshVersion).toBe('0.1.0')
  })

  it('does not create Profile directories or metadata during settings reads', async () => {
    const env = await settingsFixture()
    expect((await env.store.read()).dshVersion).toBe('0.1.0')
    await expect(access(path.join(env.initial.dshHome, 'profiles', 'web'))).rejects.toThrow()
    const packageDir = path.join(env.initial.dshHome, 'profiles', 'web')
    await mkdir(packageDir, { recursive: true })
    await writeFile(path.join(packageDir, 'package.json'), '{}')
    const freshStore = createSettingsStore({
      filePath: env.filePath, createDefaults: () => env.initial,
      detectInstalledDsh: async () => ({ installed: false, executable: null, version: null, source: null }),
    })
    await freshStore.read()
    await expect(access(path.join(packageDir, 'profile.yaml'))).rejects.toThrow()
  })

  it('persists explicit same-Profile version changes and keeps source/resource metadata', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', {
      dshVersion: '0.2.0', description: 'keep description', version: '5.0.0',
      source: { kind: 'github', repository: 'author/pack', commit: 'fixed' },
      resources: { skills: [{ name: 'writer', format: 'flat', enabled: true }] },
      exportRepository: { repository: 'user/export' },
    })
    const current = await env.store.read()
    const saved = await env.store.save({ ...current, dshVersion: '0.3.0' })
    expect(saved.dshVersion).toBe('0.3.0')
    expect(await readProfileMetadata(env.initial.dshHome, 'web')).toMatchObject({
      dshVersion: '0.3.0', description: 'keep description', version: '5.0.0',
      source: { kind: 'github', repository: 'author/pack', commit: 'fixed' },
      resources: { skills: [{ name: 'writer', format: 'flat', enabled: true }] },
      exportRepository: { repository: 'user/export' },
    })
    await env.store.save({ ...saved, dshVersion: null })
    expect((await readProfileMetadata(env.initial.dshHome, 'web')).dshVersion).toBeNull()
  })

  it('loads target Profile versions when switching and never overwrites either Profile with the previous selection', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    await writeProfileMetadata(env.initial.dshHome, 'desktop', { dshVersion: '0.3.0' })
    const current = await env.store.read()
    const switched = await env.store.save({ ...current, profileName: 'desktop' })
    expect(switched.dshVersion).toBe('0.3.0')
    expect(switched.launchExecutable).toBe(managedDshExecutable(path.join(env.initial.dshInstallPath, 'versions', '0.3.0')))
    expect((await readProfileMetadata(env.initial.dshHome, 'web')).dshVersion).toBe('0.2.0')
    expect((await readProfileMetadata(env.initial.dshHome, 'desktop')).dshVersion).toBe('0.3.0')
    expect((await env.store.save({ ...switched, profileName: 'web' })).dshVersion).toBe('0.2.0')
  })

  it('honors automatic version selection and absent target metadata on switches', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'desktop', { dshVersion: null })
    const switched = await env.store.save({ ...env.initial, profileName: 'desktop' })
    expect(switched.dshVersion).toBeNull()
    expect((await env.store.save({ ...switched, profileName: 'empty', dshVersion: '0.9.0' })).dshVersion).toBeNull()
    await expect(access(path.join(env.initial.dshHome, 'profiles', 'empty'))).rejects.toThrow()
  })

  it('does not overwrite a newer Profile version during unrelated settings changes', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    const current = await env.store.read()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.4.0' })
    expect((await env.store.save({ ...current, uiTheme: 'berry' })).dshVersion).toBe('0.4.0')
    expect((await readProfileMetadata(env.initial.dshHome, 'web')).dshVersion).toBe('0.4.0')
  })

  it('loads metadata from a changed DSH_HOME instead of copying the previous home version', async () => {
    const env = await settingsFixture()
    const nextHome = path.join(env.root, 'other-home')
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    await writeProfileMetadata(nextHome, 'web', { dshVersion: '0.5.0' })
    const current = await env.store.read()
    expect((await env.store.save({ ...current, dshHome: nextHome })).dshVersion).toBe('0.5.0')
    expect((await readProfileMetadata(env.initial.dshHome, 'web')).dshVersion).toBe('0.2.0')
  })

  it('refreshes cached version and executable after current Profile metadata changes', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    await env.store.read()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: 'v0.6.0' })
    const refreshed = await env.store.read()
    expect(refreshed.dshVersion).toBe('v0.6.0')
    expect(refreshed.launchExecutable).toBe(managedDshExecutable(path.join(env.initial.dshInstallPath, 'versions', '0.6.0')))
    expect(refreshed.launchArgs).toEqual(['web'])
  })

  it('does not inherit the previous pinned executable when switching to an automatic Profile', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    await writeProfileMetadata(env.initial.dshHome, 'desktop', { dshVersion: null })
    const current = await env.store.read()
    const automatic = await env.store.save({ ...current, profileName: 'desktop' })
    expect(automatic.dshVersion).toBeNull()
    expect(usesOnDemandDsh(automatic)).toBe(true)
    expect(automatic.launchExecutable).not.toBe(current.launchExecutable)
    expect((await readProfileMetadata(env.initial.dshHome, 'web')).dshVersion).toBe('0.2.0')
  })

  it('keeps custom launch commands in automatic mode but pins commands for versioned Profiles', async () => {
    const env = await settingsFixture()
    const custom = { ...env.initial, dshVersion: null, launchExecutable: path.join(env.root, 'custom-host'), launchArgs: ['custom-entry.js'] }
    await writeFile(env.filePath, JSON.stringify(custom))
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: null })
    const automatic = await env.store.read()
    expect(automatic.launchExecutable).toBe(custom.launchExecutable)
    expect(automatic.launchArgs).toEqual(custom.launchArgs)
    const pinned = await env.store.save({ ...automatic, dshVersion: '0.7.0' })
    expect(pinned.launchExecutable).toBe(managedDshExecutable(path.join(env.initial.dshInstallPath, 'versions', '0.7.0')))
    expect(pinned.launchArgs).toEqual(['web'])
  })

  it('refreshes cached automatic selection when a Profile clears its pin', async () => {
    const env = await settingsFixture()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: '0.2.0' })
    await env.store.read()
    await writeProfileMetadata(env.initial.dshHome, 'web', { dshVersion: null })
    const automatic = await env.store.read()
    expect(automatic.dshVersion).toBeNull()
    expect(usesOnDemandDsh(automatic)).toBe(true)
  })
})

describe('defaultSettings', () => {
  it('prefers DSH_HOME from the environment', () => {
    const settings = defaultSettings({
      dshHomeFromEnvironment: '/custom/dsh',
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      platform: 'linux',
    })
    expect(settings.dshHome).toBe('/custom/dsh')
  })

  it('falls back to a .dsh directory under home', () => {
    const settings = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      platform: 'linux',
    })
    expect(settings.dshHome).toBe('/home/tester/.dsh')
    expect(settings.launchExecutable).toBe('npx')
    expect(settings.webPort).toBe(3080)
    expect(settings.uiTheme).toBe('forest')
    expect(settings.aiDeveloperMode).toBe(false)
    expect(settings.aiPrompt).toBe('')
  })

  it('uses the detected system npx when available', () => {
    const settings = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      systemNpx: 'C:\\Program Files\\nodejs\\npx.cmd',
      platform: 'win32',
    })
    expect(settings.launchExecutable).toBe('C:\\Program Files\\nodejs\\npx.cmd')
  })

  it('uses the platform default executable name without a detected runtime', () => {
    expect(defaultSettings({
      homeDirectory: 'C:\\Users\\tester',
      documentsDirectory: 'C:\\Users\\tester\\Documents',
      platform: 'win32',
    }).launchExecutable).toBe('npx.cmd')
  })
})

describe('validateSettings', () => {
  it('trims the executable and keeps the remaining fields', () => {
    const validated = validateSettings({ ...baseSettings, launchExecutable: '  npx  ' })
    expect(validated.launchExecutable).toBe('npx')
    expect(validated.launchArgs).toEqual(baseSettings.launchArgs)
  })

  it('rejects a profile name with path separators', () => {
    expect(() => validateSettings({ ...baseSettings, profileName: '../escape' })).toThrow(/配置名称/)
  })

  it('rejects relative directories', () => {
    expect(() => validateSettings({ ...baseSettings, dshHome: 'relative/path' })).toThrow(/完整路径/)
    expect(() => validateSettings({ ...baseSettings, workspace: './work' })).toThrow(/完整路径/)
    expect(() => validateSettings({ ...baseSettings, dshInstallPath: 'relative/runtime' })).toThrow(/完整路径/)
  })

  it('rejects an install path at the disk root', () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    expect(() => validateSettings({ ...baseSettings, dshInstallPath: root })).toThrow(/磁盘根目录/)
  })

  it('rejects an install path that collides with DSH_HOME', () => {
    expect(() => validateSettings({ ...baseSettings, dshInstallPath: baseSettings.dshHome })).toThrow(/不能与 DSH_HOME 相同/)
  })

  it('rejects an empty launch command', () => {
    expect(() => validateSettings({ ...baseSettings, launchExecutable: '   ' })).toThrow(/启动命令/)
  })

  it('rejects launch arguments that are not all strings', () => {
    expect(() => validateSettings({ ...baseSettings, launchArgs: ['web', 42 as unknown as string] })).toThrow(/启动参数/)
  })

  it('rejects an invalid Web port', () => {
    expect(() => validateSettings({ ...baseSettings, webPort: 0 })).toThrow(/Web 端口/)
    expect(() => validateSettings({ ...baseSettings, webPort: 65536 })).toThrow(/Web 端口/)
    expect(() => validateSettings({ ...baseSettings, webPort: 3080.5 })).toThrow(/Web 端口/)
  })

  it('coerces openAfterLaunch to a boolean', () => {
    expect(validateSettings({ ...baseSettings, openAfterLaunch: 1 as unknown as boolean }).openAfterLaunch).toBe(true)
  })

  it('normalizes Copilot developer settings and limits prompt size', () => {
    const validated = validateSettings({ ...baseSettings, aiDeveloperMode: true, aiPrompt: 'x'.repeat(25_000) })
    expect(validated.aiDeveloperMode).toBe(true)
    expect(validated.aiPrompt).toHaveLength(20_000)
  })

  it('accepts known UI themes and falls back for invalid values', () => {
    expect(validateSettings({ ...baseSettings, uiTheme: 'ocean' }).uiTheme).toBe('ocean')
    expect(validateSettings({ ...baseSettings, uiTheme: 'neon' as never }).uiTheme).toBe('forest')
  })
})

describe('mergeStoredSettings', () => {
  it('recovers an accidentally selected dependency directory without resetting other settings', () => {
    const merged = mergeStoredSettings(baseSettings, { profileName: 'node_modules', webPort: 3090, uiTheme: 'berry' })
    expect(merged.profileName).toBe('web')
    expect(merged.webPort).toBe(3090)
    expect(merged.uiTheme).toBe('berry')
    expect(() => validateSettings({ ...baseSettings, profileName: 'node_modules' })).toThrow(/node_modules/)
  })
  it('returns the defaults when nothing is stored', () => {
    expect(mergeStoredSettings(baseSettings, null)).toEqual(baseSettings)
  })

  it('lets stored values win over the defaults', () => {
    const merged = mergeStoredSettings(baseSettings, { profileName: 'headless' })
    expect(merged.profileName).toBe('headless')
    expect(merged.dshHome).toBe(baseSettings.dshHome)
  })

  it('drops non-string launch arguments instead of failing', () => {
    const merged = mergeStoredSettings(baseSettings, {
      launchArgs: ['web', 7 as unknown as string, 'extra'],
    })
    expect(merged.launchArgs).toEqual(['web', 'extra'])
  })

  it('falls back to the default arguments when the stored value is not an array', () => {
    const merged = mergeStoredSettings(baseSettings, { launchArgs: 'web' as unknown as string[] })
    expect(merged.launchArgs).toEqual(baseSettings.launchArgs)
  })

  it('migrates a legacy --port launch argument into the Web port setting', () => {
    const merged = mergeStoredSettings(baseSettings, {
      launchArgs: ['--yes', '@deepseek-ai/dsh', 'web', '--port', '4090'],
    })
    expect(merged.webPort).toBe(4090)
  })

  it('adds safe Copilot defaults to legacy settings', () => {
    const merged = mergeStoredSettings(baseSettings, { profileName: 'web' })
    expect(merged.aiDeveloperMode).toBe(false)
    expect(merged.aiPrompt).toBe('')
    expect(merged.uiTheme).toBe('forest')
  })

  it('keeps a supported stored theme and discards an unknown one', () => {
    expect(mergeStoredSettings(baseSettings, { uiTheme: 'berry' }).uiTheme).toBe('berry')
    expect(mergeStoredSettings(baseSettings, { uiTheme: 'neon' as never }).uiTheme).toBe('forest')
  })

  it('migrates legacy settings with automatic runtime version selection', () => {
    const defaults = defaultSettings({
      homeDirectory: '/home/tester',
      documentsDirectory: '/home/tester/Documents',
      platform: 'linux',
    })
    const merged = mergeStoredSettings(defaults, { profileName: 'web' })
    expect(merged.dshVersion).toBeNull()
    expect(merged.nodeVersion).toBeNull()
  })

  it('keeps valid explicitly selected runtime versions', () => {
    const merged = mergeStoredSettings(baseSettings, { dshVersion: 'v0.1.0-rc.7', nodeVersion: '22.19.0' })
    expect(merged.dshVersion).toBe('v0.1.0-rc.7')
    expect(merged.nodeVersion).toBe('22.19.0')
  })
})

describe('usesOnDemandDsh', () => {
  it('recognizes an npx-based launch configuration', () => {
    expect(usesOnDemandDsh(baseSettings)).toBe(true)
    expect(usesOnDemandDsh({
      ...baseSettings,
      launchExecutable: path.join('C:', 'nodejs', 'npx.cmd'),
    })).toBe(true)
  })

  it('does not match a configuration bound to a local dsh executable', () => {
    expect(usesOnDemandDsh({
      ...baseSettings,
      launchExecutable: '/opt/dsh/node_modules/.bin/dsh',
      launchArgs: ['web'],
    })).toBe(false)
  })

  it('does not match npx invoked for some other package', () => {
    expect(usesOnDemandDsh({ ...baseSettings, launchArgs: ['--yes', 'other-package'] })).toBe(false)
  })
})

describe('adoptDetectedDsh', () => {
  const detected = { installed: true, version: '1.2.3', executable: '/opt/dsh/dsh', source: 'system' as const }

  it('switches an on-demand configuration to the detected executable', () => {
    const next = adoptDetectedDsh(baseSettings, detected)
    expect(next.launchExecutable).toBe('/opt/dsh/dsh')
    expect(next.launchArgs).toEqual(['web'])
  })

  it('leaves an already bound configuration untouched', () => {
    const bound = { ...baseSettings, launchExecutable: '/existing/dsh', launchArgs: ['web'] }
    expect(adoptDetectedDsh(bound, detected)).toBe(bound)
  })

  it('leaves the configuration untouched when nothing was detected', () => {
    expect(adoptDetectedDsh(baseSettings, {
      installed: false,
      version: null,
      executable: null,
      source: null,
    })).toBe(baseSettings)
  })
})

describe('skillMaxArchiveMb', () => {
  it('defaults to 64 when missing or out of range', () => {
    expect(validateSettings(baseSettings).skillMaxArchiveMb).toBe(64)
    expect(validateSettings({ ...baseSettings, skillMaxArchiveMb: 8 }).skillMaxArchiveMb).toBe(64)
    expect(validateSettings({ ...baseSettings, skillMaxArchiveMb: 4096 }).skillMaxArchiveMb).toBe(64)
    expect(validateSettings({ ...baseSettings, skillMaxArchiveMb: 100.5 }).skillMaxArchiveMb).toBe(64)
    expect(defaultSettings({ homeDirectory: '/home/tester', documentsDirectory: '/home/tester/Documents', platform: 'linux' }).skillMaxArchiveMb).toBe(64)
  })

  it('keeps valid values through validate and merge', () => {
    expect(validateSettings({ ...baseSettings, skillMaxArchiveMb: 256 }).skillMaxArchiveMb).toBe(256)
    expect(mergeStoredSettings(
      defaultSettings({ homeDirectory: '/home/tester', documentsDirectory: '/home/tester/Documents', platform: 'linux' }),
      { skillMaxArchiveMb: 512 },
    ).skillMaxArchiveMb).toBe(512)
    expect(mergeStoredSettings(
      defaultSettings({ homeDirectory: '/home/tester', documentsDirectory: '/home/tester/Documents', platform: 'linux' }),
      { skillMaxArchiveMb: 'huge' as unknown as number },
    ).skillMaxArchiveMb).toBe(64)
  })
})
