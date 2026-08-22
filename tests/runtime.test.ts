import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createRuntimeController,
  extractLocalUrl,
  findAvailableWebPort,
  isDshWebLaunch,
  runtimeEnvironment,
  withDshWebPort,
} from '../electron/runtime'
import type { ApplicationLaunchPlan } from '../electron/application-addons'
import type { NodeRuntime } from '../electron/node-runtime'
import type { AppSettings } from '../src/types'

type WritableChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function fakeChild(pid: number): WritableChild {
  const child = new EventEmitter() as WritableChild
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  return child
}

function controllerSettings(): AppSettings {
  return {
    dshInstallPath: path.join(process.cwd(), 'dsh-runtime'),
    dshHome: path.join(process.cwd(), '.dsh'),
    profileName: 'web',
    workspace: process.cwd(),
    launchExecutable: 'dsh.cmd',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: true,
  }
}

function managedNode(): NodeRuntime {
  const root = path.join(process.cwd(), 'managed-node')
  return {
    root,
    node: path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
}

describe('extractLocalUrl', () => {
  it('picks up a loopback address with a port', () => {
    expect(extractLocalUrl('Server listening on http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
  })

  it('accepts localhost and a path', () => {
    expect(extractLocalUrl('open http://localhost:3000/workspace now')).toBe('http://localhost:3000/workspace')
  })

  it('accepts https and a bare host', () => {
    expect(extractLocalUrl('ready at https://localhost')).toBe('https://localhost')
  })

  it('ignores addresses that are not local', () => {
    expect(extractLocalUrl('docs at https://example.com/guide')).toBeNull()
  })

  it('returns null when there is no address at all', () => {
    expect(extractLocalUrl('compiling…')).toBeNull()
  })
})

describe('runtimeEnvironment', () => {
  const settings = {
    dshInstallPath: '/home/tester/.dsh-runtime',
    dshHome: '/home/tester/.dsh',
    profileName: 'web',
    workspace: '/home/tester/Documents',
    launchExecutable: 'npx',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: true,
  } satisfies AppSettings

  it('injects DSH_HOME and disables colored output', () => {
    const environment = runtimeEnvironment(settings, { PATH: '/usr/bin' })
    expect(environment.DSH_HOME).toBe('/home/tester/.dsh')
    expect(environment.FORCE_COLOR).toBe('0')
    expect(environment.PATH).toBe('/usr/bin')
  })

  it('overrides an inherited DSH_HOME', () => {
    expect(runtimeEnvironment(settings, { DSH_HOME: '/stale' }).DSH_HOME).toBe('/home/tester/.dsh')
  })
})

describe('DSH Web 端口', () => {
  it('识别直接调用和 npx 调用的 DSH Web 命令', () => {
    expect(isDshWebLaunch('/opt/dsh/dsh', ['web'])).toBe(true)
    expect(isDshWebLaunch('npx', ['--yes', '@deepseek-ai/dsh', 'web'])).toBe(true)
    expect(isDshWebLaunch('node', ['./server.js'])).toBe(false)
  })

  it('替换旧端口参数并保留其他参数', () => {
    expect(withDshWebPort('dsh.cmd', ['web', '--port', '4000', '--host', '127.0.0.1'], 3082)).toEqual([
      'web', '--host', '127.0.0.1', '--no-open', '--port', '3082',
    ])
    expect(withDshWebPort('npx', ['--yes', '@deepseek-ai/dsh', 'web', '--port=4000'], 3083)).toEqual([
      '--yes', '@deepseek-ai/dsh', 'web', '--no-open', '--port', '3083',
    ])
  })

  it('首选端口占用时选择后续端口', async () => {
    const checked: number[] = []
    const selected = await findAvailableWebPort(3080, 10, async port => {
      checked.push(port)
      return port === 3082
    })
    expect(selected).toBe(3082)
    expect(checked).toEqual([3080, 3081, 3082])
  })

  it('候选端口全部占用时返回 null', async () => {
    await expect(findAvailableWebPort(3080, 3, async () => false)).resolves.toBeNull()
  })

  it('在本机真实端口被监听时跳过该端口', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('未能取得测试端口。')
      const selected = await findAvailableWebPort(address.port, 10)
      expect(selected).not.toBeNull()
      expect(selected).not.toBe(address.port)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('应用加载项运行模式', () => {
  it('并发启动请求复用同一个启动流程', async () => {
    const settings = controllerSettings()
    const child = fakeChild(4150)
    const spawnProcess = vi.fn(() => child)
    const runtime = createRuntimeController({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => managedNode(),
      fallbackWorkspace: () => process.cwd(),
      emitOutput: () => {},
      emitState: () => {},
      openExternal: () => {},
      spawnProcess,
    })

    const [first, second] = await Promise.all([runtime.start(), runtime.start()])
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ running: true, pid: child.pid })
    expect(second).toMatchObject({ running: true, pid: child.pid })
    await runtime.stop()
  })

  it('使用替代宿主入口，并完全绕过设置中的 dsh web', async () => {
    const settings = controllerSettings()
    const nodeRuntime = managedNode()
    const replacementEntry = path.join(process.cwd(), 'addons', 'desktop', 'main.js')
    const child = fakeChild(4101)
    const spawnProcess = vi.fn((_executable: string, _args: string[]) => child)
    const stopProcess = vi.fn(async () => {})
    const openExternal = vi.fn()
    const plan: ApplicationLaunchPlan = {
      replacement: {
        id: 'dsh-desktop',
        name: 'DSH Desktop',
        mode: 'runtime-replacement',
        executable: nodeRuntime.node,
        args: [replacementEntry, '--tray'],
        cwd: settings.workspace,
      },
      companions: [],
    }
    const runtime = createRuntimeController({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => nodeRuntime,
      fallbackWorkspace: () => process.cwd(),
      emitOutput: () => {},
      emitState: () => {},
      openExternal,
      resolveApplicationLaunchPlan: async () => plan,
      spawnProcess,
      stopProcess,
    })

    const state = await runtime.start()
    expect(state).toMatchObject({
      running: true,
      launchMode: 'application-replacement',
      applicationAddonId: 'dsh-desktop',
      applicationAddonName: 'DSH Desktop',
      port: null,
    })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(spawnProcess.mock.calls[0][0]).toBe(nodeRuntime.node)
    expect(spawnProcess.mock.calls[0][1]).toEqual([replacementEntry, '--tray'])
    expect(spawnProcess.mock.calls[0][1]).not.toContain('web')

    child.stdout.write('ready at http://127.0.0.1:3080\n')
    expect(openExternal).not.toHaveBeenCalled()

    const stopped = await runtime.stop()
    expect(stopped.running).toBe(false)
    expect(stopProcess).toHaveBeenCalledWith(child)
  })

  it('Web 就绪后只启动一次伴随应用，并在停止时一起清理', async () => {
    const settings = {
      ...controllerSettings(),
      launchExecutable: path.join(process.cwd(), 'demo-server.exe'),
      launchArgs: ['serve'],
    }
    const main = fakeChild(4201)
    const companion = fakeChild(4202)
    const children = [main, companion]
    const spawnProcess = vi.fn((_executable: string, _args: string[]) => {
      const child = children.shift()
      if (!child) throw new Error('unexpected duplicate launch')
      return child
    })
    const stopProcess = vi.fn(async () => {})
    const openExternal = vi.fn()
    const runtime = createRuntimeController({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => managedNode(),
      fallbackWorkspace: () => process.cwd(),
      emitOutput: () => {},
      emitState: () => {},
      openExternal,
      resolveApplicationLaunchPlan: async () => ({
        replacement: null,
        companions: [{
          id: 'tray-helper',
          name: 'Tray Helper',
          mode: 'after-runtime',
          executable: managedNode().node,
          args: [path.join(process.cwd(), 'addons', 'tray', 'main.js')],
          cwd: settings.workspace,
        }],
      }),
      spawnProcess,
      stopProcess,
    })

    await runtime.start()
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    main.stdout.write('ready at http://127.0.0.1:3080\n')
    main.stdout.write('also at http://localhost:3081\n')

    expect(spawnProcess).toHaveBeenCalledTimes(2)
    // 同一次启动可能输出多个不同格式/端口的本地地址，但浏览器只自动打开一次。
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:3080')
    expect(spawnProcess.mock.calls[1][1]).toEqual([
      path.join(process.cwd(), 'addons', 'tray', 'main.js'),
    ])

    await runtime.stop()
    expect(stopProcess).toHaveBeenCalledTimes(2)
    expect(stopProcess).toHaveBeenCalledWith(main)
    expect(stopProcess).toHaveBeenCalledWith(companion)
  })

  it('未知 DSH 版本遇到凭据格式错误时只重试一次旧格式', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-runtime-fallback-'))
    const dshHome = path.join(root, 'dsh-home')
    const backupRoot = path.join(root, 'backup')
    await mkdir(dshHome, { recursive: true })
    await writeFile(path.join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  TEST_TOKEN: test-secret\n', 'utf8')
    try {
      const settings = { ...controllerSettings(), dshHome, dshVersion: null }
      const first = fakeChild(4301)
      const second = fakeChild(4302)
      const children = [first, second]
      const spawnProcess = vi.fn(() => {
        const child = children.shift()
        if (!child) throw new Error('unexpected duplicate launch')
        return child
      })
      const runtime = createRuntimeController({
        readSettings: async () => settings,
        prepareNodeRuntime: async () => managedNode(),
        fallbackWorkspace: () => process.cwd(),
        emitOutput: () => {},
        emitState: () => {},
        openExternal: () => {},
        spawnProcess,
        legacyCredentialsBackupRoot: backupRoot,
      })

      await runtime.start()
      first.stderr.write('credentials-local: the value for "version" in .credentials.yaml must be a string\n')
      first.emit('exit', 1)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(spawnProcess).toHaveBeenCalledTimes(2)
      expect(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')).not.toContain('version:')

      second.emit('exit', 0)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(await readFile(path.join(dshHome, '.credentials.yaml'), 'utf8')).toContain('version: 1')
      await new Promise(resolve => setTimeout(resolve, 150))
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
