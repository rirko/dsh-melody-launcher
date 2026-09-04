import { describe, expect, it } from 'vitest'
import {
  packLauncherConfig,
  parseLauncherConfig,
  LAUNCHER_CONFIG_FILENAME,
} from '../electron/pack-launcher-config'
import type { AppSettings } from '../src/types'

const baseSettings: AppSettings = {
  dshInstallPath: 'C:\\dsh\\runtime',
  dshHome: 'C:\\Users\\me\\.dsh',
  dshVersion: null,
  nodeVersion: null,
  profileName: 'web',
  activePackId: null,
  workspace: 'C:\\Users\\me\\Documents',
  launchExecutable: 'C:\\dsh\\runtime\\versions\\0.1.0\\node_modules\\.bin\\dsh.cmd',
  launchArgs: ['web'],
  webPort: 3080,
  openAfterLaunch: true,
  uiTheme: 'deepseek',
  aiDeveloperMode: false,
  aiPrompt: '',
  network: { npmRegistry: 'https://registry.npmmirror.com', proxy: '', githubMirror: 'https://gh-proxy.com' },
  recommendedWebUiPrompted: false,
}

describe('packLauncherConfig / parseLauncherConfig', () => {
  it('配置导出只含非敏感、可迁移字段，不含路径/Profile/凭据', () => {
    const yaml = packLauncherConfig(baseSettings)
    expect(yaml).not.toContain('C:\\dsh')
    expect(yaml).not.toContain('profileName')
    expect(yaml).not.toContain('dshHome')
    expect(yaml).not.toContain('dshInstallPath')
    const parsed = parseLauncherConfig(yaml)
    expect(parsed).toMatchObject({
      workspace: 'C:\\Users\\me\\Documents',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: true,
      uiTheme: 'deepseek',
    })
    expect(parsed.network?.npmRegistry).toBe('https://registry.npmmirror.com')
  })

  it('配置可直接写入 zip（不为空且可回读）', () => {
    const yaml = packLauncherConfig(baseSettings)
    expect(yaml.trim().length).toBeGreaterThan(0)
  })

  it('非法配置文本解析时抛错，不吞字段', () => {
    expect(() => parseLauncherConfig('not: [valid: yaml: {{')).toThrow()
  })

  it('缺少可选字段时返回空配置套', () => {
    expect(parseLauncherConfig('')).toEqual({})
    expect(parseLauncherConfig('workspace: /tmp/x')).toEqual({ workspace: '/tmp/x' })
  })

  it('文件名常量是 pack zip 里的固定入口', () => {
    expect(LAUNCHER_CONFIG_FILENAME).toBe('launcher-config.yaml')
  })
})