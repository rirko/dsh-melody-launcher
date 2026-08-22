import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NODE_RUNTIME_VERSION,
  PNPM_VERSION,
  findManagedNodeRuntime,
  findManagedNodeRuntimes,
  findSystemNodeRuntime,
  managedNodeVersionRoot,
  nodeArchiveName,
  parseNodeArchiveChecksum,
  pnpmExecutable,
  requiresNodeRuntime,
  resolveNodeExecutable,
} from '../electron/node-runtime'

/** 当前平台上 node / npm / npx 的可执行文件名。 */
const EXECUTABLES = process.platform === 'win32'
  ? ['node.exe', 'npm.cmd', 'npx.cmd']
  : ['node', 'npm', 'npx']

/**
 * POSIX 的官方发行包把可执行文件放在 bin/ 下，Windows 的 zip 直接平铺在根目录。
 * 测试要按各自平台的真实布局造目录，否则测不出东西。
 */
const DISTRIBUTION_BIN = process.platform === 'win32' ? '.' : 'bin'

let temporaryDirectory = ''

async function makeTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-node-runtime-'))
  return temporaryDirectory
}

async function createExecutables(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const name of EXECUTABLES) {
    await writeFile(path.join(directory, name), '', 'utf8')
  }
}

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

describe('node runtime', () => {
  it('selects the official Windows archive for the current architecture', () => {
    expect(nodeArchiveName('x64')).toBe(`node-${NODE_RUNTIME_VERSION}-win-x64.zip`)
    expect(nodeArchiveName('arm64')).toBe(`node-${NODE_RUNTIME_VERSION}-win-arm64.zip`)
  })

  it('builds an archive name for an explicitly selected Node.js version', () => {
    expect(nodeArchiveName('v22.19.0', 'x64')).toBe('node-v22.19.0-win-x64.zip')
    expect(nodeArchiveName('22.19.0', 'arm64')).toBe('node-v22.19.0-win-arm64.zip')
  })

  it('reads the archive checksum from Node.js SHASUMS256.txt', () => {
    const archive = nodeArchiveName('x64')
    const checksum = 'a'.repeat(64)
    expect(parseNodeArchiveChecksum(`${'b'.repeat(64)}  other.zip\n${checksum}  ${archive}\n`, archive)).toBe(checksum)
    expect(parseNodeArchiveChecksum('', archive)).toBeNull()
  })

  it('maps npm and npx commands to absolute runtime executables', () => {
    const root = path.join('C:', 'portable-node')
    const runtime = {
      root,
      node: path.join(root, 'node.exe'),
      npm: path.join(root, 'npm.cmd'),
      npx: path.join(root, 'npx.cmd'),
      managed: true,
    }
    expect(resolveNodeExecutable('npx.cmd', runtime)).toBe(runtime.npx)
    // path.join 而不是硬编码反斜杠：反斜杠在 POSIX 上不是分隔符，
    // 硬编码会让这条断言只在 Windows 上成立。
    expect(resolveNodeExecutable(path.join('C:', 'old', 'npm.cmd'), runtime)).toBe(runtime.npm)
    expect(resolveNodeExecutable('custom.exe', runtime)).toBe('custom.exe')
  })

  it('keeps the managed pnpm executable in the launcher runtime directory', () => {
    const root = path.join('C:', 'dsh-launcher', 'pnpm-runtime')
    // .cmd 后缀只在 Windows 上存在；在 POSIX 上断言无扩展名的 pnpm，
    // 否则这条断言在 Linux CI 上必然失败。
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    expect(pnpmExecutable(root)).toBe(path.join(root, 'node_modules', '.bin', executable))
  })

  it('uses the current pnpm store format for managed plugin operations', () => {
    expect(PNPM_VERSION).toMatch(/^11\./)
  })

  it('detects commands that need Node.js on PATH', () => {
    expect(requiresNodeRuntime('npx.cmd', ['--yes', '@deepseek-ai/dsh', 'web'])).toBe(true)
    expect(requiresNodeRuntime(path.join('C:', 'runtime', 'dsh.cmd'), ['web'])).toBe(true)
    expect(requiresNodeRuntime('custom.exe', ['serve'])).toBe(false)
  })
})

