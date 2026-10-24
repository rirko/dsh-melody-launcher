import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createOfficialPackService,
  downloadOfficialPackAsset,
  officialPackAssetName,
  OFFICIAL_PACK_DOWNLOAD_TUNING,
  type OfficialPackServiceDeps,
} from '../electron/official-pack'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const RELEASES_ENDPOINT = `https://api.github.com/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases?per_page=100`
const ASSET_URL = `https://github.com/${LAUNCHER_RELEASE_REPOSITORY}/releases/download/v0.1.5-rc.2/official-pack-v0.1.5-rc.2.1.zip`

function releaseListing(): Response {
  return new Response(JSON.stringify([
    {
      tag_name: 'v0.1.5-rc.2',
      body: 'web-all: 0.3.22\ndsh: 0.1.5-rc.2',
      published_at: '2026-09-10T00:00:00.000Z',
      draft: false,
      assets: [{ name: officialPackAssetName('0.1.5-rc.2.1'), browser_download_url: ASSET_URL, size: 4 }],
    },
  ]), { status: 200 })
}

function fastTuning() {
  return { firstByteMs: 500, stallMs: 500, probeMs: 60_000, floorBytesPerSecond: 0 }
}

describe('downloadOfficialPackAsset', () => {
  it('直连失败时换镜像源；成功结果带来源标签', async () => {
    const sources: string[] = []
    const buffer = await downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        sources.push(url)
        if (url === ASSET_URL) throw new Error('boom')
        return new Response(Uint8Array.from([1, 2, 3, 4]), { status: 200 })
      }) as typeof fetch,
      maxBytes: 1024,
      tuning: fastTuning(),
    })
    expect(buffer.buffer.length).toBe(4)
    expect(sources[0]).toBe(ASSET_URL)
    expect(sources.length).toBeGreaterThan(1)
  })

  it('全部候选不可用时报可读错误', async () => {
    await expect(downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: (async () => new Response('', { status: 502 })) as typeof fetch,
      maxBytes: 1024,
      tuning: fastTuning(),
    })).rejects.toThrow('所有下载源都不可用')
  })

  it('速度低于下限的源会被换掉（第二轮只看断流，慢慢来也能下完）', async () => {
    // 直连：每个字节之间拖 40ms（窗口内均速远低于下限）→ 被拒绝。
    function slowBody(): ReadableStream<Uint8Array> {
      return new ReadableStream({
        async start(controller) {
          for (let i = 0; i < 3; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 40))
            controller.enqueue(Uint8Array.from([i]))
          }
          controller.close()
        },
      })
    }
    const tuning = { firstByteMs: 1_000, stallMs: 1_000, probeMs: 50, floorBytesPerSecond: 10_000 }
    const buffer = await downloadOfficialPackAsset(ASSET_URL, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === ASSET_URL) return new Response(slowBody(), { status: 200 })
        return new Response(Uint8Array.from([9]), { status: 200 })
      }) as typeof fetch,
      maxBytes: 1024,
      tuning,
    })
    expect(buffer.buffer.length).toBe(1)
  })
})

