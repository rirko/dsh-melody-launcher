import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  DSH_SUBPROCESS_LOCAL_PACKAGE,
  dshScriptPackageManifest,
  ensureDshScriptPolicy,
  hasDshScriptPackage,
} from '../electron/dsh-script-policy'

describe('DSH npm lifecycle script policy', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dsh-script-policy-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('保留现有 package.json 字段并只放行 DSH 核心依赖', async () => {
    const manifest = path.join(root, 'package.json')
    await writeFile(manifest, JSON.stringify({
      name: 'dsh-launcher-runtime',
      private: true,
      dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.8' },
      allowScripts: { 'trusted-package': false },
    }))

    await ensureDshScriptPolicy(manifest)
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>
    expect(parsed.dependencies).toEqual({ '@deepseek-ai/dsh': '0.1.0-rc.8' })
    expect(parsed.allowScripts).toEqual({ 'trusted-package': false, [DSH_SUBPROCESS_LOCAL_PACKAGE]: true })
  })

  it('识别已安装的 DSH 核心依赖', async () => {
    const packageManifest = dshScriptPackageManifest(root)
    await mkdir(path.dirname(packageManifest), { recursive: true })
    await writeFile(packageManifest, '{}')
    expect(hasDshScriptPackage(root)).toBe(true)
  })
})
