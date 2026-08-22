import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isLegacyCredentialsFormatError,
  prepareLegacyCredentials,
  recoverLegacyCredentials,
} from '../electron/dsh-credentials-compat'

let root = ''
let dshHome = ''
let backupRoot = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-credential-compat-'))
  dshHome = path.join(root, 'dsh-home')
  backupRoot = path.join(root, 'backup')
  await mkdir(dshHome, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const modernCredentials = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: modern-secret\n  OTHER_TOKEN: other-secret\nrecords:\n  DEEPSEEK_API_KEY:\n    provider: local\n`

describe('legacy DSH credentials compatibility', () => {
  it('temporarily flattens refs and restores the versioned document', async () => {
    await writeFile(path.join(dshHome, '.credentials.yaml'), modernCredentials, 'utf8')

    const session = await prepareLegacyCredentials(dshHome, '0.1.0-rc.8', 'dsh.cmd', backupRoot)
    expect(session).not.toBeNull()
    const legacy = await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')
    expect(legacy).toContain('DEEPSEEK_API_KEY: modern-secret')
    expect(legacy).toContain('OTHER_TOKEN: other-secret')
    expect(legacy).not.toContain('version:')
    expect(legacy).not.toContain('records:')

    await session!.restore()
    const restored = await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')
    expect(restored).toContain('version: 1')
    expect(restored).toContain('DEEPSEEK_API_KEY: modern-secret')
    expect(restored).toContain('records:')
  })

  it('merges legacy changes back into refs without exposing secrets in errors', async () => {
    await writeFile(path.join(dshHome, '.credentials.yaml'), modernCredentials, 'utf8')
    const session = await prepareLegacyCredentials(dshHome, '0.1.0-rc.8', 'dsh.cmd', backupRoot)
    await writeFile(path.join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: changed-secret\nNEW_TOKEN: added-secret\n', 'utf8')

    await session!.restore()
    const restored = await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')
    expect(restored).toContain('DEEPSEEK_API_KEY: changed-secret')
    expect(restored).toContain('NEW_TOKEN: added-secret')
    expect(restored).toContain('records:')
  })

  it('does not rewrite modern DSH or malformed legacy documents', async () => {
    await writeFile(path.join(dshHome, '.credentials.yaml'), modernCredentials, 'utf8')
    expect(await prepareLegacyCredentials(dshHome, '0.1.1-rc.1', 'dsh.cmd', backupRoot)).toBeNull()
    expect(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')).toBe(modernCredentials)

    await writeFile(path.join(dshHome, '.credentials.yaml'), 'not: [a valid flat secret]\n', 'utf8')
    expect(await prepareLegacyCredentials(dshHome, '0.1.0-rc.8', 'dsh.cmd', backupRoot)).toBeNull()
  })

  it('allows the unknown-version fallback only for the credentials schema error', async () => {
    await writeFile(path.join(dshHome, '.credentials.yaml'), modernCredentials, 'utf8')
    const session = await prepareLegacyCredentials(dshHome, null, 'dsh.cmd', backupRoot, { force: true })
    expect(session).not.toBeNull()
    await session!.restore()

    expect(isLegacyCredentialsFormatError('credentials-local: the value for "version" in .credentials.yaml must be a string')).toBe(true)
    expect(isLegacyCredentialsFormatError('plugin tree failed: network timeout')).toBe(false)
  })

  it('detects the DSH version from an add-on entry inside pnpm virtual store', async () => {
    const entry = path.join(
      root,
      'runtime',
      'node_modules',
      '.pnpm',
      '@deepseek-ai+dsh-plugin-desktop@2.0.0_hash',
      'node_modules',
      'dsh-plugin-desktop',
      'lib',
      'bin.js',
    )
    const dshPackage = path.join(
      root,
      'runtime',
      'node_modules',
      '.pnpm',
      '@deepseek-ai+dsh@0.1.0-rc.6_hash',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'package.json',
    )
    await mkdir(path.dirname(entry), { recursive: true })
    await mkdir(path.dirname(dshPackage), { recursive: true })
    await writeFile(entry, '', 'utf8')
    await writeFile(dshPackage, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }), 'utf8')
    await writeFile(path.join(dshHome, '.credentials.yaml'), modernCredentials, 'utf8')

    const session = await prepareLegacyCredentials(dshHome, '0.1.1-rc.1', entry, backupRoot)
    expect(session).not.toBeNull()
    expect(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')).not.toContain('version:')
    await session!.restore()
  })

  it('recovers a session left by an interrupted launcher', async () => {
    await writeFile(path.join(dshHome, '.credentials.yaml'), modernCredentials, 'utf8')
    await prepareLegacyCredentials(dshHome, '0.1.0-rc.8', 'dsh.cmd', backupRoot)
    expect((await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8'))).not.toContain('version:')

    await recoverLegacyCredentials(backupRoot)
    const restored = await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')
    expect(restored).toContain('version: 1')
    expect(restored).toContain('records:')
  })
})
