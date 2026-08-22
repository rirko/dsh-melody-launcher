import { describe, expect, it } from 'vitest'
import type { PluginInstallReceipt } from '../electron/plugin-receipts'
import type { PackManifest } from '../src/types'
import {
  buildManifestFromReceipts,
  packProfileName,
  parsePackManifest,
  serializePackManifest,
} from '../electron/pack-manifest'

describe('packProfileName', () => {
  it('派生出小写、非字母数字转 - 的 pack Profile 名', () => {
    expect(packProfileName('My Pack!')).toBe('pack-my-pack-')
    expect(packProfileName('Alpha_Beta.v2')).toBe('pack-alpha_beta.v2')
    expect(packProfileName('Hello World! 42')).toBe('pack-hello-world--42')
  })

  it('超出 Profile 名长度限制（64 字符）时抛错', () => {
    expect(() => packProfileName('x'.repeat(65))).toThrow()
  })

  it('空名称抛错', () => {
    expect(() => packProfileName('')).toThrow()
    expect(() => packProfileName('   ')).toThrow()
  })
})

describe('parsePackManifest', () => {
  it('当前导入模式要求 dshVersion，并规范化 v 前缀', () => {
    const base = 'name: A\ndescription: d\nversion: 1.0.0\nplugins: []\n'
    expect(() => parsePackManifest(base, { requireDshVersion: true })).toThrow('dshVersion')
    expect(parsePackManifest(`${base}dshVersion: v0.1.0-rc.7\n`, { requireDshVersion: true }).dshVersion).toBe('0.1.0-rc.7')
  })
  it('解析合法清单并填充缺省 source', () => {
    const manifest = parsePackManifest(`
name: My Pack
description: A demo integration pack.
version: 1.2.3
author: rikey
plugins:
  - packageName: alpha
    repository: demo/alpha
    subdirectory: packages/alpha
    commit: abc1234
  - packageName: beta
    source: npm
    version: 2.0.0
  - packageName: '@demo/gamma'
    repository: demo/gamma
`)
    expect(manifest.name).toBe('My Pack')
    expect(manifest.description).toBe('A demo integration pack.')
    expect(manifest.version).toBe('1.2.3')
    expect(manifest.author).toBe('rikey')
    expect(manifest.plugins).toHaveLength(3)
    expect(manifest.plugins[0]).toEqual({
      packageName: 'alpha',
      repository: 'demo/alpha',
      subdirectory: 'packages/alpha',
      commit: 'abc1234',
      source: 'github',
    })
    expect(manifest.plugins[1]).toEqual({ packageName: 'beta', source: 'npm', version: '2.0.0' })
    expect(manifest.plugins[2]).toEqual({ packageName: '@demo/gamma', repository: 'demo/gamma', source: 'github' })
  })

  it('未知字段被忽略，skills 被解析', () => {
    const manifest = parsePackManifest(`
name: Ignore
description: unknown fields are ignored
version: 1.0.0
unknownTop: hello
skills:
  - name: git-workflow
    format: bundle
    repository: demo/skill-repo
    sourcePath: skills/git-workflow
    revision: abc1234
plugins:
  - packageName: alpha
    weirdField: 42
`)
    expect(manifest.name).toBe('Ignore')
    expect(manifest.skills).toEqual([{
      name: 'git-workflow',
      format: 'bundle',
      repository: 'demo/skill-repo',
      sourcePath: 'skills/git-workflow',
      revision: 'abc1234',
    }])
    expect(manifest.plugins[0]).toEqual({ packageName: 'alpha', source: 'npm' })
  })

  it('缺省 source：有 repository 视为 github，否则 npm', () => {
    const withRepo = parsePackManifest(`
name: A
description: d
version: 1.0.0
plugins:
  - packageName: alpha
    repository: demo/alpha
`)
    expect(withRepo.plugins[0].source).toBe('github')

    const withoutRepo = parsePackManifest(`
name: B
description: d
version: 1.0.0
plugins:
  - packageName: alpha
`)
    expect(withoutRepo.plugins[0].source).toBe('npm')
  })

  it('name 非法时抛错', () => {
    expect(() => parsePackManifest('description: d\nversion: 1.0.0\nplugins: []')).toThrow('name')
    expect(() => parsePackManifest('name: "-bad"\ndescription: d\nversion: 1.0.0\nplugins: []')).toThrow('name')
    expect(() => parsePackManifest('name: ""\ndescription: d\nversion: 1.0.0\nplugins: []')).toThrow('name')
    expect(() => parsePackManifest(`name: "${'a'.repeat(65)}"\ndescription: d\nversion: 1.0.0\nplugins: []`)).toThrow('name')
    expect(() => parsePackManifest('name: 123\ndescription: d\nversion: 1.0.0\nplugins: []')).toThrow('name')
  })

  it('description 非法时抛错', () => {
    expect(() => parsePackManifest('name: A\nversion: 1.0.0\nplugins: []')).toThrow('description')
    expect(() => parsePackManifest('name: A\ndescription: ""\nversion: 1.0.0\nplugins: []')).toThrow('description')
    expect(() => parsePackManifest('name: A\ndescription: "   "\nversion: 1.0.0\nplugins: []')).toThrow('description')
    expect(() => parsePackManifest(`name: A\ndescription: "${'d'.repeat(501)}"\nversion: 1.0.0\nplugins: []`)).toThrow('description')
  })

  it('version 非法时抛错', () => {
    expect(() => parsePackManifest('name: A\ndescription: d\nplugins: []')).toThrow('version')
    expect(() => parsePackManifest('name: A\ndescription: d\nversion: "1.0"\nplugins: []')).toThrow('version')
    expect(() => parsePackManifest('name: A\ndescription: d\nversion: "v1.0.0"\nplugins: []')).toThrow('version')
    expect(() => parsePackManifest('name: A\ndescription: d\nversion: "1.0.0-beta"\nplugins: []')).not.toThrow()
  })

  it('plugins 结构非法时抛错', () => {
    expect(() => parsePackManifest('name: A\ndescription: d\nversion: 1.0.0')).toThrow('plugins')
    expect(() => parsePackManifest('name: A\ndescription: d\nversion: 1.0.0\nplugins: "x"')).toThrow('plugins')
    expect(() => parsePackManifest('name: A\ndescription: d\nversion: 1.0.0\nplugins: ["x"]')).toThrow('plugins[0]')
  })

  it('plugins 字段非法时抛错', () => {
    const base = 'name: A\ndescription: d\nversion: 1.0.0\nplugins:\n'
    expect(() => parsePackManifest(`${base}  - version: 1.0.0`)).toThrow('packageName')
    expect(() => parsePackManifest(`${base}  - packageName: "Bad Name"`)).toThrow('packageName')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    repository: "bad repo"`)).toThrow('repository')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    commit: "a..b"`)).toThrow('commit')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    subdirectory: "../evil"`)).toThrow('subdirectory')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    subdirectory: "a\\\\b"`)).toThrow('subdirectory')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    subdirectory: "/abs"`)).toThrow('subdirectory')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    source: "ftp"`)).toThrow('source')
    expect(() => parsePackManifest(`${base}  - packageName: alpha\n    version: "1.0"`)).toThrow('version')
  })

  it('serialize 之后能被 parse 读回（round-trip）', () => {
    const manifest: PackManifest = {
      name: 'Round',
      description: 'round trip',
      version: '3.1.4',
      author: 'me',
      plugins: [
        { packageName: 'alpha', repository: 'demo/alpha', source: 'github', commit: 'a'.repeat(40) },
        { packageName: '@scope/beta', source: 'npm', version: '0.1.2' },
      ],
    }
    expect(parsePackManifest(serializePackManifest(manifest))).toEqual(manifest)
  })
})

