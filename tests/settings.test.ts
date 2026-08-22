import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  adoptDetectedDsh,
  defaultSettings,
  mergeStoredSettings,
  usesOnDemandDsh,
  validateSettings,
} from '../electron/settings'
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
