// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppHeader } from '../src/components/AppHeader'
import { LauncherHome } from '../src/components/LauncherHome'
import { SettingsPanels } from '../src/views/SettingsView'
import { demoApi } from '../src/demo-api'
import type { PackStatus, ProfileSummary } from '../src/types'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
})

async function render(element: ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
}

const other = { id: 'desktop', name: 'Desktop' } as ProfileSummary

describe('Profile selection authority', () => {
  it.each([{ profiles: [] }, { profiles: [other] }])('keeps the launcher selection when the current Profile is absent from $profiles', async ({ profiles }) => {
    const props: ComponentProps<typeof LauncherHome> = {
      settings: { ...await demoApi.getSettings(), profileName: 'web', activePackId: 'legacy-pack' },
      profile: await demoApi.readProfile(), runtime: await demoApi.getRuntimeState(),
      dshInstallation: { installed: true, version: '0.1.0', executable: 'dsh', source: 'launcher' },
      dshUpdate: null, installProgress: null, busy: false, profiles,
      profileSwitcherDisabled: false, installingDsh: false,
      githubAuthStatus: await demoApi.getGitHubAuthStatus(), activeRuntimeReplacement: null,
      onCredential: vi.fn(), onGitHubAccount: vi.fn(), onManage: vi.fn(), onProfileChange: vi.fn(),
      onToggleRuntime: vi.fn(), onUpdateDsh: vi.fn(), onOpenHarness: vi.fn(),
      onMinimize: vi.fn(), onToggleMaximize: vi.fn(), onClose: vi.fn(),
    }
    await render(<LauncherHome {...props} />)
    const select = document.querySelector<HTMLSelectElement>('[aria-label="启动配置"]')!
    expect(select.value).toBe('web')
    expect(select.querySelector('option[value="legacy-pack"]')).toBeNull()
    if (profiles.length) {
      await act(async () => {
        select.value = 'desktop'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(props.onProfileChange).toHaveBeenCalledWith('desktop')
    }
  })

  it.each([{ profiles: [] }, { profiles: [other] }])('keeps the header selection when the current Profile is absent from $profiles', async ({ profiles }) => {
    const props: ComponentProps<typeof AppHeader> = {
      runtime: await demoApi.getRuntimeState(), busy: false, dshInstalled: true, installingDsh: false,
      profileName: 'web', credentialStatus: { configured: false }, customApiCount: 0,
      githubAuthStatus: await demoApi.getGitHubAuthStatus(), activeRuntimeReplacement: null,
      launcherUpdate: null, showPackSwitcher: true, profiles, packSwitcherDisabled: false,
      profileActiveCount: 0, profileDisabledCount: 0, installedSkillCount: 0, profileDirectory: 'web',
      onCredential: vi.fn(), onGitHubAccount: vi.fn(), onToggleRuntime: vi.fn(), onUpdate: vi.fn(),
      onProfileChange: vi.fn(), onOpenProfileDirectory: vi.fn(), onMinimize: vi.fn(),
      onToggleMaximize: vi.fn(), onClose: vi.fn(),
    }
    await render(<AppHeader {...props} />)
    const select = document.querySelector<HTMLSelectElement>('[aria-label="切换 Profile"]')!
    expect(select.value).toBe('web')
    if (profiles.length) {
      await act(async () => {
        select.value = 'desktop'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(props.onProfileChange).toHaveBeenCalledWith('desktop')
    }
  })

  it.each(['web', 'legacy-pack'])('only marks profileName %s as selected and never offers deactivation', async profileName => {
    const props: ComponentProps<typeof SettingsPanels> = {
      settings: { ...await demoApi.getSettings(), profileName, activePackId: 'legacy-pack' },
      tab: 'packs', profile: await demoApi.readProfile(),
      dshInstallation: { installed: true, version: '0.1.0', executable: 'dsh', source: 'launcher' },
      runtimeEnvironment: null, installedSkills: [], installedPresets: [],
      packs: [{ id: 'legacy-pack', name: 'Legacy', plugins: [], state: 'complete' } as unknown as PackStatus],
      busy: null, profileMutationLocked: false, installProgress: null,
      onRefresh: vi.fn(), onImportPack: vi.fn(), onInstallDshVersion: vi.fn(), onSelectDshVersion: vi.fn(),
      onRemoveDshVersion: vi.fn(), onTogglePlugin: vi.fn(), onToggleSkill: vi.fn(), onTogglePreset: vi.fn(),
      onSkillInstalled: vi.fn(), onProfileChanged: vi.fn(), onActivatePack: vi.fn(), onDeactivatePack: vi.fn(),
      onRemovePack: vi.fn(), onExportPack: vi.fn(), onOpenDshFolder: vi.fn(), onOpenPluginFolder: vi.fn(), onOpenPath: vi.fn(),
    }
    await render(<SettingsPanels {...props} />)
    expect(document.querySelectorAll('.settings-pack-row.active')).toHaveLength(profileName === 'legacy-pack' ? 1 : 0)
    expect(document.body.textContent).not.toContain('停用当前整合包')
  })
})
