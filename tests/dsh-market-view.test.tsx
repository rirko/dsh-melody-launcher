// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../src/api/client'
import { demoApi } from '../src/demo-api'
import type { DshMarketCatalog, DshMarketPlugin, LauncherApi, ProfileState } from '../src/types'
import { DshMarketView } from '../src/views/DshMarketView'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ unmount(): void }> = []
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach(root => root.unmount()))
  document.body.innerHTML = ''
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0))
  })
}

function plugin(name: string, overrides: Partial<DshMarketPlugin> = {}): DshMarketPlugin {
  return {
    name,
    owner: 'demo',
    url: `https://github.com/demo/${name}`,
    category: 'tools',
    description: { zh: `${name} 描述` },
    npm: `@demo/${name}`,
    stars: 10,
    added: '2026-08-01',
    install: `dsh plugin --profile default add @demo/${name}`,
    installed: false,
    enabled: false,
    version: null,
    updateAvailable: false,
    updateVersion: null,
    ...overrides,
  }
}

const catalog: DshMarketCatalog = {
  updated: '2026-08-01T00:00:00.000Z',
  count: 3,
  categories: { tools: { zh: '工具', en: 'Tools' } },
  plugins: [
    plugin('alpha', { installed: true, enabled: true, version: '1.0.0' }),
    plugin('beta'),
    plugin('gamma', { category: 'network' }),
  ],
}

function apiWith(catalogData: DshMarketCatalog): LauncherApi {
  return { ...demoApi, loadDshMarket: async () => catalogData }
}

function profileState(version = '1.0.0', enabled = true, profileDir = '/profiles/web'): ProfileState {
  return {
    initialized: true, profileDir, manifestPath: `${profileDir}/package.json`,
    plugins: [{
      packageName: '@demo/alpha', displayName: 'alpha', description: '', version, enabled,
      builtin: false, locked: false, compatible: true, order: enabled ? 0 : null,
      declaredInProfile: true,
    }],
    activeBundles: enabled ? ['@demo/alpha'] : [], dependencyCount: 1, disabledCount: enabled ? 0 : 1,
  }
}

function mountMarket(api: LauncherApi) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  return async (active: boolean, profile = profileState()) => {
    await act(async () => root.render(
      <StrictMode><LauncherApiProvider value={api}>
        <DshMarketView active={active} profile={profile} />
      </LauncherApiProvider></StrictMode>,
    ))
  }
}

describe('DshMarketView invalidation', () => {
  it('reads once on first entry, ignores visibility and unchanged Profile snapshots, and reloads on plugin changes', async () => {
    const loadDshMarket = vi.fn(async () => catalog)
    const render = mountMarket({ ...demoApi, loadDshMarket })
    await render(false)
    expect(loadDshMarket).not.toHaveBeenCalled()
    await render(true)
    await render(false)
    await render(true)
    await render(true, { ...profileState(), activeBundles: [...profileState().activeBundles] })
    expect(loadDshMarket).toHaveBeenCalledTimes(1)

    await render(true, profileState('2.0.0'))
    expect(loadDshMarket).toHaveBeenCalledTimes(2)
    await render(true, profileState('2.0.0', false))
    expect(loadDshMarket).toHaveBeenCalledTimes(3)
    await render(false, profileState('2.0.0', false, '/profiles/desktop'))
    expect(loadDshMarket).toHaveBeenCalledTimes(3)
    await render(true, profileState('2.0.0', false, '/profiles/desktop'))
    expect(loadDshMarket).toHaveBeenCalledTimes(4)
    await render(true, { ...profileState(), plugins: [], activeBundles: [], dependencyCount: 0 })
    expect(loadDshMarket).toHaveBeenCalledTimes(5)
    expect(loadDshMarket).toHaveBeenLastCalledWith(false)
  })

  it('does not retry failures on tab changes but allows manual retry', async () => {
    const loadDshMarket = vi.fn().mockRejectedValueOnce(new Error('cannot read profile')).mockResolvedValue(catalog)
    const render = mountMarket({ ...demoApi, loadDshMarket })
    await render(true)
    await render(false)
    await render(true)
    expect(loadDshMarket).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('cannot read profile')
    await act(async () => document.querySelector<HTMLButtonElement>('.error-banner button')!.click())
    expect(loadDshMarket).toHaveBeenLastCalledWith(true)
    expect(document.querySelector('.error-banner')).toBeNull()
  })

  it('keeps a pending load across tab changes and ignores an old Profile response', async () => {
    let finishOld!: (value: DshMarketCatalog) => void
    const newCatalog = { ...catalog, plugins: [plugin('desktop-only')] }
    const loadDshMarket = vi.fn()
      .mockImplementationOnce(() => new Promise<DshMarketCatalog>(resolve => { finishOld = resolve }))
      .mockResolvedValue(newCatalog)
    const render = mountMarket({ ...demoApi, loadDshMarket })
    await render(true)
    await render(false)
    await render(true)
    expect(loadDshMarket).toHaveBeenCalledTimes(1)
    await render(true, profileState('1.0.0', true, '/profiles/desktop'))
    expect(loadDshMarket).toHaveBeenCalledTimes(2)
    await act(async () => finishOld(catalog))
    expect(document.body.textContent).toContain('desktop-only')
    expect(document.body.textContent).not.toContain('alpha')
  })
})

