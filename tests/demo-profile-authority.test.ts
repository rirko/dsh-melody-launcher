import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LauncherApi } from '../src/types'

let api: LauncherApi
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../src/demo-api')).demoApi
})

describe('demo Profile selection compatibility', () => {
  it('lists all sample environments with selection derived only from profileName', async () => {
    const profiles = await api.listProfiles()
    expect(profiles.map(profile => profile.id)).toEqual(expect.arrayContaining(['web', 'pack-web-basic', 'pack-cc-tui']))
    expect(profiles.filter(profile => profile.selected).map(profile => profile.id)).toEqual(['web'])
    expect((await api.listPacks()).filter(pack => pack.enabled)).toEqual([])
    const selected = await api.activatePack('pack-cc-tui')
    expect(selected.profileName).toBe('pack-cc-tui')
    expect(selected.activePackId).toBeNull()
    expect((await api.listProfiles()).filter(profile => profile.selected).map(profile => profile.id)).toEqual(['pack-cc-tui'])
    expect((await api.listPacks()).filter(pack => pack.enabled).map(pack => pack.id)).toEqual(['pack-cc-tui'])
    expect((await api.deactivatePack()).profileName).toBe('pack-cc-tui')
  })

  it('persists created and cloned demo Profiles without selecting them', async () => {
    const source = await api.readProfileMetadata('pack-cc-tui')
    const cloned = await api.cloneProfile('pack-cc-tui', 'cloned', 'Copy')
    const empty = await api.createProfile({ name: 'empty' })
    expect(cloned.pluginCount).toBe(source.pluginCount)
    expect(cloned.enabledPluginCount).toBe(source.enabledPluginCount)
    expect(empty.pluginCount).toBe(0)
    expect((await api.listProfiles()).map(profile => profile.id)).toEqual(expect.arrayContaining(['cloned', 'empty']))
    expect((await api.getSettings()).profileName).toBe('web')
    await expect(api.createProfile({ name: 'cloned' })).rejects.toThrow('已存在')
    await api.switchProfile('cloned')
    await expect(api.deleteProfile('cloned')).rejects.toThrow('不能删除')
    await api.switchProfile('web')
    await api.deleteProfile('cloned')
    expect((await api.listProfiles()).some(profile => profile.id === 'cloned')).toBe(false)
    expect((await api.listPacks()).some(pack => pack.id === 'cloned')).toBe(false)
  })
})
