import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/constants'
import type { LauncherApi } from '../src/types'

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(async () => null) }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke },
}))

describe('standalone plugin preload API', () => {
  it('keeps file selection in the main process and forwards plugin export mode', async () => {
    await import('../electron/preload')
    const api = mocks.expose.mock.calls.find(call => call[0] === 'launcher')![1] as LauncherApi
    expect(await api.importStandalonePlugin()).toBeNull()
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC.pluginsImportStandalone)
    await api.exportProfile('web', 'plugin')
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC.profilesExport, { profileName: 'web', mode: 'plugin' })
  })
})