describe('DshMarketView bounded rendering', () => {
  it('renders only 48 of 4062 entries, retains pagination across tabs, and searches the full catalog', async () => {
    const entries = Array.from({ length: 4062 }, (_, index) => plugin(`plugin-${String(index).padStart(4, '0')}`))
    const loadDshMarket = vi.fn(async () => ({ ...catalog, count: entries.length, plugins: entries }))
    const render = mountMarket({ ...demoApi, loadDshMarket })
    await render(true)
    expect(document.querySelectorAll('.dsh-market-card')).toHaveLength(48)
    expect(document.querySelector('.dsh-market-card h2')?.textContent).toBe('plugin-0000')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click())
    expect(document.querySelector('.dsh-market-card h2')?.textContent).toBe('plugin-0048')
    await render(false)
    await render(true)
    expect(document.querySelector('.dsh-market-card h2')?.textContent).toBe('plugin-0048')
    expect(loadDshMarket).toHaveBeenCalledTimes(1)
    const input = document.querySelector<HTMLInputElement>('.dsh-market-search input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'plugin-4061')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.querySelectorAll('.dsh-market-card')).toHaveLength(1)
    expect(document.querySelector('.dsh-market-card h2')?.textContent).toBe('plugin-4061')
    expect(document.querySelector('[aria-label="市场插件分页"]')?.textContent).toContain('第 1 / 1 页')
    expect(loadDshMarket).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct sources with the same display name and installs the selected npm target', async () => {
    const first = plugin('same-name', { npm: 'first-package', url: 'https://github.com/demo/first' })
    const second = plugin('same-name', { npm: 'second-package', url: 'https://github.com/demo/second' })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const installDshMarketPlugin = vi.fn(async () => [])
    try {
      const render = mountMarket({ ...demoApi, installDshMarketPlugin, loadDshMarket: async () => ({ ...catalog, plugins: [first, second, { ...first }] }) })
      await render(true)
      expect(document.querySelectorAll('.dsh-market-card')).toHaveLength(2)
      await act(async () => document.querySelectorAll<HTMLButtonElement>('.dsh-market-card .primary-command')[1].click())
      expect(installDshMarketPlugin).toHaveBeenCalledWith('second-package')
      expect(errors.mock.calls.some(args => args.some(arg => String(arg).includes('same key')))).toBe(false)
    } finally { errors.mockRestore() }
  })

  it('does not render cards again for unrelated parent updates', async () => {
    const description = vi.fn(() => ({ zh: 'description' }))
    const entry = plugin('alpha')
    Object.defineProperty(entry, 'description', { get: description })
    const render = mountMarket(apiWith({ ...catalog, plugins: [entry] }))
    const profile = profileState()
    await render(true, profile)
    description.mockClear()
    await render(true, profile)
    await render(true, profile)
    expect(description).not.toHaveBeenCalled()
  })

  it('clamps the current page when a manual refresh shrinks the catalog', async () => {
    const entries = Array.from({ length: 70 }, (_, index) => plugin(`plugin-${index}`))
    const loadDshMarket = vi.fn().mockResolvedValueOnce({ ...catalog, plugins: entries }).mockResolvedValue(catalog)
    const render = mountMarket({ ...demoApi, loadDshMarket })
    await render(true)
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click())
    expect(document.querySelectorAll('.dsh-market-card')).toHaveLength(22)
    const refresh = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '刷新目录')!
    await act(async () => refresh.click())
    expect(document.querySelectorAll('.dsh-market-card')).toHaveLength(3)
    expect(document.querySelector('[aria-label="市场插件分页"]')?.textContent).toContain('第 1 / 1 页')
  })
})

async function selectCategory(label: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="插件分类"]')
  expect(select).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(select!, label)
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

describe('DshMarketView installed category', () => {
  it('renders only installed plugins when the installed category is selected', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push(root)
    await act(async () => root.render(
      <LauncherApiProvider value={apiWith(catalog)}>
        <DshMarketView />
      </LauncherApiProvider>,
    ))
    await settle()

    expect(document.body.textContent).toContain('alpha')
    expect(document.body.textContent).toContain('beta')

    await selectCategory('__installed')
    expect(document.body.textContent).toContain('alpha')
    expect(document.body.textContent).not.toContain('beta')
    expect(document.body.textContent).not.toContain('gamma')
  })

  it('shows a dedicated empty state when nothing is installed', async () => {
    const empty: DshMarketCatalog = { ...catalog, plugins: catalog.plugins.map(entry => plugin(entry.name, { category: entry.category })) }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push(root)
    await act(async () => root.render(
      <LauncherApiProvider value={apiWith(empty)}>
        <DshMarketView />
      </LauncherApiProvider>,
    ))
    await settle()

    await selectCategory('__installed')
    expect(document.body.textContent).toContain('当前 Profile 还没有已安装的精选插件')
  })

  it('keeps the text search active inside the installed category', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push(root)
    await act(async () => root.render(
      <LauncherApiProvider value={apiWith(catalog)}>
        <DshMarketView />
      </LauncherApiProvider>,
    ))
    await settle()

    await selectCategory('__installed')
    const input = document.querySelector<HTMLInputElement>('.dsh-market-search input')
    expect(input).toBeTruthy()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(input!, 'alpha')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(document.body.textContent).toContain('alpha')
  })
})
