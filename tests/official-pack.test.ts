import { describe, expect, it } from 'vitest'
import {
  compareOfficialPackVersions,
  dshVersionOfOfficialPack,
  listOfficialPackVersions,
  officialPackAssetName,
  officialPackDisplayName,
} from '../electron/official-pack'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'

const RELEASES_ENDPOINT = `https://api.github.com/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases?per_page=100`

function assetNameUrl(version: string, tag: string): string {
  return `https://github.com/${LAUNCHER_RELEASE_REPOSITORY}/releases/download/${tag}/${officialPackAssetName(version)}`
}

function releaseFixture(tag: string, body: string | null, versions: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    tag_name: tag,
    body,
    published_at: '2026-09-15T16:00:00.000Z',
    draft: false,
    assets: versions.map(version => ({
      name: officialPackAssetName(version),
      browser_download_url: assetNameUrl(version, tag),
      size: 21,
    })),
    ...extra,
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

function fetchFor(onUrl: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => onUrl(String(input))) as typeof fetch
}

describe('dshVersionOfOfficialPack', () => {
  it('去掉尾部序号还原适配的 DSH 版本', () => {
    expect(dshVersionOfOfficialPack('0.1.5-rc.2.1')).toBe('0.1.5-rc.2')
    expect(dshVersionOfOfficialPack('0.1.6-alpha.1.2')).toBe('0.1.6-alpha.1')
    expect(dshVersionOfOfficialPack('0.2.0.3')).toBe('0.2.0')
  })

  it('旧命名（包版本 = 启动器版本，与 DSH 无关）解不出来就返回 null，不猜', () => {
    // 去掉尾段后 `0.1` 不是合法版本号 → 名字里没编码 DSH 版本，宁可「未标注」。
    expect(dshVersionOfOfficialPack('0.1.1')).toBeNull()
    expect(dshVersionOfOfficialPack('0.1.9')).toBeNull()
  })
})

describe('compareOfficialPackVersions', () => {
  it('数字段按数值比较，预发布版低于正式版', () => {
    expect(compareOfficialPackVersions('0.1.5', '0.1.10')).toBeLessThan(0)
    expect(compareOfficialPackVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareOfficialPackVersions('0.1.5', '0.1.5-rc.1')).toBeGreaterThan(0)
    expect(compareOfficialPackVersions('0.1.5-rc.2', '0.1.5-rc.10')).toBeLessThan(0)
  })
})

describe('listOfficialPackVersions', () => {
  it('扫全部 Release，按版本降序，DSH 版本优先取 Release 正文', async () => {
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(url => {
        if (url !== RELEASES_ENDPOINT) throw new Error(`unexpected ${url}`)
        return jsonResponse([
          releaseFixture('v0.1.1', 'web-all: 0.3.18\n dsh: 0.1.2-rc.1', ['0.1.2-rc.1.1']),
          releaseFixture('v0.1.2', 'web-all: 0.3.22\ndsh: 0.1.5-rc.2', ['0.1.5-rc.2.1', '0.1.5-rc.2.2']),
          releaseFixture('v0.0.9', null, ['9.9.9'], { draft: true }),
        ])
      }),
    })
    expect(versions.map(item => item.version)).toEqual(['0.1.5-rc.2.2', '0.1.5-rc.2.1', '0.1.2-rc.1.1'])
    expect(versions[0]?.dshVersion).toBe('0.1.5-rc.2')
    expect(versions[2]?.dshVersion).toBe('0.1.2-rc.1')
    expect(versions[0]?.releaseTag).toBe('v0.1.2')
    expect(versions[0]?.assetUrl).toBe(assetNameUrl('0.1.5-rc.2.2', 'v0.1.2'))
    // 草稿 Release 不进列表。
    expect(versions.some(item => item.version === '9.9.9')).toBe(false)
  })

  it('正文没记 DSH 版本时从版本号推导', async () => {
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(() => jsonResponse([releaseFixture('v0.2.0', null, ['0.1.5-rc.2.4'])])),
    })
    expect(versions[0]?.dshVersion).toBe('0.1.5-rc.2')
  })

  it('旧命名 + 正文无元信息 → dshVersion 为 null（不许拿包版本号冒充）', async () => {
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(() => jsonResponse([
        releaseFixture('v0.1.1', '# v0.1.1 — 下载即用：官方默认整合包 + Office 技能', ['0.1.1']),
        releaseFixture('v0.1.2', 'web-all: 0.3.22\ndsh: 0.1.5-rc.2', ['0.1.5-rc.2.1']),
      ])),
    })
    expect(versions.map(item => item.version)).toEqual(['0.1.5-rc.2.1', '0.1.1'])
    expect(versions[1]?.dshVersion).toBeNull()
  })

  it('限流 403 给出可读错误；直连失败时走镜像候选', async () => {
    await expect(listOfficialPackVersions({
      fetchImpl: fetchFor(() => new Response('', { status: 403 })),
    })).rejects.toThrow('额度')

    const seen: string[] = []
    const versions = await listOfficialPackVersions({
      fetchImpl: fetchFor(url => {
        seen.push(url)
        if (url === `https://gh-proxy.com/${RELEASES_ENDPOINT}`) {
          return jsonResponse([releaseFixture('v0.1.2', null, ['0.1.5-rc.2.1'])])
        }
        return new Response('', { status: 502 })
      }),
    })
    expect(versions.map(item => item.version)).toEqual(['0.1.5-rc.2.1'])
    expect(seen.length).toBeGreaterThan(1)
  })
})

describe('命名辅助', () => {
  it('资产名与显示名', () => {
    expect(officialPackAssetName('0.1.5-rc.2.1')).toBe('official-pack-v0.1.5-rc.2.1.zip')
    expect(officialPackDisplayName('0.1.5-rc.2.1')).toBe('官方默认整合包 0.1.5-rc.2.1')
  })
})
