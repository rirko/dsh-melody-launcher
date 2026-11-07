import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeSnapshotZip,
  extractSnapshot,
  isSnapshotExcluded,
  looksLikeSnapshot,
  mapSnapshotPath,
  sanitizeProfileYaml,
  SNAPSHOT_META_FILENAME,
} from '../electron/pack-snapshot'

const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const META = {
  format: 1,
  platform: process.platform,
  exportedAt: '2026-09-20T00:00:00.000Z',
  links: [{ path: 'profiles/demo/node_modules/web-all-link', target: './@linxin666' }],
  excluded: ['.credentials.yaml'],
  warnings: [],
}

/** 构造一个最小但结构完整的快照包。 */
async function buildSnapshotZip(): Promise<string> {
  const zip = new AdmZip()
  zip.addFile(SNAPSHOT_META_FILENAME, Buffer.from(JSON.stringify(META)))
  zip.addFile('settings.yaml', Buffer.from('webPort: 8080\n'))
  zip.addFile('profiles/demo/profile.yaml', Buffer.from('name: demo\ndescription: ""\ndshVersion: 0.1.5-rc.2\nsource:\n  kind: local\n  path: C:/source/demo\nexportedAt: 2026-09-20T00:00:00.000Z\n'))
  zip.addFile('profiles/demo/package.json', Buffer.from(JSON.stringify({ name: 'dsh-profile-demo', private: true, dependencies: { '@linxin666/dsh-web-all': '^0.3.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@linxin666/dsh-web-all'] } } })))
  zip.addFile('profiles/demo/node_modules/@linxin666/dsh-web-all/package.json', Buffer.from(JSON.stringify({ name: '@linxin666/dsh-web-all', version: '0.3.0' })))
  zip.addFile('profiles/demo/node_modules/web-all', Buffer.from('placeholder-replaced-by-link'))
  zip.addFile('profiles/demo/node_modules/.modules.yaml', Buffer.from('store-dir: C:/pnpm/store\n'))
  zip.addFile('skills/officecli-docx/SKILL.md', Buffer.from('---\nname: officecli-docx\n---\ndoc skill\n'))
  zip.addFile('.credentials.yaml', Buffer.from('apiKey: secret\n'))
  const zipPath = path.join(await tempDir('snap-src-'), 'official-pack-v0.1.5-rc.2.1.zip')
  zip.writeZip(zipPath)
  return zipPath
}

describe('isSnapshotExcluded', () => {
  it('默认剔除隐私与临时目录；声明放行的类别可豁免', () => {
    expect(isSnapshotExcluded('.credentials.yaml')).toBe(true)
    expect(isSnapshotExcluded('.credentials.yaml', { credentials: true })).toBe(false)
    expect(isSnapshotExcluded('sessions/abc.json')).toBe(true)
    expect(isSnapshotExcluded('profiles/demo/node_modules/.modules.yaml')).toBe(true)
    expect(isSnapshotExcluded('skin-center/wallpapers/.cache/a.png')).toBe(true)
    expect(isSnapshotExcluded('debug.log')).toBe(true)
    expect(isSnapshotExcluded('skills/officecli-docx/SKILL.md')).toBe(false)
  })
})

describe('mapSnapshotPath', () => {
  it('profiles/<源id> 整体改名，其余原样', () => {
    expect(mapSnapshotPath('profiles/demo/profile.yaml', 'demo', 'my-pack')).toBe('profiles/my-pack/profile.yaml')
    expect(mapSnapshotPath('skills/a/SKILL.md', 'demo', 'my-pack')).toBe('skills/a/SKILL.md')
    expect(mapSnapshotPath('profiles/demo', 'demo', 'demo')).toBe('profiles/demo')
  })
})

describe('sanitizeProfileYaml', () => {
  it('改写 name、清空 exportedAt、去掉 source.path', () => {
    const out = sanitizeProfileYaml('name: demo\ndescription: ""\ndshVersion: 0.1.5\nsource:\n  kind: local\n  path: C:/x\nexportedAt: yesterday\n', 'my-pack')
    expect(out).toContain('name: my-pack')
    expect(out).toContain('exportedAt: null')
    expect(out).not.toContain('C:/x')
    expect(out).toContain('kind: local')
  })
})

