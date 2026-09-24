// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoApi } from '../src/demo-api'
import { PluginsView } from '../src/views/PluginsView'
import type { ManagedPlugin } from '../src/types'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
})

const webUi: ManagedPlugin = {
  packageName: '@linxin666/dsh-web-ui-all',
  displayName: 'DSH Web UI',
  description: '',
  version: '1.0.0',
  enabled: true,
  builtin: false,
  locked: false,
  compatible: true,
  order: 3,
}

async function mount(includeWebUi: boolean, overrides: Partial<ComponentProps<typeof PluginsView>> = {}) {
  const profile = await demoApi.readProfile()
  const plugins = profile.plugins.filter(plugin => plugin.builtin)
  if (includeWebUi) plugins.push(webUi)
  const props: ComponentProps<typeof PluginsView> = {
    profile: { ...profile, plugins, activeBundles: plugins.map(plugin => plugin.packageName) },
    profileName: 'web', installedSkills: [], installedApplications: [], installedPresets: [],
    pluginTrials: {}, selected: null, busy: null, profileLocked: false,
    settings: await demoApi.getSettings(), runtime: await demoApi.getRuntimeState(),
    activeRuntimeReplacement: null, runtimeBusy: false, aiActive: false, aiSubject: null,
    onSelect: vi.fn(), onToggle: vi.fn(async () => true), onReorder: vi.fn(),
    onToggleSkill: vi.fn(), onToggleApplication: vi.fn(), onUninstallApplication: vi.fn(),
    onTogglePreset: vi.fn(), onUninstallPreset: vi.fn(), onRefresh: vi.fn(), onBrowse: vi.fn(),
    onOpenRepository: vi.fn(), onImportStandalonePlugin: vi.fn(), onToggleRuntime: vi.fn(), onOpenHarness: vi.fn(),
    onOpenRuntimeSettings: vi.fn(), onUninstall: vi.fn(), onTrialPlugin: vi.fn(), onAdaptPlugin: vi.fn(),
    ...overrides,
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<PluginsView {...props} />))
  return props
}

describe('PluginsView installed Web UI', () => {
  it('opens the standalone plugin import action', async () => {
    const props = await mount(false)
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '导入独立插件')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(props.onImportStandalonePlugin).toHaveBeenCalledOnce()
  })

  it.each(['busy', 'locked', 'running'])('blocks standalone imports while %s', async state => {
    const overrides: Partial<ComponentProps<typeof PluginsView>> = state === 'busy'
      ? { busy: 'plugin-import-standalone' }
      : state === 'locked' ? { profileLocked: true } : { runtime: { ...await demoApi.getRuntimeState(), running: true } }
    const props = await mount(false, overrides)
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '导入独立插件')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(props.onImportStandalonePlugin).not.toHaveBeenCalled()
  })

  it('does not insert a downloadable placeholder into an ordinary Profile', async () => {
    const props = await mount(false)
    expect(document.querySelectorAll('.plugin-rows > .plugin-row')).toHaveLength(props.profile.plugins.length)
    expect(document.body.textContent).not.toContain('官方推荐')
    expect(document.body.textContent).not.toContain(webUi.packageName)
  })

  it('keeps an installed Web UI manageable and includes it in the activation order', async () => {
    const props = await mount(true)
    const row = [...document.querySelectorAll<HTMLElement>('.plugin-rows > .plugin-row')]
      .find(element => element.textContent?.includes(webUi.packageName))!
    expect(row).toBeTruthy()
    expect(row.draggable).toBe(true)
    expect(document.body.textContent).not.toContain('官方推荐')
    expect(document.querySelector('.plugin-status-filters label.selected strong')?.textContent).toBe('3')
    await act(async () => row.querySelector<HTMLButtonElement>('[title="向上移动"]')!.click())
    expect(props.onReorder).toHaveBeenCalledWith([
      '@deepseek-ai/dsh-base', webUi.packageName, '@deepseek-ai/dsh-web-app',
    ])
    await act(async () => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(props.onToggle).toHaveBeenCalledWith(webUi, false)
    await act(async () => row.click())
    const uninstall = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '卸载插件')!
    await act(async () => uninstall.click())
    expect(props.onUninstall).toHaveBeenCalledWith(webUi)
  })
})
