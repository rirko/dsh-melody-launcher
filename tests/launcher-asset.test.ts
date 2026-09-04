import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearLauncherBackgrounds,
  importLauncherBackground,
  launcherAssetsDir,
  readLauncherBackground,
  sanitizeLauncherBackgroundName,
} from '../electron/launcher-asset'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempUserData(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-launcher-assets-'))
  tempRoots.push(root)
  return root
}

async function writeSourceImage(name: string, bytes: number): Promise<string> {
  const root = await tempUserData()
  const source = path.join(root, name)
  await writeFile(source, Buffer.alloc(bytes, 7))
  return source
}

describe('launcher background assets', () => {
  it('accepts only timestamped background filenames with whitelisted extensions', () => {
    expect(sanitizeLauncherBackgroundName('background-1756800000000.png')).toBe('background-1756800000000.png')
    expect(sanitizeLauncherBackgroundName('background-1756800000000.jpeg')).toBe('background-1756800000000.jpeg')
    expect(sanitizeLauncherBackgroundName('background-1756800000000.webp')).toBe('background-1756800000000.webp')
    expect(sanitizeLauncherBackgroundName('../settings.json')).toBeNull()
    expect(sanitizeLauncherBackgroundName('background-1.png')).toBeNull()
    expect(sanitizeLauncherBackgroundName('background-1756800000000.gif')).toBeNull()
    expect(sanitizeLauncherBackgroundName('background-1756800000000.png\\evil')).toBeNull()
    expect(sanitizeLauncherBackgroundName('sub/background-1756800000000.png')).toBeNull()
  })

  it('imports an image, returns a managed name, and prunes previous backgrounds', async () => {
    const userData = await tempUserData()
    const first = await importLauncherBackground(userData, await writeSourceImage('a.png', 1024))
    const second = await importLauncherBackground(userData, await writeSourceImage('b.jpg', 2048))
    expect(sanitizeLauncherBackgroundName(first)).toBe(first)
    expect(first.endsWith('.png')).toBe(true)
    expect(second.endsWith('.jpg')).toBe(true)
    await expect(stat(path.join(launcherAssetsDir(userData), first))).rejects.toThrow()
    await expect(stat(path.join(launcherAssetsDir(userData), second))).resolves.toBeTruthy()
  })

  it('rejects non-image extensions, empty files and oversized files', async () => {
    const userData = await tempUserData()
    await expect(importLauncherBackground(userData, await writeSourceImage('a.gif', 10))).rejects.toThrow('仅支持')
    await expect(importLauncherBackground(userData, await writeSourceImage('b.png', 0))).rejects.toThrow('为空')
    const oversized = await writeSourceImage('c.png', 8 * 1024 * 1024 + 1)
    await expect(importLauncherBackground(userData, oversized)).rejects.toThrow('8MB')
  })

  it('reads a stored background with its content type and refuses unknown names', async () => {
    const userData = await tempUserData()
    const name = await importLauncherBackground(userData, await writeSourceImage('a.png', 64))
    const asset = await readLauncherBackground(userData, name)
    expect(asset?.contentType).toBe('image/png')
    expect(asset?.body.length).toBe(64)
    expect(await readLauncherBackground(userData, '../settings.json')).toBeNull()
    expect(await readLauncherBackground(userData, 'background-9999999999999.png')).toBeNull()
  })

  it('clears all backgrounds on demand', async () => {
    const userData = await tempUserData()
    const name = await importLauncherBackground(userData, await writeSourceImage('a.png', 32))
    await clearLauncherBackgrounds(userData)
    expect(await readLauncherBackground(userData, name)).toBeNull()
    await expect(clearLauncherBackgrounds(userData)).resolves.toBeUndefined()
  })
})