describe('describeSnapshotZip', () => {
  it('识别快照包并读出源 id、DSH 版本与包内插件', async () => {
    const zipPath = await buildSnapshotZip()
    const info = describeSnapshotZip(zipPath)
    expect(info).not.toBeNull()
    expect(info?.profileId).toBe('demo')
    expect(info?.dshVersion).toBe('0.1.5-rc.2')
    expect(info?.pluginNames).toEqual(['@linxin666/dsh-web-all'])
    expect(info?.fileCount).toBeGreaterThan(0)
  })

  it('非快照包返回 null', async () => {
    const zip = new AdmZip()
    zip.addFile('random.txt', Buffer.from('x'))
    const zipPath = path.join(await tempDir('snap-no-'), 'r.zip')
    zip.writeZip(zipPath)
    expect(looksLikeSnapshot(new AdmZip(zipPath))).toBe(false)
    expect(describeSnapshotZip(zipPath)).toBeNull()
  })
})

describe('extractSnapshot', () => {
  it('解压到家目录：profile 改名、隐私剔除、链接重建、修正字段', async () => {
    const zipPath = await buildSnapshotZip()
    const home = await tempDir('snap-home-')
    const progress: Array<[number, number]> = []
    const result = await extractSnapshot(zipPath, home, {
      newId: 'my-pack',
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(result.profileId).toBe('my-pack')
    expect(result.links).toBe(1)
    expect(result.skipped).toBeGreaterThan(0)

    // profile 目录已改名且字段被修正。
    const profileYaml = await readFile(path.join(home, 'profiles', 'my-pack', 'profile.yaml'), 'utf8')
    expect(profileYaml).toContain('name: my-pack')
    expect(profileYaml).toContain('exportedAt: null')
    expect(profileYaml).not.toContain('C:/source/demo')
    const packageJson = JSON.parse(await readFile(path.join(home, 'profiles', 'my-pack', 'package.json'), 'utf8')) as { name?: string }
    expect(packageJson.name).toBe('dsh-profile-my-pack')

    // node_modules 本体与 skills 随包解出；隐私与 pnpm 元数据被剔除。
    expect(existsSync(path.join(home, 'profiles', 'my-pack', 'node_modules', '@linxin666', 'dsh-web-all', 'package.json'))).toBe(true)
    expect(existsSync(path.join(home, 'skills', 'officecli-docx', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(home, '.credentials.yaml'))).toBe(false)
    expect(existsSync(path.join(home, 'profiles', 'my-pack', 'node_modules', '.modules.yaml'))).toBe(false)

    // 符号链接按清单重建，指向包内真实文件。
    const linkPath = path.join(home, 'profiles', 'my-pack', 'node_modules', 'web-all-link')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    // junction 指向包内目录，目录里的内容可达。
    expect(existsSync(path.join(linkPath, 'dsh-web-all', 'package.json'))).toBe(true)

    // 进度回调覆盖到全部条目。
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1])
  })

  it('平台不符直接拒绝', async () => {
    const zipPath = await buildSnapshotZip()
    const zip = new AdmZip(zipPath)
    zip.updateFile(SNAPSHOT_META_FILENAME, Buffer.from(JSON.stringify({ ...META, platform: 'darwin' })))
    const patched = path.join(await tempDir('snap-plat-'), 'p.zip')
    zip.writeZip(patched)
    const home = await tempDir('snap-home2-')
    await expect(extractSnapshot(patched, home, { newId: 'x' })).rejects.toThrow(/darwin/)
  })
})

describe('快照分支不会误伤共享家目录', () => {
  it('顶层 settings.yaml 保留在解压结果中由调用方裁决，本模块不做家目录合并决策', async () => {
    // 结构性说明测试：extractSnapshot 只负责忠实解压到指定 home；
    // 统一 Profile 模型的「只取 profiles/<id> + skills」策略在 pack.ts 的快照分支里实现。
    const zipPath = await buildSnapshotZip()
    const staging = await tempDir('snap-staging-')
    await extractSnapshot(zipPath, staging, { newId: 'pack-a' })
    const topLevel = await readdir(staging)
    expect(topLevel).toContain('settings.yaml')
    expect(topLevel).toContain('profiles')
    expect(topLevel).toContain('skills')
  })
})
