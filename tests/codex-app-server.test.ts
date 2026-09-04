import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import {
  createCodexAppServerClient,
  createCodexAppServerTransport,
  type CodexAppServerMessage,
  type CodexAppServerTransport,
} from '../electron/codex-app-server'
import { describe, expect, it } from 'vitest'

function transportFixture() {
  let messageHandler: (message: CodexAppServerMessage) => void = () => undefined
  let closeHandler: (error?: Error) => void = () => undefined
  const sent: CodexAppServerMessage[] = []
  const transport: CodexAppServerTransport = {
    send(message) { sent.push(message) },
    onMessage(handler) { messageHandler = handler },
    onClose(handler) { closeHandler = handler },
    close() { closeHandler() },
  }
  return { transport, sent, receive: (message: CodexAppServerMessage) => messageHandler(message) }
}

describe('Codex App Server client', () => {
  it('notifies a late close subscriber when the child exits during setup', () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams
    const transport = createCodexAppServerTransport(child)
    child.emit('exit', 1)

    let closeError: Error | undefined
    transport.onClose(error => { closeError = error })
    expect(closeError?.message).toContain('退出')
    expect(() => transport.send({ method: 'turn/start' })).toThrow('退出')
    transport.close()
  })

  it('rejects pending requests when stdout reaches EOF before child exit', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams
    const transport = createCodexAppServerTransport(child)
    const client = createCodexAppServerClient({ transport })
    const pending = client.request('model/list', {})

    // A wrapper can leave the process alive after closing its protocol pipe.
    // EOF must still release the request instead of waiting for the exit event.
    child.stdout.emit('end')
    await expect(pending).rejects.toThrow('连接已关闭')
    client.close()
  })

  it('rejects pending requests when the child exits unexpectedly with code zero', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams
    const transport = createCodexAppServerTransport(child)
    const client = createCodexAppServerClient({ transport })
    const pending = client.request('turn/start', {})

    child.emit('exit', 0)

    await expect(pending).rejects.toThrow('连接已关闭')
    expect(() => transport.send({ method: 'turn/start' })).toThrow('连接已关闭')
    client.close()
  })

  it('rejects pending requests when stdin reports an asynchronous write error', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcessWithoutNullStreams
    const transport = createCodexAppServerTransport(child)
    const client = createCodexAppServerClient({ transport })
    const pending = client.request('model/list', {})

    // Writable streams commonly report EPIPE on a later tick, after write()
    // itself returned.  The transport's error listener must still close the
    // client and release the request.
    child.stdin.emit('error', new Error('broken pipe'))
    await expect(pending).rejects.toThrow('broken pipe')
    client.close()
  })

  it('performs initialize, thread/start and turn/start without jsonrpc headers', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({ transport: fixture.transport })

    const initialize = client.initialize()
    const initializeRequest = fixture.sent[0]
    expect(initializeRequest).toMatchObject({ id: 1, method: 'initialize' })
    expect(initializeRequest).not.toHaveProperty('jsonrpc')
    fixture.receive({ id: 1, result: { userAgent: 'Codex test' } })
    await expect(initialize).resolves.toMatchObject({ userAgent: 'Codex test' })
    expect(fixture.sent[1]).toEqual({ method: 'initialized', params: {} })

    const threadPromise = client.threadStart('C:\\workspace')
    fixture.receive({ id: 2, result: { thread: { id: 'thread-1' } } })
    await expect(threadPromise).resolves.toMatchObject({ thread: { id: 'thread-1' } })

    const turnPromise = client.turnStart('thread-1', '检查项目')
    expect(fixture.sent[3]).toMatchObject({
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [{ type: 'text', text: '检查项目', text_elements: [] }] },
    })
    fixture.receive({ id: 3, result: { turn: { id: 'turn-1' } } })
    await expect(turnPromise).resolves.toMatchObject({ turn: { id: 'turn-1' } })
  })

  it('maps legacy additional directories to Codex runtime workspace roots', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({ transport: fixture.transport })

    const threadPromise = client.threadStart('C:\\workspace', {
      additionalDirectories: ['C:\\dsh-home', 'C:\\workspace'],
    })
    expect(fixture.sent[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: 'C:\\workspace',
        runtimeWorkspaceRoots: ['C:\\workspace', 'C:\\dsh-home'],
      },
    })
    expect(fixture.sent[0].params).not.toHaveProperty('additionalDirectories')
    fixture.receive({ id: 1, result: { thread: { id: 'thread-1' } } })
    await threadPromise

    const turnPromise = client.turnStart('thread-1', '检查', {
      additionalDirectories: ['C:\\dsh-home'],
      cwd: 'C:\\workspace',
    })
    expect(fixture.sent[1]).toMatchObject({
      method: 'turn/start',
      params: {
        runtimeWorkspaceRoots: ['C:\\workspace', 'C:\\dsh-home'],
      },
    })
    expect(fixture.sent[1].params).not.toHaveProperty('additionalDirectories')
    fixture.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turnPromise
    client.close()
  })

  it('uses a read-only sandbox by default so writes go through host approval', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({ transport: fixture.transport })

    const threadPromise = client.threadStart('C:\\workspace')
    expect(fixture.sent[0]).toMatchObject({
      method: 'thread/start',
      params: { approvalPolicy: 'on-request', sandbox: 'read-only' },
    })
    fixture.receive({ id: 1, result: { thread: { id: 'thread-1' } } })
    await threadPromise

    const turnPromise = client.turnStart('thread-1', '修改文件')
    expect(fixture.sent[1]).toMatchObject({
      method: 'turn/start',
      params: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    })
    fixture.receive({ id: 2, result: { turn: { id: 'turn-1' } } })
    await turnPromise
    client.close()
  })

  it('routes streamed notifications and command approvals', async () => {
    const fixture = transportFixture()
    const events: string[] = []
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      onAgentMessage: event => events.push(`agent:${event.text}`),
      onReasoning: event => events.push(`reasoning:${event.text}`),
      onCommandOutput: event => events.push(`command:${event.text}`),
      onApprovalRequest: request => {
        events.push(`approval:${request.kind}`)
        return 'accept'
      },
    })
    fixture.receive({ method: 'item/agentMessage/delta', params: { delta: 'hello' } })
    fixture.receive({ method: 'item/reasoning/summaryTextDelta', params: { delta: 'thinking' } })
    fixture.receive({ method: 'item/commandExecution/outputDelta', params: { delta: 'output' } })
    fixture.receive({ id: 44, method: 'item/commandExecution/requestApproval', params: { itemId: 'exec-1' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(events).toEqual(['agent:hello', 'reasoning:thinking', 'command:output', 'approval:command'])
    expect(fixture.sent.at(-1)).toEqual({ id: 44, result: { decision: 'accept' } })
    client.close()
  })

  it('returns the requested permission profile for a legacy accept decision', async () => {
    const fixture = transportFixture()
    const requests: unknown[] = []
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      onApprovalRequest: request => {
        requests.push(request)
        return 'accept'
      },
    })
    fixture.receive({
      id: 45,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permissions-1',
        environmentId: null,
        startedAtMs: 123,
        cwd: 'C:\\workspace',
        reason: '需要网络和工作区写权限',
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ['C:\\workspace'], write: ['C:\\workspace\\out'], entries: [] },
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect((requests[0] as { kind: string; requestedPermissions: unknown }).kind).toBe('permissions')
    expect((requests[0] as { requestedPermissions: unknown }).requestedPermissions).toMatchObject({ network: { enabled: true } })
    expect(fixture.sent.at(-1)).toEqual({
      id: 45,
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ['C:\\workspace'], write: ['C:\\workspace\\out'], entries: [] },
        },
        scope: 'turn',
        strictAutoReview: false,
      },
    })
    client.close()
  })

  it('normalizes renderer responses and clamps grants to requested permissions', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      onRequest: request => {
        client.respond(request.id, {
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ['C:\\workspace', 'C:\\outside'],
              write: ['C:\\outside'],
              entries: [
                { path: { type: 'path', path: 'C:\\workspace\\out' }, access: 'write' },
                { path: { type: 'path', path: 'C:\\outside' }, access: 'write' },
              ],
            },
          },
          scope: 'session',
          unexpected: 'dropped',
        })
      },
    })
    fixture.receive({
      id: 'permission-request',
      method: 'item/permissions/requestApproval',
      params: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ['C:\\workspace'],
            write: ['C:\\workspace\\out'],
            entries: [{ path: { type: 'path', path: 'C:\\workspace\\out' }, access: 'write' }],
          },
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fixture.sent.at(-1)).toEqual({
      id: 'permission-request',
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ['C:\\workspace'],
            write: [],
            entries: [{ path: { type: 'path', path: 'C:\\workspace\\out' }, access: 'write' }],
          },
        },
        scope: 'session',
      },
    })
    client.close()
  })

  it('fails closed for declined or missing permission approvals', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({ transport: fixture.transport })
    fixture.receive({
      id: 46,
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: { enabled: true }, fileSystem: null } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.sent.at(-1)).toEqual({
      id: 46,
      result: { permissions: {}, scope: 'turn', strictAutoReview: true },
    })
    client.close()
  })

  it('returns an error when a custom server-request handler throws', async () => {
    const fixture = transportFixture()
    const protocolErrors: Error[] = []
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      onRequest: async () => { throw new Error('handler failed') },
      onProtocolError: error => protocolErrors.push(error),
    })
    fixture.receive({ id: 99, method: 'item/tool/requestUserInput', params: {} })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fixture.sent.at(-1)).toEqual({ id: 99, error: { code: -32603, message: 'handler failed' } })
    expect(protocolErrors.some(error => error.message === 'handler failed')).toBe(true)
    client.close()
  })

  it('rejects pending requests when closed', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({ transport: fixture.transport })
    const pending = client.request('model/list', {})
    client.close()
    await expect(pending).rejects.toThrow('连接已关闭')
  })
})
