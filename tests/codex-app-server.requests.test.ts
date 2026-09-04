import { describe, expect, it } from 'vitest'
import {
  createCodexAppServerClient,
  type CodexAppServerMessage,
  type CodexAppServerTransport,
} from '../electron/codex-app-server'

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
  return {
    transport,
    sent,
    receive(message: CodexAppServerMessage) { messageHandler(message) },
  }
}

async function settle(): Promise<void> {
  // Server requests are deliberately dispatched without awaiting one another.
  // A short timer also covers a deliberately delayed renderer hook below.
  await new Promise<void>(resolve => setTimeout(resolve, 15))
}

describe('Codex App Server server requests', () => {
  it('keeps concurrent dynamic-tool and user-input requests independent', async () => {
    const fixture = transportFixture()
    const methods: string[] = []
    let client!: ReturnType<typeof createCodexAppServerClient>
    client = createCodexAppServerClient({
      transport: fixture.transport,
      onRequest: async request => {
        methods.push(request.method)
        // Deliberately resolve the second request first.  A request handler
        // must be keyed by id, rather than assuming server request order.
        await new Promise<void>(resolve => setTimeout(resolve, request.method === 'item/tool/call' ? 5 : 0))
        if (request.method === 'item/tool/requestUserInput') {
          client.respond(request.id, {
            answers: {
              choice: { answers: ['yes'] },
            },
          })
        } else if (request.method === 'item/tool/call') {
          client.respond(request.id, {
            success: true,
            contentItems: [{ type: 'inputText', text: 'tool result' }],
          })
        }
      },
    })

    fixture.receive({
      id: 101,
      method: 'item/tool/requestUserInput',
      params: {
        isBlocking: true,
        itemId: 'item-input',
        threadId: 'thread-1',
        turnId: 'turn-1',
        questions: [{ header: 'Choice', id: 'choice', question: 'Continue?' }],
      },
    })
    fixture.receive({
      id: 102,
      method: 'item/tool/call',
      params: {
        callId: 'call-1',
        namespace: null,
        threadId: 'thread-1',
        tool: 'demo',
        arguments: { value: 1 },
        turnId: 'turn-1',
      },
    })
    await settle()

    expect(methods).toEqual(['item/tool/requestUserInput', 'item/tool/call'])
    expect(fixture.sent).toContainEqual({
      id: 101,
      result: { answers: { choice: { answers: ['yes'] } } },
    })
    expect(fixture.sent).toContainEqual({
      id: 102,
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: 'tool result' }],
      },
    })
    client.close()
  })

  it('forwards MCP elicitation responses and continues after a failed request', async () => {
    const fixture = transportFixture()
    const events: string[] = []
    let client!: ReturnType<typeof createCodexAppServerClient>
    client = createCodexAppServerClient({
      transport: fixture.transport,
      onEvent: event => {
        if (event.method === 'item/agentMessage/delta') events.push(String(event.params.delta))
      },
      onRequest: async request => {
        if (request.method === 'mcpServer/elicitation/request') {
          client.respond(request.id, {
            action: 'accept',
            content: { values: { approved: true } },
          })
          return
        }
        throw new Error(`unsupported ${request.method}`)
      },
      onProtocolError: error => events.push(`error:${error.message}`),
    })

    fixture.receive({
      id: 201,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'demo-mcp',
        threadId: 'thread-1',
        turnId: 'turn-1',
        mode: 'form',
        message: 'Approve?',
        requestedSchema: { type: 'object', properties: {} },
      },
    })
    // A handler error must produce a response, but must not close the stream.
    fixture.receive({ id: 202, method: 'item/tool/requestUserInput', params: {} })
    fixture.receive({ method: 'item/agentMessage/delta', params: { delta: 'still-alive' } })
    await settle()

    expect(fixture.sent).toContainEqual({
      id: 201,
      result: { action: 'accept', content: { values: { approved: true } } },
    })
    expect(fixture.sent).toContainEqual({
      id: 202,
      error: { code: -32603, message: 'unsupported item/tool/requestUserInput' },
    })
    expect(events).toContain('still-alive')
    expect(events).toContain('error:unsupported item/tool/requestUserInput')

    // A normal request remains usable after the failed request.
    fixture.receive({
      id: 203,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'demo-mcp',
        threadId: 'thread-1',
        mode: 'url',
        message: 'Open?',
        url: 'https://example.test/auth',
        elicitationId: 'elicit-2',
      },
    })
    await settle()
    expect(fixture.sent).toContainEqual({
      id: 203,
      result: { action: 'accept', content: { values: { approved: true } } },
    })
    client.close()
  })

  it('converts a synchronous request-handler throw into one error response', async () => {
    const fixture = transportFixture()
    const protocolErrors: Error[] = []
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      onRequest: () => {
        throw new Error('synchronous handler failure')
      },
      onProtocolError: error => protocolErrors.push(error),
    })

    fixture.receive({ id: 204, method: 'item/tool/requestUserInput', params: {} })
    await settle()

    expect(fixture.sent).toContainEqual({
      id: 204,
      error: { code: -32603, message: 'synchronous handler failure' },
    })
    expect(fixture.sent.filter(message => message.id === 204)).toHaveLength(1)
    expect(protocolErrors.some(error => error.message === 'synchronous handler failure')).toBe(true)
    client.close()
  })

  it('ignores a duplicate response for a server request', async () => {
    const fixture = transportFixture()
    let client!: ReturnType<typeof createCodexAppServerClient>
    client = createCodexAppServerClient({
      transport: fixture.transport,
      onRequest: request => {
        client.respond(request.id, { answers: {} })
        client.respond(request.id, { answers: { unexpected: true } })
      },
    })

    fixture.receive({ id: 205, method: 'item/tool/requestUserInput', params: {} })
    await settle()

    expect(fixture.sent.filter(message => message.id === 205)).toEqual([
      { id: 205, result: { answers: {} } },
    ])
    client.close()
  })

  it('forgets a server request when App Server reports it was cleared', async () => {
    const fixture = transportFixture()
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      // Keep the request pending until the explicit resolved notification.
      onRequest: () => undefined,
    })

    fixture.receive({ id: 206, method: 'item/tool/requestUserInput', params: {} })
    fixture.receive({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 206 } })
    // A late UI callback after turn completion must be ignored; replying now
    // would violate the one-response rule for a request the server cleared.
    client.respond(206, { answers: {} })
    await settle()

    expect(fixture.sent.filter(message => message.id === 206)).toHaveLength(0)
    client.close()
  })

  it('closes the client and rejects pending requests when transport send fails', async () => {
    let messageHandler: (message: CodexAppServerMessage) => void = () => undefined
    let closeHandler: (error?: Error) => void = () => undefined
    let sends = 0
    const transport: CodexAppServerTransport = {
      send() {
        sends += 1
        throw new Error('broken pipe')
      },
      onMessage(handler) { messageHandler = handler },
      onClose(handler) { closeHandler = handler },
      close() { closeHandler(new Error('closed')) },
    }
    const client = createCodexAppServerClient({ transport })

    const pending = client.request('model/list', {})
    await expect(pending).rejects.toThrow('broken pipe')
    expect(sends).toBe(1)
    await expect(client.request('model/list', {})).rejects.toThrow('broken pipe')
    // Keep the fixture callbacks referenced so the test also documents that a
    // later transport close is harmless after send() already failed.
    messageHandler({ method: 'ignored' })
    closeHandler()
  })
})
