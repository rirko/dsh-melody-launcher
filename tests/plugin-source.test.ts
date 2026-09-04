import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSubdirectoryPlugin, type PluginSourceProgress } from '../electron/plugin-source'
import type { PluginInstallTarget } from '../src/types'

let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('plugin source download progress', () => {
  it('reports downloaded bytes when GitHub omits the total size', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-source-'))
    const commit = 'a'.repeat(40)
    const zip = new AdmZip()
    zip.addFile('repository-main/packages/example/package.json', Buffer.from(JSON.stringify({ name: 'example' })))
    const archive = zip.toBuffer()
    const progress: PluginSourceProgress[] = []
    const target: PluginInstallTarget = {
      id: 'example:packages/example',
      packageName: 'example',
      version: '1.0.0',
      source: 'archive-subdirectory',
      profileName: 'web',
      platform: 'unknown',
      subdirectory: 'packages/example',
      commit,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
    }

    const packageDirectory = await prepareSubdirectoryPlugin(
      temporaryDirectory,
      'owner/repository',
      target,
      update => progress.push(update),
      async () => new Response(new Uint8Array(archive)),
    )

    expect(JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))).toEqual({ name: 'example' })
    expect(progress).toContainEqual(expect.objectContaining({
      percent: 20,
      indeterminate: true,
      downloadedBytes: archive.byteLength,
    }))
    expect(progress.some(update => update.totalBytes != null)).toBe(false)
  })

  it('accepts a root-level Bundle when Git is unavailable', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-source-root-'))
    const commit = 'b'.repeat(40)
    const zip = new AdmZip()
    zip.addFile('repository-main/package.json', Buffer.from(JSON.stringify({ name: 'root-plugin' })))
    const archive = zip.toBuffer()
    const target: PluginInstallTarget = {
      id: 'root-plugin:.',
      packageName: 'root-plugin',
      version: '1.0.0',
      source: 'github',
      profileName: 'web',
      platform: 'unknown',
      subdirectory: null,
      commit,
      requiresBuild: false,
      buildScripts: [],
      nodeRange: null,
    }

    const packageDirectory = await prepareSubdirectoryPlugin(
      temporaryDirectory,
      'owner/repository',
      target,
      () => undefined,
      async () => new Response(new Uint8Array(archive)),
    )

    expect(JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))).toEqual({ name: 'root-plugin' })
  })

  it('retries a transient archive network error before extracting the pinned source', async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-source-retry-'))
    const commit = 'c'.repeat(40)
    const zip = new AdmZip()
    zip.addFile('repository-main/package.json', Buffer.from(JSON.stringify({ name: 'retry-plugin' })))
    const archive = zip.toBuffer()
    const target: PluginInstallTarget = {
      id: 'retry-plugin:.', packageName: 'retry-plugin', version: '1.0.0', source: 'github', profileName: 'web',
      platform: 'unknown', subdirectory: null, commit, requiresBuild: false, buildScripts: [], nodeRange: null,
    }
    let attempts = 0
    const packageDirectory = await prepareSubdirectoryPlugin(
      temporaryDirectory,
      'owner/repository',
      target,
      () => undefined,
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('ETIMEDOUT')
        return new Response(new Uint8Array(archive))
      },
    )

    expect(attempts).toBe(2)
    expect(JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))).toEqual({ name: 'retry-plugin' })
  })
})
