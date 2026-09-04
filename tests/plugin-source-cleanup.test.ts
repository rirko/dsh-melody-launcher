import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeUnusedPluginSources, sourceCacheCandidatePath } from '../electron/plugin-source-cleanup'
import type { PluginInstallReceipt } from '../electron/plugin-receipts'

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

function receipt(overrides: Partial<PluginInstallReceipt>): PluginInstallReceipt {
  return {
    repository: 'owner/repository',
    packageName: '@owner/demo-plugin',
    profileName: 'web',
    source: 'archive-subdirectory',
    subdirectory: 'packages/demo-plugin',
    version: '1.0.0',
    commit: 'a'.repeat(40),
    installedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

describe('plugin source cache cleanup', () => {
  it('removes only the unreferenced archive subdirectory and keeps sibling packages', async () => {
    temporaryDirectory = await mkdirTemp()
    const sourceRoot = path.join(temporaryDirectory, 'plugin-sources')
    const commitRoot = path.join(sourceRoot, 'owner', 'repository', 'a'.repeat(40))
    const removedDirectory = path.join(commitRoot, 'packages', 'demo-plugin')
    const retainedDirectory = path.join(commitRoot, 'packages', 'other-plugin')
    await mkdir(removedDirectory, { recursive: true })
    await mkdir(retainedDirectory, { recursive: true })
    await writeFile(path.join(removedDirectory, 'package.json'), '{}')
    await writeFile(path.join(retainedDirectory, 'package.json'), '{}')

    await purgeUnusedPluginSources({
      sourceRoot,
      removedReceipts: [receipt({})],
      remainingReceipts: [receipt({ packageName: '@owner/other-plugin', subdirectory: 'packages/other-plugin', profileName: 'tui' })],
    })

    expect(await exists(removedDirectory)).toBe(false)
    expect(await exists(retainedDirectory)).toBe(true)
    expect(await exists(commitRoot)).toBe(true)
  })

  it('removes an unreferenced release archive but preserves one used by another Profile', async () => {
    temporaryDirectory = await mkdirTemp()
    const sourceRoot = path.join(temporaryDirectory, 'plugin-sources')
    const release = receipt({
      packageName: '@owner/release-plugin',
      source: 'release',
      subdirectory: null,
      version: '2.3.4',
      commit: '',
    })
    const releasePath = sourceCacheCandidatePath(sourceRoot, release)!
    await mkdir(path.dirname(releasePath), { recursive: true })
    await writeFile(releasePath, 'archive')
    await purgeUnusedPluginSources({ sourceRoot, removedReceipts: [release], remainingReceipts: [] })
    expect(await exists(releasePath)).toBe(false)

    await writeFile(releasePath, 'archive')
    await purgeUnusedPluginSources({ sourceRoot, removedReceipts: [release], remainingReceipts: [receipt({ ...release, profileName: 'tui' })] })
    expect(await exists(releasePath)).toBe(true)
  })

  it('does not remove a cache path still referenced by a Profile file dependency', async () => {
    temporaryDirectory = await mkdirTemp()
    const sourceRoot = path.join(temporaryDirectory, 'plugin-sources')
    const profileRoot = path.join(temporaryDirectory, 'profiles')
    const release = receipt({ packageName: 'release-plugin', source: 'release', subdirectory: null, version: '1.0.0', commit: '' })
    const releasePath = sourceCacheCandidatePath(sourceRoot, release)!
    await mkdir(path.dirname(releasePath), { recursive: true })
    await writeFile(releasePath, 'archive')
    await mkdir(path.join(profileRoot, 'other'), { recursive: true })
    await writeFile(path.join(profileRoot, 'other', 'package.json'), JSON.stringify({ dependencies: { 'release-plugin': `file:${releasePath}` } }))

    await purgeUnusedPluginSources({ sourceRoot, profileRoot, removedReceipts: [release], remainingReceipts: [] })
    expect(await exists(releasePath)).toBe(true)
  })

  it('cleans an imported pack snapshot from its removed file reference', async () => {
    temporaryDirectory = await mkdirTemp()
    const sourceRoot = path.join(temporaryDirectory, 'plugin-sources')
    const snapshot = path.join(sourceRoot, 'pack-import-123')
    const pluginDirectory = path.join(snapshot, 'plugins', 'demo')
    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(path.join(pluginDirectory, 'package.json'), '{}')
    const local = receipt({ source: 'local-directory', repository: 'owner/pack', subdirectory: null })

    await purgeUnusedPluginSources({
      sourceRoot,
      removedReceipts: [local],
      remainingReceipts: [],
      removedFileReferences: [pluginDirectory],
    })

    expect(await exists(snapshot)).toBe(false)
  })

  it('keeps an imported pack snapshot when another Profile still links a package within it', async () => {
    temporaryDirectory = await mkdirTemp()
    const sourceRoot = path.join(temporaryDirectory, 'plugin-sources')
    const profileRoot = path.join(temporaryDirectory, 'profiles')
    const snapshot = path.join(sourceRoot, 'pack-import-456')
    const removedDirectory = path.join(snapshot, 'plugins', 'demo')
    const retainedDirectory = path.join(snapshot, 'plugins', 'other')
    await mkdir(removedDirectory, { recursive: true })
    await mkdir(retainedDirectory, { recursive: true })
    await mkdir(path.join(profileRoot, 'other'), { recursive: true })
    await writeFile(path.join(profileRoot, 'other', 'package.json'), JSON.stringify({ dependencies: { other: `file:${retainedDirectory}` } }))

    await purgeUnusedPluginSources({
      sourceRoot,
      profileRoot,
      removedReceipts: [receipt({ source: 'local-directory', repository: 'owner/pack', subdirectory: null })],
      remainingReceipts: [],
      removedFileReferences: [removedDirectory],
    })

    expect(await exists(snapshot)).toBe(true)
  })

  it('never deletes an arbitrary external local-directory source', async () => {
    temporaryDirectory = await mkdirTemp()
    const sourceRoot = path.join(temporaryDirectory, 'plugin-sources')
    const external = path.join(temporaryDirectory, 'outside-plugin')
    await mkdir(external, { recursive: true })
    await writeFile(path.join(external, 'package.json'), '{}')
    const local = receipt({ source: 'local-directory', repository: `file:${external}`, subdirectory: null })

    await purgeUnusedPluginSources({ sourceRoot, removedReceipts: [local], remainingReceipts: [] })
    expect(await exists(external)).toBe(true)
  })
})

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-source-cleanup-'))
}
