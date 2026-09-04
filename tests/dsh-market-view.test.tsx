// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { LauncherApiProvider } from '../src/api/client'
import { demoApi } from '../src/demo-api'
import type { DshMarketCatalog, DshMarketPlugin, LauncherApi } from '../src/types'
import { DshMarketView } from '../src/views/DshMarketView'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<{ unmount(): void }> = []
afterEach(() => {
  mounted.splice(0).forEach(root => root.unmount())
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