describe('createOfficialPackService.install', () => {
  async function makeDeps(overrides: Partial<OfficialPackServiceDeps> = {}): Promise<{ deps: OfficialPackServiceDeps; calls: string[]; stamped: Array<[string, string]> }> {
    const calls: string[] = []
    const importedVersions = new Set<string>()
    const stamped: Array<[string, string]> = []
    const downloadDir = await tempDir('op-dl-')
    const home = await tempDir('op-home-')
    const deps: OfficialPackServiceDeps = {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url === RELEASES_ENDPOINT) return releaseListing()
        if (url === ASSET_URL) {
          // 一个最小快照 zip：让真正的导入管线也能吃下去。
          const zip = new AdmZip()
          zip.addFile('dsh-snapshot.json', Buffer.from(JSON.stringify({ format: 1, platform: process.platform, exportedAt: 'x', links: [], excluded: [], warnings: [] })))
          zip.addFile('profiles/pack-test/profile.yaml', Buffer.from('name: pack-test\ndshVersion: 0.1.5-rc.2\n'))
          return new Response(Uint8Array.from(zip.toBuffer()), { status: 200 })
        }
        throw new Error(`unexpected ${url}`)
      }) as typeof fetch,
      importPack: async filePath => {
        expect(existsSync(filePath)).toBe(true)
        expect(path.basename(filePath)).toBe(officialPackAssetName('0.1.5-rc.2.1'))
        // 真实 importPack 把官方版本戳写进 Profile 元数据；假实现同步登记为已导入。
        importedVersions.add('0.1.5-rc.2.1')
        return { id: 'official-default-0-1-5-rc-2-1', installed: ['@linxin666/dsh-web-all'], failures: [], state: 'complete' }
      },
      homeForPack: async () => home,
      stampOfficialVersion: async (packId, packVersion) => {
        stamped.push([packId, packVersion])
      },
      isOfficialVersionImported: async packVersion => importedVersions.has(packVersion),
      downloadDir,
      ...overrides,
    }
    return { deps, calls, stamped }
  }

  it('缺失时下载导入：盖版本戳 + 外观回原生 + 临时 zip 清理', async () => {
    const { deps, calls, stamped } = await makeDeps()
    const service = createOfficialPackService(deps)
    const result = await service.install('0.1.5-rc.2.1')
    expect(result.outcome).toBe('imported')
    expect(result.source).toBeTruthy()
    expect(calls.filter(url => url === ASSET_URL)).toHaveLength(1)

    expect(stamped).toEqual([['official-default-0-1-5-rc-2-1', '0.1.5-rc.2.1']])

    const home = await deps.homeForPack('x')
    expect(home && existsSync(path.join(home, 'skin-center-active.json'))).toBe(true)
    const appearance = home && JSON.parse(await readFile(path.join(home, 'skin-center-active.json'), 'utf8')) as { active: unknown; initialized: boolean }
    expect(appearance).toEqual({ active: null, initialized: true })

    expect(existsSync(path.join(deps.downloadDir, officialPackAssetName('0.1.5-rc.2.1')))).toBe(false)
  })

  it('本机已有该版本时零网络短路', async () => {
    const { deps, calls } = await makeDeps({
      isOfficialVersionImported: async packVersion => packVersion === '0.1.5-rc.2.1',
    })
    const service = createOfficialPackService(deps)
    const result = await service.install('0.1.5-rc.2.1')
    expect(result.outcome).toBe('present')
    expect(calls).toHaveLength(0)
  })

  it('下载进度全程上报（字节数 + 来源）', async () => {
    const progressList: Array<{ received: number; source: string }> = []
    const { deps } = await makeDeps({
      onProgress: progress => progressList.push(progress),
    })
    const service = createOfficialPackService(deps)
    await service.install('0.1.5-rc.2.1')
    expect(progressList.length).toBeGreaterThan(0)
    expect(progressList[0]?.source).toBeTruthy()
  })

  it('列表读不到时回退 releases/latest 兜底', async () => {
    const latestEndpoint = `https://api.github.com/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
    const { deps } = await makeDeps({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === RELEASES_ENDPOINT) return new Response('', { status: 502 })
        if (url === latestEndpoint) {
          return new Response(JSON.stringify({ assets: [{ name: officialPackAssetName('0.1.5-rc.2.1'), browser_download_url: ASSET_URL, size: 4 }] }), { status: 200 })
        }
        if (url === ASSET_URL) return new Response(Uint8Array.from([1]), { status: 200 })
        throw new Error(`unexpected ${url}`)
      }) as typeof fetch,
    })
    const service = createOfficialPackService(deps)
    const result = await service.install('0.1.5-rc.2.1')
    expect(result.outcome).toBe('imported')
  })
})
