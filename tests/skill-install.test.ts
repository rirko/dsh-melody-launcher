import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { readInstalledSkills } from '../electron/skill-format'
import { installSkillFromDirectory, installSkillFromRepository } from '../electron/skill-install'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('installs only the selected skill bundle and preserves its resources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-install-'))
  temporaryRoots.push(root)
  const dshHome = path.join(root, 'home')
  const cacheRoot = path.join(root, 'cache')
  const commit = 'c'.repeat(40)
  const zip = new AdmZip()
  zip.addFile('skill-pack-main/academic/SKILL.md', Buffer.from('---\nname: academic\ndescription: Academic workflow.\n---\nUse the reference.\n'))
  zip.addFile('skill-pack-main/academic/references/guide.md', Buffer.from('# Guide\n'))
  zip.addFile('skill-pack-main/unrelated/file.txt', Buffer.from('do not install'))
  const archive = zip.toBuffer()
  // 见 skill-catalog.test.ts：Buffer 现在是泛型，不再是合法的 BodyInit。
  const fetchImpl = (async () => new Response(new Uint8Array(archive), {
    status: 200,
    headers: { 'content-length': String(archive.byteLength) },
  })) as typeof fetch

  const installed = await installSkillFromRepository(cacheRoot, dshHome, 'demo/skill-pack', {
    id: 'academic:academic/SKILL.md',
    name: 'academic',
    description: 'Academic workflow.',
    sourcePath: 'academic/SKILL.md',
    format: 'bundle',
    revision: commit,
    modelInvocable: true,
    userInvocable: true,
  }, () => undefined, fetchImpl)

  expect(installed.name).toBe('academic')
  expect(await readFile(path.join(dshHome, 'skills', 'academic', 'references', 'guide.md'), 'utf8')).toBe('# Guide\n')
  await expect(readFile(path.join(dshHome, 'skills', 'academic', 'unrelated', 'file.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readInstalledSkills(dshHome)).map(skill => skill.name)).toEqual(['academic'])
})

describe('installSkillFromDirectory', () => {
  // source 放 dshHome 内：真实流程 pack.ts 在 dshHome/.pack-raw-staging-* 解出（与 skills/ 同卷，rename 可用）。
  async function freshRoots(): Promise<{ dshHome: string; source: string; outside: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-skill-local-'))
    temporaryRoots.push(root)
    const dshHome = path.join(root, 'home')
    return {
      dshHome,
      source: path.join(dshHome, '.pack-raw-staging'),
      outside: path.join(root, 'outside'),
    }
  }

  it('bundle：整目录装入 skills/<name>/，清理冲突的 flat 变体与 .disabled 旧副本', async () => {
    const { dshHome, source } = await freshRoots()
    const bundleDir = path.join(source, 'guide')
    await mkdir(path.join(bundleDir, 'refs'), { recursive: true })
    await writeFile(path.join(bundleDir, 'SKILL.md'), '---\nname: guide\ndescription: A guide.\n---\nBody.\n')
    await writeFile(path.join(bundleDir, 'refs', 'x.md'), '# X\n')
    await mkdir(path.join(dshHome, 'skills'), { recursive: true })
    await writeFile(path.join(dshHome, 'skills', 'guide.md'), 'stale flat')
    await mkdir(path.join(dshHome, 'skills', '.disabled', 'guide'), { recursive: true })
    await writeFile(path.join(dshHome, 'skills', '.disabled', 'guide', 'SKILL.md'), 'stale bundle')

    const installed = await installSkillFromDirectory(dshHome, 'guide', 'bundle', bundleDir)
    expect(installed.name).toBe('guide')
    expect(installed.format).toBe('bundle')
    expect(await readFile(path.join(dshHome, 'skills', 'guide', 'SKILL.md'), 'utf8')).toContain('name: guide')
    expect(await readFile(path.join(dshHome, 'skills', 'guide', 'refs', 'x.md'), 'utf8')).toBe('# X\n')
    await expect(readFile(path.join(dshHome, 'skills', 'guide.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(dshHome, 'skills', '.disabled', 'guide', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('flat：装入 skills/<name>.md', async () => {
    const { dshHome, source } = await freshRoots()
    const flatFile = path.join(source, 'quick-ref.md')
    await mkdir(path.dirname(flatFile), { recursive: true })
    await writeFile(flatFile, '---\nname: quick-ref\ndescription: Quick ref.\n---\nBody.\n')

    const installed = await installSkillFromDirectory(dshHome, 'quick-ref', 'flat', flatFile)
    expect(installed.format).toBe('flat')
    expect(await readFile(path.join(dshHome, 'skills', 'quick-ref.md'), 'utf8')).toContain('name: quick-ref')
  })

  it('SKILL.md 的 name 与入参不一致时拒绝', async () => {
    const { dshHome, source } = await freshRoots()
    const bundleDir = path.join(source, 'other')
    await mkdir(bundleDir, { recursive: true })
    await writeFile(path.join(bundleDir, 'SKILL.md'), '---\nname: other\ndescription: Other.\n---\n')
    await expect(installSkillFromDirectory(dshHome, 'guide', 'bundle', bundleDir)).rejects.toThrow('不一致')
  })

  it('SKILL.md 缺失 / 非法名称 / 非法格式均拒绝', async () => {
    const { dshHome, source } = await freshRoots()
    const missingDir = path.join(source, 'missing')
    await mkdir(missingDir, { recursive: true })
    await expect(installSkillFromDirectory(dshHome, 'missing', 'bundle', missingDir)).rejects.toThrow('缺失或无效')
    await expect(installSkillFromDirectory(dshHome, 'NotValid', 'bundle', missingDir)).rejects.toThrow('无效')
    await expect(installSkillFromDirectory(dshHome, 'x', 'garbage' as never, missingDir)).rejects.toThrow('格式无效')
  })

  it('源在 dshHome 外时拒绝（防穿越）', async () => {
    const { dshHome, outside } = await freshRoots()
    const outsideDir = path.join(outside, 'guide')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(path.join(outsideDir, 'SKILL.md'), '---\nname: guide\ndescription: A guide.\n---\n')
    await expect(installSkillFromDirectory(dshHome, 'guide', 'bundle', outsideDir)).rejects.toThrow('超出')
  })
})

describe('skill install limits', () => {
  it('scales unpack and file budgets with the configured archive cap', async () => {
    const { skillInstallLimits } = await import('../electron/skill-install')
    expect(skillInstallLimits(undefined).archiveMb).toBe(64)
    const relaxed = skillInstallLimits(256)
    expect(relaxed.archiveBytes).toBe(256 * 1024 * 1024)
    expect(relaxed.unpackedBytes).toBe(1024 * 1024 * 1024)
    expect(relaxed.files).toBeGreaterThan(5000)
    expect(relaxed.archiveFiles).toBeGreaterThan(12000)
    expect(skillInstallLimits(8).archiveMb).toBe(16)
    expect(skillInstallLimits(9999).archiveMb).toBe(2048)
  })
})