describe('buildManifestFromReceipts', () => {
  const receipts: PluginInstallReceipt[] = [
    {
      repository: 'demo/alpha',
      packageName: 'alpha',
      profileName: 'web',
      source: 'github',
      subdirectory: 'packages/alpha',
      version: '1.2.3',
      commit: 'abc1234',
      installedAt: '2026-08-16T00:00:00.000Z',
    },
    {
      repository: 'demo/beta',
      packageName: '@demo/beta',
      profileName: 'web',
      source: 'archive-subdirectory',
      subdirectory: null,
      version: null,
      commit: 'a'.repeat(40),
      installedAt: '2026-08-16T00:00:00.000Z',
    },
    {
      repository: 'demo/gamma',
      packageName: 'gamma',
      profileName: 'web',
      source: 'npm',
      subdirectory: null,
      version: '2.0.0',
      commit: '',
      installedAt: '2026-08-16T00:00:00.000Z',
    },
  ]

  it('由 packId 去前缀得到 name，逐条填充 plugins', () => {
    const manifest = buildManifestFromReceipts('pack-my-pack', receipts)
    expect(manifest.name).toBe('my-pack')
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.plugins).toEqual([
      {
        packageName: 'alpha',
        repository: 'demo/alpha',
        source: 'github',
        subdirectory: 'packages/alpha',
        commit: 'abc1234',
      },
      {
        packageName: '@demo/beta',
        repository: 'demo/beta',
        source: 'github',
        commit: 'a'.repeat(40),
      },
      { packageName: 'gamma', source: 'npm', version: '2.0.0' },
    ])
  })

  it('生成结果可通过 parsePackManifest 校验（可再导出）', () => {
    const manifest = buildManifestFromReceipts('pack-valid', receipts)
    expect(() => parsePackManifest(serializePackManifest(manifest))).not.toThrow()
  })

  it('buildManifestFromReceipts 可写入精确 DSH 版本', () => {
    const manifest = buildManifestFromReceipts('pack-versioned', receipts, [], [], [], '0.1.0-rc.7')
    expect(manifest.dshVersion).toBe('0.1.0-rc.7')
    expect(parsePackManifest(serializePackManifest(manifest), { requireDshVersion: true }).dshVersion).toBe('0.1.0-rc.7')
  })

  it('local-directory 源 receipt 映射为 source local（离线本体可再带出）', () => {
    const manifest = buildManifestFromReceipts('pack-x', [{
      repository: 'file:/some/path',
      packageName: 'alpha',
      profileName: 'pack-x',
      source: 'local-directory',
      subdirectory: null,
      version: '1.0.0',
      commit: '',
      installedAt: '2026-08-16T00:00:00.000Z',
    }])
    expect(manifest.plugins).toEqual([{ packageName: 'alpha', source: 'local', version: '1.0.0' }])
  })
})

