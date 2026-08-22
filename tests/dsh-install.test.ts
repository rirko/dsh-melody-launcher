import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DSH_REPOSITORY,
  findInstalledDsh,
  getManagedDshStatus,
  installWaitingMessage,
  isDshRepository,
  managedDshExecutable,
  packageManagerProgress,
} from '../electron/dsh-install'

let runtimeRoot = ''

beforeEach(async () => {
  runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-runtime-'))
})

afterEach(async () => {
  await rm(runtimeRoot, { recursive: true, force: true })
})

describe('managed DSH installation', () => {
  it('recognizes only the official repository as the DSH application', () => {
    expect(isDshRepository(DSH_REPOSITORY)).toBe(true)
    expect(isDshRepository('DeepSeek-AI/DeepSeek-Harness')).toBe(true)
    expect(isDshRepository('community/deepseek-harness')).toBe(false)
  })

  it('reports a missing or incomplete managed installation', async () => {
    await expect(getManagedDshStatus(runtimeRoot)).resolves.toEqual({
      installed: false,
      version: null,
      executable: null,
      source: null,
    })
  })

  it('returns the installed version and executable', async () => {
    const packageDirectory = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const executable = managedDshExecutable(runtimeRoot)
    await mkdir(packageDirectory, { recursive: true })
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }), 'utf8')
    await writeFile(executable, 'dsh', 'utf8')

    await expect(getManagedDshStatus(runtimeRoot)).resolves.toEqual({
      installed: true,
      version: '0.1.0-rc.6',
      executable,
      source: 'launcher',
    })
  })

  it('detects an official DSH installation from PATH', async () => {
    const systemRoot = path.join(runtimeRoot, 'system-bin')
    const executable = path.join(systemRoot, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    const packageDirectory = path.join(systemRoot, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(executable, 'dsh', 'utf8')
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }), 'utf8')

    await expect(findInstalledDsh({
      managedRoot: path.join(runtimeRoot, 'missing-managed'),
      environment: { PATH: systemRoot, ProgramFiles: path.join(runtimeRoot, 'missing-program-files') },
    })).resolves.toEqual({
      installed: true,
      version: '1.2.3',
      executable,
      source: 'system',
    })
  })

  it.runIf(process.platform === 'win32')('detects the Windows npm global directory without PATH', async () => {
    const appData = path.join(runtimeRoot, 'appdata')
    const npmRoot = path.join(appData, 'npm')
    const executable = path.join(npmRoot, 'dsh.cmd')
    const packageDirectory = path.join(npmRoot, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(executable, 'dsh', 'utf8')
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0' }), 'utf8')

    await expect(findInstalledDsh({
      managedRoot: path.join(runtimeRoot, 'missing-managed'),
      environment: {
        PATH: path.join(runtimeRoot, 'system32-only'),
        APPDATA: appData,
        ProgramFiles: path.join(runtimeRoot, 'missing-program-files'),
      },
    })).resolves.toEqual({
      installed: true,
      version: '2.0.0',
      executable,
      source: 'system',
    })
  })

  it('detects a pnpm global DSH installation from PNPM_HOME without PATH', async () => {
    const pnpmHome = path.join(runtimeRoot, 'pnpm-home')
    const executable = path.join(pnpmHome, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    const packageDirectory = path.join(pnpmHome, 'global', '5', 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(executable, 'dsh', 'utf8')
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.1.0' }), 'utf8')

    await expect(findInstalledDsh({
      managedRoot: path.join(runtimeRoot, 'missing-managed'),
      environment: {
        PATH: path.join(runtimeRoot, 'system32-only'),
        PNPM_HOME: pnpmHome,
        ProgramFiles: path.join(runtimeRoot, 'missing-program-files'),
      },
    })).resolves.toEqual({
      installed: true,
      version: '2.1.0',
      executable,
      source: 'system',
    })
  })

  it.runIf(process.platform === 'win32')('detects the default Windows pnpm home without PATH', async () => {
    const localAppData = path.join(runtimeRoot, 'local-appdata')
    const pnpmHome = path.join(localAppData, 'pnpm')
    const executable = path.join(pnpmHome, 'dsh.cmd')
    const packageDirectory = path.join(pnpmHome, 'global', '5', 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(executable, 'dsh', 'utf8')
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.2.0' }), 'utf8')

    await expect(findInstalledDsh({
      managedRoot: path.join(runtimeRoot, 'missing-managed'),
      environment: {
        PATH: path.join(runtimeRoot, 'system32-only'),
        LOCALAPPDATA: localAppData,
        ProgramFiles: path.join(runtimeRoot, 'missing-program-files'),
      },
    })).resolves.toEqual({
      installed: true,
      version: '2.2.0',
      executable,
      source: 'system',
    })
  })

  it('ignores unrelated executables named dsh', async () => {
    const systemRoot = path.join(runtimeRoot, 'unrelated-bin')
    const executable = path.join(systemRoot, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    await mkdir(systemRoot, { recursive: true })
    await writeFile(executable, 'not the official package', 'utf8')

    await expect(findInstalledDsh({
      managedRoot: path.join(runtimeRoot, 'missing-managed'),
      environment: { PATH: systemRoot, ProgramFiles: path.join(runtimeRoot, 'missing-program-files') },
    })).resolves.toEqual({ installed: false, version: null, executable: null, source: null })
  })

  it('turns package-manager and git output into bounded progress', () => {
    expect(packageManagerProgress('Progress: resolved 20, reused 5, downloaded 10, added 8', 30)).toEqual({
      percent: 66,
      message: '正在下载：10 个新包，5 个已复用',
    })
    expect(packageManagerProgress('Receiving objects: 50% (100/200)', 20)).toEqual({
      percent: 53,
      message: '正在下载仓库 50%',
    })
    expect(packageManagerProgress('added 104 packages in 8s', 40)).toEqual({
      percent: 82,
      message: '下载完成，正在安装依赖',
    })
    expect(packageManagerProgress('npm http fetch GET 200 https://registry.npmjs.org/react', 28)).toEqual({
      percent: 35,
      message: '正在解析 npm 依赖（已请求 1 项）',
      indeterminate: true,
    })
    expect(packageManagerProgress('npm http fetch GET 200 https://registry.npmjs.org/one\nnpm http fetch GET 200 https://registry.npmjs.org/two', 35, 1)).toEqual({
      percent: 37,
      message: '正在解析 npm 依赖（已请求 3 项）',
      indeterminate: true,
    })
    expect(packageManagerProgress('npm silly placeDep ROOT demo@1.0.0 OK', 50)).toEqual({
      percent: 78,
      message: '正在整理 npm 依赖（已整理 1 项）',
    })
    expect(packageManagerProgress(
      'npm silly placeDep ROOT one@1.0.0 OK\nnpm silly placeDep ROOT two@1.0.0 OK',
      78,
      0,
      24,
    )).toEqual({
      percent: 79,
      message: '正在整理 npm 依赖（已整理 26 项）',
    })
    expect(packageManagerProgress(
      'npm http fetch GET 200 https://registry.npmjs.org/one\nnpm silly placeDep ROOT one@1.0.0 OK',
      35,
    )).toEqual({
      percent: 78,
      message: '正在整理 npm 依赖（已整理 1 项）',
    })
  })

  it('shows elapsed time while npm has no measurable progress', () => {
    expect(installWaitingMessage('正在下载并安装 DSH', 4_999)).toBe('正在下载并安装 DSH')
    expect(installWaitingMessage('正在下载并安装 DSH', 5_000)).toBe('安装中 · 已等待 5 秒')
    expect(installWaitingMessage('正在下载并安装 DSH', 65_999)).toBe('安装中 · 已等待 65 秒')
  })
})
