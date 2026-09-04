import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isSafePackageName,
  isSafeProfileName,
  isSafeRepositoryName,
  readProfile,
  removePluginFromProfile,
  removeUnusedSharedPluginBodies,
  repositoryFullNameFromSpecifier,
  reorderPlugins,
  togglePlugin,
} from '../electron/profile'
import { recordPluginInstall } from '../electron/plugin-receipts'

let temporaryHome = ''
const profileName = 'web'

async function seedProfile(): Promise<string> {
  const profileDir = path.join(temporaryHome, 'profiles', profileName)
  await mkdir(path.join(profileDir, 'node_modules', '@demo', 'vision'), { recursive: true })
  await mkdir(path.join(profileDir, 'node_modules', '@demo', 'sidebar'), { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: {
      '@demo/vision': 'github:demo/vision#abc123',
      '@demo/sidebar': '2.0.0',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@demo/vision'],
      },
    },
  }, null, 2))
  await writeFile(path.join(profileDir, 'pnpm-lock.yaml'), [
    'lockfileVersion: \'9.0\'',
    'importers:',
    '  .:',
    '    dependencies:',
    '      \'@demo/vision\': github:demo/vision#abc123',
    '      \'@demo/sidebar\': 2.0.0',
    '',
  ].join('\n'))
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'vision', 'package.json'), JSON.stringify({
    name: '@demo/vision',
    version: '1.2.0',
    description: 'Vision tools',
    repository: { url: 'git+https://github.com/demo/vision.git' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'sidebar', 'package.json'), JSON.stringify({
    name: '@demo/sidebar',
    version: '2.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'vision', 'cordis.patch.yml'), '[]\n')
  await writeFile(path.join(profileDir, 'node_modules', '@demo', 'sidebar', 'cordis.patch.yml'), '[]\n')
  return profileDir
}

beforeEach(async () => {
  temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-test-'))
})

afterEach(async () => {
  await rm(temporaryHome, { recursive: true, force: true })
})

describe('profile management', () => {
  it('reads active and inactive bundles from the official profile manifest', async () => {
    await seedProfile()
    const state = await readProfile(temporaryHome, profileName)

    expect(state.initialized).toBe(true)
    expect(state.activeBundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@demo/vision',
    ])
    expect(state.plugins.find(plugin => plugin.packageName === '@demo/vision')).toMatchObject({
      enabled: true,
      version: '1.2.0',
      repositoryFullName: 'demo/vision',
      compatible: true,
    })
    expect(state.plugins.find(plugin => plugin.packageName === '@demo/sidebar')).toMatchObject({
      enabled: false,
      compatible: true,
    })
  })

  it('exposes the shared plugin pool in every Profile and activates a sibling-only plugin locally', async () => {
    await seedProfile()
    const desktopDir = path.join(temporaryHome, 'profiles', 'desktop')
    await mkdir(desktopDir, { recursive: true })
    await writeFile(path.join(desktopDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2))

    const before = await readProfile(temporaryHome, 'desktop')
    expect(before.plugins.find(plugin => plugin.packageName === '@demo/vision')).toMatchObject({
      enabled: false,
      declaredInProfile: false,
      compatible: true,
    })

    const enabled = await togglePlugin(temporaryHome, 'desktop', '@demo/vision', true)
    expect(enabled.plugins.find(plugin => plugin.packageName === '@demo/vision')).toMatchObject({
      enabled: true,
      declaredInProfile: true,
      compatible: true,
    })
    const manifest = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@demo/vision']).toBe('github:demo/vision#abc123')
  })

  it('uses the current Profile exact version when a sibling has another version', async () => {
    const webDir = path.join(temporaryHome, 'profiles', 'web')
    const desktopDir = path.join(temporaryHome, 'profiles', 'desktop')
    await mkdir(webDir, { recursive: true })
    await mkdir(path.join(desktopDir, 'node_modules', '@demo', 'versioned'), { recursive: true })
    await writeFile(path.join(webDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { '@demo/versioned': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }), 'utf8')
    await writeFile(path.join(desktopDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: { '@demo/versioned': '2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@demo/versioned'] } },
    }), 'utf8')
    await writeFile(path.join(desktopDir, 'node_modules', '@demo', 'versioned', 'package.json'), JSON.stringify({
      name: '@demo/versioned', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(path.join(desktopDir, 'node_modules', '@demo', 'versioned', 'cordis.patch.yml'), '[]\n')
    const sharedV1 = path.join(temporaryHome, '.dsh-launcher-plugin-bodies', '@demo', 'versioned', '1.0.0')
    await mkdir(sharedV1, { recursive: true })
    await writeFile(path.join(sharedV1, 'package.json'), JSON.stringify({
      name: '@demo/versioned', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(path.join(sharedV1, 'cordis.patch.yml'), '[]\n')

    const web = await readProfile(temporaryHome, 'web')
    expect(web.plugins.find(plugin => plugin.packageName === '@demo/versioned')).toMatchObject({ version: '1.0.0' })
  })

  it('toggles third-party plugins without removing their dependency', async () => {
    const profileDir = await seedProfile()
    const disabled = await togglePlugin(temporaryHome, profileName, '@demo/vision', false)
    expect(disabled.activeBundles).not.toContain('@demo/vision')
    expect(disabled.plugins.find(plugin => plugin.packageName === '@demo/vision')?.enabled).toBe(false)

    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@demo/vision']).toBe('github:demo/vision#abc123')

    const enabled = await togglePlugin(temporaryHome, profileName, '@demo/sidebar', true)
    expect(enabled.activeBundles.at(-1)).toBe('@demo/sidebar')
  })

  it('removes a plugin locally without resolving unrelated Git dependencies', async () => {
    const profileDir = await seedProfile()
    expect(await removePluginFromProfile(temporaryHome, profileName, '@demo/vision')).toBe(true)

    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@demo/vision']).toBeUndefined()
    expect(manifest.dsh.profile.bundles).not.toContain('@demo/vision')
    const lock = await readFile(path.join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).not.toContain("'@demo/vision'")
    expect(lock).toContain('@demo/sidebar')
    await expect(readFile(path.join(profileDir, 'node_modules', '@demo', 'vision', 'package.json'))).rejects.toThrow()
  })

  it('removes legacy references from every package.json dependency section', async () => {
    const profileDir = path.join(temporaryHome, 'profiles', profileName)
    await mkdir(profileDir, { recursive: true })
    await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      devDependencies: { '@demo/vision': '1.0.0', 'keep-dev': '1.0.0' },
      optionalDependencies: { '@demo/vision': '1.0.0' },
      peerDependencies: { '@demo/vision': '^1.0.0' },
      dsh: { profile: { bundles: [] } },
    }, null, 2))

    expect(await removePluginFromProfile(temporaryHome, profileName, '@demo/vision')).toBe(true)

    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.devDependencies).toEqual({ 'keep-dev': '1.0.0' })
    expect(manifest.optionalDependencies).toBeUndefined()
    expect(manifest.peerDependencies).toBeUndefined()
  })

  it('removes a stale direct link when a legacy Profile has no manifest', async () => {
    const profileDir = path.join(temporaryHome, 'profiles', profileName)
    const directPackage = path.join(profileDir, 'node_modules', '@demo', 'vision')
    await mkdir(directPackage, { recursive: true })
    await writeFile(path.join(directPackage, 'stale.txt'), 'leftover')

    expect(await removePluginFromProfile(temporaryHome, profileName, '@demo/vision')).toBe(true)
    await expect(readFile(path.join(directPackage, 'stale.txt'))).rejects.toThrow()
  })

  it('removes shared plugin bodies only after no Profile still declares the package', async () => {
    await seedProfile()
    const sharedBody = path.join(temporaryHome, '.dsh-launcher-plugin-bodies', '@demo', 'vision', '1.2.0')
    await mkdir(sharedBody, { recursive: true })
    await writeFile(path.join(sharedBody, 'package.json'), JSON.stringify({ name: '@demo/vision', version: '1.2.0' }))

    expect(await removeUnusedSharedPluginBodies(temporaryHome, '@demo/vision')).toBe(false)
    await removePluginFromProfile(temporaryHome, profileName, '@demo/vision')
    expect(await removeUnusedSharedPluginBodies(temporaryHome, '@demo/vision')).toBe(true)
    await expect(readFile(path.join(sharedBody, 'package.json'))).rejects.toThrow()
  })

  it('removes a pnpm virtual-store package directory without touching sibling packages', async () => {
    const profileDir = await seedProfile()
    const virtualRoot = path.join(profileDir, 'node_modules', '.pnpm')
    const targetPhysical = path.join(virtualRoot, '@demo+vision@1.2.0', 'node_modules', '@demo', 'vision')
    const siblingPhysical = path.join(virtualRoot, '@demo+sidebar@2.0.0', 'node_modules', '@demo', 'sidebar')
    await mkdir(targetPhysical, { recursive: true })
    await mkdir(siblingPhysical, { recursive: true })
    await writeFile(path.join(targetPhysical, 'package.json'), '{}')
    await writeFile(path.join(siblingPhysical, 'package.json'), '{}')
    const directTarget = path.join(profileDir, 'node_modules', '@demo', 'vision')
    await rm(directTarget, { recursive: true, force: true })
    try {
      await symlink(targetPhysical, directTarget, 'junction')
    } catch {
      // Some Windows CI workers disable junction creation. The rest of the
      // uninstall suite still covers the manifest/link fallback in that case.
      return
    }

    await removePluginFromProfile(temporaryHome, profileName, '@demo/vision')

    await expect(readFile(path.join(targetPhysical, 'package.json'))).rejects.toThrow()
    await expect(readFile(path.join(siblingPhysical, 'package.json'), 'utf8')).resolves.toBe('{}')
    await expect(realpath(directTarget)).rejects.toThrow()
  })

  it('uses the install receipt when a local file dependency has no repository field', async () => {
    await seedProfile()
    const receiptPath = path.join(temporaryHome, 'plugin-installs.json')
    await recordPluginInstall(receiptPath, {
      repository: 'demo/sidebar',
      packageName: '@demo/sidebar',
      profileName,
      source: 'archive-subdirectory',
      subdirectory: 'sidebar',
      version: '2.0.0',
      commit: 'abc123',
      installedAt: new Date().toISOString(),
    })

    const state = await readProfile(temporaryHome, profileName, receiptPath)
    expect(state.plugins.find(plugin => plugin.packageName === '@demo/sidebar')).toMatchObject({
      repositoryFullName: 'demo/sidebar',
      repository: 'https://github.com/demo/sidebar',
    })
  })

  it('persists an exact load order and protects core layers', async () => {
    await seedProfile()
    const reordered = await reorderPlugins(temporaryHome, profileName, [
      '@deepseek-ai/dsh-base',
      '@demo/vision',
      '@deepseek-ai/dsh-web-app',
    ])
    expect(reordered.activeBundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@demo/vision',
      '@deepseek-ai/dsh-web-app',
    ])
    await expect(togglePlugin(temporaryHome, profileName, '@deepseek-ai/dsh-base', false))
      .rejects.toThrow('核心组合层不能停用')
  })
})

describe('external input validation', () => {
  it('accepts normal names and rejects command-like input', () => {
    expect(isSafeProfileName('web-dev_2')).toBe(true)
    expect(isSafeProfileName('../web')).toBe(false)
    expect(isSafeRepositoryName('owner/dsh-plugin')).toBe(true)
    expect(isSafeRepositoryName('owner/repo && whoami')).toBe(false)
    expect(isSafePackageName('@scope/plugin-name')).toBe(true)
    expect(isSafePackageName('plugin; Remove-Item')).toBe(false)
  })

  it('recognizes GitHub dependency and codeload repository specifiers', () => {
    expect(repositoryFullNameFromSpecifier('github:anywhere-labs/deepseek-harness-desktop')).toBe('anywhere-labs/deepseek-harness-desktop')
    expect(repositoryFullNameFromSpecifier('https://codeload.github.com/Small-tailqwq/dsh-deep-whale/tar.gz/abc123')).toBe('Small-tailqwq/dsh-deep-whale')
    expect(repositoryFullNameFromSpecifier('git+https://github.com/demo/sidebar/tree/main/packages/plugin')).toBe('demo/sidebar')
    expect(repositoryFullNameFromSpecifier('1.2.0')).toBeUndefined()
  })
})
