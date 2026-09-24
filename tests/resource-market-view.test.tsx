// @vitest-environment jsdom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../src/api/client'
import { demoApi } from '../src/demo-api'
import type { DshMarketCatalog, LauncherApi } from '../src/types'
import { ResourceMarketView } from '../src/views/ResourceMarketView'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
})

const catalog: DshMarketCatalog = {
  count: 1, updated: '', categories: {},
  plugins: [{
    name: 'demo-plugin', owner: 'demo', url: 'https://github.com/demo/demo-plugin',
    category: 'tools', description: { zh: '测试插件' }, npm: 'demo-plugin', stars: 1,
    added: '', install: '', installed: false, enabled: false, version: null,
    updateAvailable: false, updateVersion: null,
  }],
}

function tab(which: 'market' | 'repositories') {
  return document.querySelector<HTMLButtonElement>(`button[id$="-${which}-tab"]`)!
}

function panel(which: 'market' | 'repositories') {
  return document.querySelector<HTMLElement>(`div[id$="-${which}-panel"]`)!
}

function createHarness(api: LauncherApi) {
  const repoMounted = vi.fn()
  const repoUnmounted = vi.fn()
  const onProfileChanged = vi.fn(async () => undefined)
  function Repositories() {
    const [query, setQuery] = useState('')
    useEffect(() => { repoMounted(); return repoUnmounted }, [])
    return <input aria-label="仓库搜索" value={query} onChange={event => setQuery(event.target.value)} />
  }
  function Harness({ active = true }: { active?: boolean }) {
    return (
      <LauncherApiProvider value={api}>
        <ResourceMarketView active={active} onProfileChanged={onProfileChanged}>
          <Repositories />
        </ResourceMarketView>
      </LauncherApiProvider>
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return { Harness, repoMounted, repoUnmounted, onProfileChanged }
}

describe('combined resource market', () => {
  it('opens Market first, loads repositories only on demand, and retains both searches', async () => {
    const loadDshMarket = vi.fn(async (_force?: boolean) => catalog)
    const { Harness, repoMounted, repoUnmounted } = createHarness({ ...demoApi, loadDshMarket })
    await act(async () => root!.render(<Harness active={false} />))
    expect(loadDshMarket).not.toHaveBeenCalled()
    await act(async () => root!.render(<Harness />))
    expect(tab('market').getAttribute('aria-selected')).toBe('true')
    expect(panel('market').hidden).toBe(false)
    expect(repoMounted).not.toHaveBeenCalled()
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const marketSearch = document.querySelector<HTMLInputElement>('.dsh-market-search input')!
    panel('market').scrollTop = 260
    await act(async () => {
      setValue.call(marketSearch, 'demo')
      marketSearch.dispatchEvent(new Event('input', { bubbles: true }))
      tab('repositories').click()
    })
    expect(repoMounted).toHaveBeenCalledTimes(1)
    expect(panel('market').hidden).toBe(true)
    panel('repositories').scrollTop = 520
    const repoSearch = document.querySelector<HTMLInputElement>('[aria-label="仓库搜索"]')!
    await act(async () => {
      setValue.call(repoSearch, 'theme')
      repoSearch.dispatchEvent(new Event('input', { bubbles: true }))
      tab('repositories').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(document.activeElement).toBe(tab('market'))
    expect(marketSearch.value).toBe('demo')
    expect(panel('market').scrollTop).toBe(260)
    await act(async () => tab('market').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(repoSearch.value).toBe('theme')
    expect(panel('repositories').scrollTop).toBe(520)
    expect(repoUnmounted).not.toHaveBeenCalled()
    await act(async () => root!.render(<Harness active={false} />))
    await act(async () => root!.render(<Harness />))
    expect(tab('market').getAttribute('aria-selected')).toBe('true')
    expect(repoMounted).toHaveBeenCalledTimes(1)
    expect(loadDshMarket).toHaveBeenCalledTimes(1)
    expect(loadDshMarket).toHaveBeenLastCalledWith(false)
    const refresh = [...panel('market').querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '刷新目录')!
    await act(async () => refresh.click())
    expect(loadDshMarket).toHaveBeenLastCalledWith(true)
    expect(loadDshMarket).toHaveBeenCalledTimes(2)
  })

  it('lets an in-flight Market install finish after switching to repositories', async () => {
    let finishInstall!: (value: DshMarketCatalog['plugins']) => void
    const installDshMarketPlugin = vi.fn(() => new Promise<DshMarketCatalog['plugins']>(resolve => { finishInstall = resolve }))
    const loadDshMarket = vi.fn(async () => catalog)
    const { Harness, onProfileChanged } = createHarness({
      ...demoApi, loadDshMarket, installDshMarketPlugin,
    })
    await act(async () => root!.render(<Harness />))
    const install = [...panel('market').querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '安装')!
    await act(async () => install.click())
    expect(installDshMarketPlugin).toHaveBeenCalledWith('demo-plugin')
    await act(async () => tab('repositories').click())
    expect(loadDshMarket).toHaveBeenCalledTimes(1)
    await act(async () => { finishInstall(catalog.plugins) })
    expect(panel('repositories').hidden).toBe(false)
    expect(onProfileChanged).toHaveBeenCalledTimes(1)
    expect(install.disabled).toBe(false)
    expect(loadDshMarket).toHaveBeenCalledTimes(2)
    await act(async () => tab('market').click())
    expect(loadDshMarket).toHaveBeenCalledTimes(2)
  })
})
