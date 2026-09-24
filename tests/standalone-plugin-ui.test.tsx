// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../src/api/client'
import { demoApi } from '../src/demo-api'
import { useLauncherStore } from '../src/hooks/use-launcher-store'
import { PacksView } from '../src/views/PacksView'
import type { LauncherApi } from '../src/types'

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

describe('standalone plugin Profile export', () => {
  it('dispatches plugin mode from the existing export submenu', async () => {
    const props: ComponentProps<typeof PacksView> = {
      profiles: (await demoApi.listProfiles()).filter(profile => profile.id === 'web'),
      packs: [], profile: await demoApi.readProfile(), busy: null,
      onRefresh: vi.fn(), onCreate: vi.fn(), onImport: vi.fn(), onActivate: vi.fn(), onDeactivate: vi.fn(),
      onExport: vi.fn(), onExportProfile: vi.fn(), onRemove: vi.fn(),
      onAddPlugin: vi.fn(), onAddPreset: vi.fn(), onAddSkill: vi.fn(), onAddApplication: vi.fn(),
      onToggleItem: vi.fn(), onTogglePreset: vi.fn(), onToggleSkill: vi.fn(), onToggleApplication: vi.fn(),
      onRemoveItem: vi.fn(), onRemovePreset: vi.fn(), onRemoveSkill: vi.fn(), onRemoveApplication: vi.fn(),
      installedPresets: [], installedSkills: [], installedApplications: [],
    }
    await render(<PacksView {...props} />)
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="导出 Profile「web」"]')!.click())
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === '导出为独立插件')!
    expect(item).toBeTruthy()
    await act(async () => item.click())
    expect(props.onExportProfile).toHaveBeenCalledWith('web', 'plugin')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('simulates one top-level composite plugin, not its private members', async () => {
    const before = await demoApi.readProfile()
    const next = await demoApi.importStandalonePlugin()
    const additions = next!.plugins.filter(plugin => !before.plugins.some(existing => existing.packageName === plugin.packageName))
    expect(additions.map(plugin => plugin.packageName)).toEqual(['dsh-suite-demo'])
    expect(additions[0]).toMatchObject({ enabled: true, declaredInProfile: true, actualSource: 'local' })
    expect(await demoApi.exportProfile('web', 'plugin')).toMatch(/dsh-suite-web-1\.0\.0\.dsh-plugin\.zip$/)
    await demoApi.uninstallPlugin('dsh-suite-demo')
  })
})

describe('standalone plugin import store', () => {
  let store: ReturnType<typeof useLauncherStore>
  function Harness() {
    store = useLauncherStore()
    return null
  }

  async function mountApi(importStandalonePlugin: LauncherApi['importStandalonePlugin']) {
    const api: LauncherApi = {
      ...demoApi,
      importStandalonePlugin,
      listProfiles: vi.fn(demoApi.listProfiles),
      getGitHubAuthStatus: async () => ({ ...await demoApi.getGitHubAuthStatus(), authenticated: true }),
    }
    await render(<LauncherApiProvider value={api}><Harness /></LauncherApiProvider>)
    expect(store.loading).toBe(false)
    vi.mocked(api.listProfiles).mockClear()
    return api
  }

  it('adopts imported Profile and refreshes Profile summaries on success', async () => {
    const original = await demoApi.readProfile()
    const imported = { ...original, dependencyCount: original.dependencyCount + 1 }
    const api = await mountApi(vi.fn(async () => imported))
    await act(async () => { expect(await store.importStandalonePlugin()).toBe(true) })
    expect(store.profile).toEqual(imported)
    expect(api.listProfiles).toHaveBeenCalledOnce()
    expect(store.toast).toMatchObject({ kind: 'success', message: '独立插件已导入当前 Profile。' })
    expect(store.busy).toBeNull()
  })

  it('does not show success or mutate Profile after file selection is cancelled', async () => {
    const api = await mountApi(vi.fn(async () => null))
    const previous = store.profile
    await act(async () => { expect(await store.importStandalonePlugin()).toBe(false) })
    expect(store.profile).toBe(previous)
    expect(api.listProfiles).not.toHaveBeenCalled()
    expect(store.toast).toBeNull()
    expect(store.busy).toBeNull()
  })

  it('shows import failure and releases the action busy state', async () => {
    await mountApi(vi.fn(async () => { throw new Error('archive invalid') }))
    await act(async () => { expect(await store.importStandalonePlugin()).toBe(false) })
    expect(store.toast).toMatchObject({ kind: 'error', message: 'archive invalid' })
    expect(store.busy).toBeNull()
  })
})
