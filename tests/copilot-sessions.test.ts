import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexEnvironment, createCopilotSessionManager } from '../electron/copilot-sessions'
import type { AiSession, AppSettings } from '../src/types'

const roots: string[] = []

describe('Codex child-process environment', () => {
  it('只保留运行所需变量并过滤 API key、token 与凭据变量', () => {
    const environment = codexEnvironment({
      Path: 'C:\\tools;C:\\Windows\\System32',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      CODEX_HOME: 'C:\\Users\\tester\\.codex',
      NODE_PATH: 'C:\\runtime\\node_modules',
      DEEPSEEK_API_KEY: 'deepseek-secret',
      OPENAI_API_KEY: 'openai-secret',
      GITHUB_TOKEN: 'github-secret',
      NPM_CONFIG_USERCONFIG: 'C:\\Users\\tester\\.npmrc',
      RANDOM_VALUE: 'do-not-copy',
    })

    expect(environment).toMatchObject({
      PATH: 'C:\\tools;C:\\Windows\\System32',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      CODEX_HOME: 'C:\\Users\\tester\\.codex',
      NODE_PATH: 'C:\\runtime\\node_modules',
      FORCE_COLOR: '0',
    })
    expect(environment).not.toHaveProperty('Path')
    expect(environment).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('GITHUB_TOKEN')
    expect(environment).not.toHaveProperty('NPM_CONFIG_USERCONFIG')
    expect(environment).not.toHaveProperty('RANDOM_VALUE')
  })

  it('不允许大小写变体绕过敏感变量过滤', () => {
    const environment = codexEnvironment({
      path: 'safe-path',
      oPeNaI_aPi_KeY: 'secret',
      x_custom_token: 'secret',
      temp: 'C:\\Temp',
    })
    expect(environment.PATH).toBe('safe-path')
    expect(environment.TEMP).toBe('C:\\Temp')
    expect(Object.keys(environment).some(key => /key|token/i.test(key))).toBe(false)
  })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-copilot-'))
  roots.push(root)
  const settings: AppSettings = {
    dshInstallPath: path.join(root, 'runtime'),
    dshHome: path.join(root, 'dsh-home'),
    profileName: 'web',
    workspace: root,
    launchExecutable: 'dsh',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: false,
    aiDeveloperMode: false,
    aiPrompt: '',
  }
  const filePath = path.join(root, 'sessions.json')
  const manager = createCopilotSessionManager({
    filePath,
    runtimeRoot: path.join(root, 'acp'),
    snapshotRoot: path.join(root, 'snapshots'),
    readSettings: async () => settings,
    readApiKey: async () => 'sk-test',
    prepareNodeRuntime: async () => { throw new Error('not used') },
    preparePnpmRuntime: async () => { throw new Error('not used') },
    emitEvent: () => undefined,
    emitOutput: () => undefined,
    mutationBlockReason: () => null,
  })
  return { root, filePath, manager }
}

describe('Copilot session persistence', () => {
  it('creates and restores multiple local sessions', async () => {
    const { filePath, manager } = await fixture()
    const first = await manager.create({ title: '分析插件' })
    const second = await manager.create({ title: '检查运行时' })
    expect((await manager.list()).map(item => item.id)).toEqual([second.id, first.id])

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as unknown[]
    expect(persisted).toHaveLength(2)
  })

  it('marks unfinished sessions interrupted after restart', async () => {
    const { filePath, manager } = await fixture()
    const timestamp = new Date().toISOString()
    const session: AiSession = {
      id: 'unfinished', kind: 'chat', title: '未完成分析', subject: null, phase: 'running',
      createdAt: timestamp, updatedAt: timestamp,
      queue: { position: null, total: 0, running: true, mutating: false },
      messageCount: 0, pendingApproval: null, hasSnapshot: false, messages: [],
    }
    await writeFile(filePath, JSON.stringify([{ session }]), 'utf8')
    const restored = (await manager.list())[0]
    expect(restored.phase).toBe('interrupted')
    expect(restored.backend).toBe('dsh')
  })

  it('persists the Codex backend and never exposes a DSH Profile snapshot', async () => {
    const { filePath, manager } = await fixture()
    const session = await manager.create({ backend: 'codex', title: 'Codex 对话' })

    expect(session.backend).toBe('codex')
    expect(session.hasSnapshot).toBe(false)
    await expect(manager.rollback(session.id)).rejects.toThrow('不提供 DSH Profile 快照回滚')

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ session: AiSession }>
    expect(persisted[0].session.backend).toBe('codex')
    expect(persisted[0].session.hasSnapshot).toBe(false)
  })


  it('deletes a settled session from the persistent index', async () => {
    const { manager } = await fixture()
    const session = await manager.create({ title: '临时会话' })
    await manager.remove(session.id)
    expect(await manager.list()).toEqual([])
  })

  it('send 携带 model 时把模型绑定并持久化到会话', async () => {
    const { filePath, manager } = await fixture()
    const session = await manager.create({ title: '模型测试' })
    await manager.send(session.id, '你好', 'ali|deepseek-v4-flash-0731')

    const updated = (await manager.list()).find(item => item.id === session.id)!
    expect(updated.model).toBe('ali|deepseek-v4-flash-0731')

    // 等后台分析收尾（fixture 的运行时准备会立即失败），再核对落盘内容。
    await new Promise(resolve => setTimeout(resolve, 30))
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ session: AiSession }>
    expect(persisted.find(item => item.session.id === session.id)?.session.model).toBe('ali|deepseek-v4-flash-0731')
  })

  it('setModel 绑定会话模型并支持清空回自动选择', async () => {
    const { manager } = await fixture()
    const session = await manager.create({ title: '模型测试' })
    const bound = await manager.setModel(session.id, 'ali|deepseek-v4-flash-0731')
    expect(bound.model).toBe('ali|deepseek-v4-flash-0731')
    expect((await manager.list()).find(item => item.id === session.id)?.model).toBe('ali|deepseek-v4-flash-0731')

    const cleared = await manager.setModel(session.id, null)
    expect(cleared.model).toBeNull()
    expect((await manager.list()).find(item => item.id === session.id)?.model).toBeNull()
  })

  it('setModel 拒绝不含 provider|model 分隔符的模型键', async () => {
    const { manager } = await fixture()
    const session = await manager.create({ title: '模型测试' })
    await expect(manager.setModel(session.id, 'nonsense')).rejects.toThrow('模型配置无效')
  })

  it('serializes legacy mutation tasks in FIFO order', async () => {
    const { manager } = await fixture()
    const first = await manager.beginLegacy('plugin-adaptation', '适配 A', 'plugin-a')
    const second = await manager.beginLegacy('runtime-repair', '修复 B', 'web')
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve })
    const firstRun = manager.runLegacy(first.id, async () => {
      order.push('first-start')
      markFirstStarted()
      await firstGate
      order.push('first-end')
    })
    const secondRun = manager.runLegacy(second.id, async () => {
      order.push('second-start')
      order.push('second-end')
    })
    await firstStarted
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([firstRun, secondRun])
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  })

  it('取消正在准备快照的任务后会立即让出写锁给下一个任务', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-copilot-mutation-cancel-'))
    roots.push(root)
    const settings: AppSettings = {
      dshInstallPath: path.join(root, 'runtime'),
      dshHome: path.join(root, 'dsh-home'),
      profileName: 'web',
      workspace: root,
      launchExecutable: 'dsh',
      launchArgs: ['web'],
      webPort: 3080,
      openAfterLaunch: false,
      aiDeveloperMode: false,
      aiPrompt: '',
    }
    let releaseSettings!: () => void
    let settingsStarted!: () => void
    const settingsGate = new Promise<void>(resolve => { releaseSettings = resolve })
    const started = new Promise<void>(resolve => { settingsStarted = resolve })
    let firstRead = true
    const manager = createCopilotSessionManager({
      filePath: path.join(root, 'sessions.json'),
      runtimeRoot: path.join(root, 'acp'),
      snapshotRoot: path.join(root, 'snapshots'),
      readSettings: async () => {
        if (firstRead) {
          firstRead = false
          settingsStarted()
          await settingsGate
        }
        return settings
      },
      readApiKey: async () => 'sk-test',
      prepareNodeRuntime: async () => { throw new Error('not used') },
      preparePnpmRuntime: async () => { throw new Error('not used') },
      emitEvent: () => undefined,
      emitOutput: () => undefined,
      mutationBlockReason: () => null,
    })
    const first = await manager.beginLegacy('plugin-adaptation', '适配 A', 'plugin-a')
    const second = await manager.beginLegacy('runtime-repair', '修复 B', 'profile-b')
    const order: string[] = []
    const firstRun = manager.runLegacy(first.id, async () => { order.push('first-start') })
      .then(() => null, error => error as Error)
    await started
    const secondRun = manager.runLegacy(second.id, async () => { order.push('second-start') })

    await manager.cancel(first.id)
    await expect(firstRun).resolves.toMatchObject({ message: '任务在修改队列中被取消。' })
    releaseSettings()
    await secondRun
    expect(order).toEqual(['second-start'])
    await manager.shutdown()
  })
})