/**
 * PATH 里的每一项本身就是 bin 目录，官方发行包的根目录在 POSIX 上还多一层 bin/。
 * 这两种布局曾经混用同一套拼接逻辑，导致 findSystemNodeRuntime
 * 在任何 POSIX 系统上都必然返回 null。
 */
describe('node runtime discovery', () => {
  it('finds a system runtime in a directory listed on PATH', async () => {
    const binDirectory = await makeTemporaryDirectory()
    await createExecutables(binDirectory)

    const found = findSystemNodeRuntime({
      PATH: binDirectory,
      // Windows 会优先看 Program Files\nodejs，指向不存在的位置以保证结果确定。
      ProgramFiles: path.join(binDirectory, 'absent'),
    })

    expect(found).not.toBeNull()
    expect(found?.managed).toBe(false)
    expect(found?.node).toBe(path.join(binDirectory, EXECUTABLES[0]))
    expect(found?.npm).toBe(path.join(binDirectory, EXECUTABLES[1]))
    expect(found?.npx).toBe(path.join(binDirectory, EXECUTABLES[2]))
  })

  it('skips PATH entries that only have some of the executables', async () => {
    const root = await makeTemporaryDirectory()
    const partial = path.join(root, 'partial')
    await mkdir(partial, { recursive: true })
    await writeFile(path.join(partial, EXECUTABLES[0]), '', 'utf8')

    expect(findSystemNodeRuntime({
      PATH: partial,
      ProgramFiles: path.join(root, 'absent'),
    })).toBeNull()
  })

  it('returns null when no PATH entry has a runtime', async () => {
    const root = await makeTemporaryDirectory()
    expect(findSystemNodeRuntime({
      PATH: path.join(root, 'nowhere'),
      ProgramFiles: path.join(root, 'absent'),
    })).toBeNull()
  })

  it('finds a managed runtime laid out as an extracted distribution', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    const distribution = path.join(runtimeRoot, `node-${NODE_RUNTIME_VERSION}-win-x64`)
    await createExecutables(path.join(distribution, DISTRIBUTION_BIN))

    const found = await findManagedNodeRuntime(runtimeRoot)

    expect(found).not.toBeNull()
    expect(found?.managed).toBe(true)
    expect(found?.root).toBe(distribution)
    expect(found?.npm).toBe(path.join(distribution, DISTRIBUTION_BIN, EXECUTABLES[1]))
  })

  it('prefers the newest managed distribution', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    for (const version of ['node-v20.0.0-win-x64', 'node-v24.19.0-win-x64']) {
      await createExecutables(path.join(runtimeRoot, version, DISTRIBUTION_BIN))
    }

    const found = await findManagedNodeRuntime(runtimeRoot)

    expect(found?.root).toBe(path.join(runtimeRoot, 'node-v24.19.0-win-x64'))
  })

  it('discovers launcher-managed versions under the versions directory', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    const selectedVersion = 'v22.19.0'
    const versionRoot = managedNodeVersionRoot(runtimeRoot, selectedVersion)
    await createExecutables(path.join(versionRoot, DISTRIBUTION_BIN))

    const versions = await findManagedNodeRuntimes(runtimeRoot)

    expect(versions).toHaveLength(1)
    expect(versions[0]?.version).toBe(selectedVersion)
    expect(versions[0]?.source).toBe('launcher')
    expect(versions[0]?.root).toBe(versionRoot)
    expect((await findManagedNodeRuntime(runtimeRoot, selectedVersion))?.root).toBe(versionRoot)
  })

  it('ignores an incomplete managed distribution', async () => {
    const runtimeRoot = await makeTemporaryDirectory()
    const distribution = path.join(runtimeRoot, 'node-v24.19.0-win-x64', DISTRIBUTION_BIN)
    await mkdir(distribution, { recursive: true })
    await writeFile(path.join(distribution, EXECUTABLES[0]), '', 'utf8')

    expect(await findManagedNodeRuntime(runtimeRoot)).toBeNull()
  })
})