describe('pack presets in manifest', () => {
  it('parse/serialize presets', () => {
    const yaml = `
name: Preset Pack
description: a pack with presets
version: 1.0.0
plugins:
  - packageName: alpha
presets:
  - name: router-standard
    repository: demo/preset-repo
    sourcePath: preset/router-standard
    revision: abc1234
`
    const manifest = parsePackManifest(yaml)
    expect(manifest.presets).toEqual([
      { name: 'router-standard', repository: 'demo/preset-repo', sourcePath: 'preset/router-standard', revision: 'abc1234' },
    ])
    const roundTrip = parsePackManifest(serializePackManifest(manifest))
    expect(roundTrip.presets).toEqual(manifest.presets)
  })

  it('buildManifestFromReceipts includes preset receipts', () => {
    const manifest = buildManifestFromReceipts('pack-x', [], [{
      name: 'router-standard',
      repository: 'demo/preset-repo',
      sourcePath: 'preset/router-standard',
      revision: 'abc1234',
      installedAt: '2026-08-16T00:00:00.000Z',
    }])
    expect(manifest.presets).toEqual([
      { name: 'router-standard', repository: 'demo/preset-repo', sourcePath: 'preset/router-standard', revision: 'abc1234' },
    ])
    expect(() => parsePackManifest(serializePackManifest(manifest))).not.toThrow()
  })

  it('parse/serialize skills and applications', () => {
    const yaml = `
name: Full Pack
description: all resource types
version: 1.0.0
plugins: []
skills:
  - name: git-workflow
    format: bundle
    repository: demo/skill-repo
    sourcePath: skills/git-workflow
    revision: abc1234
applications:
  - id: routing-app
    name: Routing App
    repository: demo/routing-app
    packageName: routing-app
    version: 1.0.0
    binName: routing
    launchMode: after-runtime
    launchArgs: ["--port", "3080"]
    provides: ["routing"]
`
    const manifest = parsePackManifest(yaml)
    expect(manifest.skills).toEqual([{
      name: 'git-workflow',
      format: 'bundle',
      repository: 'demo/skill-repo',
      sourcePath: 'skills/git-workflow',
      revision: 'abc1234',
    }])
    expect(manifest.applications).toEqual([{
      id: 'routing-app',
      name: 'Routing App',
      repository: 'demo/routing-app',
      packageName: 'routing-app',
      version: '1.0.0',
      binName: 'routing',
      launchMode: 'after-runtime',
      launchArgs: ['--port', '3080'],
      provides: ['routing'],
    }])
    const roundTrip = parsePackManifest(serializePackManifest(manifest))
    expect(roundTrip.skills).toEqual(manifest.skills)
    expect(roundTrip.applications).toEqual(manifest.applications)
  })
})
