import { describe, expect, it } from 'vitest'
import {
  codexFallbackServerResponse,
  codexServerRequestKind,
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
  return { transport, sent, receive: (message: CodexAppServerMessage) => messageHandler(message) }
}

describe('Codex App Server legal server requests', () => {
  it('classifies all current server-initiated request families', () => {
    const cases: Array<[string, string]> = [
      ['item/commandExecution/requestApproval', 'command'],
      ['item/fileChange/requestApproval', 'file-change'],
      ['item/permissions/requestApproval', 'permissions'],
      ['item/tool/requestUserInput', 'user-input'],
      ['tool/requestUserInput', 'user-input'],
      ['mcpServer/elicitation/request', 'elicitation'],
      ['item/tool/call', 'dynamic-tool'],
      ['account/chatgptAuthTokens/refresh', 'auth-refresh'],
      ['attestation/generate', 'attestation'],
      ['something/else', 'unknown'],
    ]
    for (const [method, expected] of cases) expect(codexServerRequestKind(method)).toBe(expected)
  })

  it('returns protocol-valid neutral results for optional requests without a host UI', () => {
    expect(codexFallbackServerResponse('item/tool/requestUserInput')).toMatchObject({ result: { answers: {} } })
    expect(codexFallbackServerResponse('mcpServer/elicitation/request')).toMatchObject({
      result: { action: 'decline', content: null, _meta: null },
    })
    expect(codexFallbackServerResponse('item/tool/call')).toMatchObject({
      result: { success: false, contentItems: [{ type: 'inputText' }] },
    })
    expect(codexFallbackServerResponse('account/chatgptAuthTokens/refresh')).toMatchObject({
      error: { code: -32010 },
    })
    expect(codexFallbackServerResponse('attestation/generate')).toMatchObject({
      error: { code: -32011 },
    })
    expect(codexFallbackServerResponse('currentTime/read')).toMatchObject({
      result: { currentTimeAt: expect.any(Number) },
    })
  })

  it('answers legal optional requests by default and keeps the stream usable', async () => {
    const fixture = transportFixture()
    const events: string[] = []
    const client = createCodexAppServerClient({
      transport: fixture.transport,
      onEvent: event => {
        if (event.method === 'item/agentMessage/delta') events.push(String(event.params.delta))
      },
    })

    fixture.receive({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [] } })
    fixture.receive({ id: 2, method: 'mcpServer/elicitation/request', params: {} })
    fixture.receive({ id: 3, method: 'item/tool/call', params: {} })
    fixture.receive({ method: 'item/agentMessage/delta', params: { delta: 'still running' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fixture.sent).toContainEqual({ id: 1, result: { answers: {} } })
    expect(fixture.sent).toContainEqual({ id: 2, result: { action: 'decline', content: null, _meta: null } })
    expect(fixture.sent).toContainEqual({
      id: 3,
      result: { success: false, contentItems: [{ type: 'inputText', text: 'DSH Launcher 未配置此动态工具。' }] },
    })
    expect(events).toEqual(['still running'])

    // Requests that cannot be served use an explicit application error, not
    // -32601 (which falsely suggests a protocol/version mismatch).
    fixture.receive({ id: 4, method: 'account/chatgptAuthTokens/refresh', params: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.sent).toContainEqual({
      id: 4,
      error: { code: -32010, message: 'Codex 外部 ChatGPT 令牌刷新未配置。' },
    })

    fixture.receive({ id: 5, method: 'currentTime/read', params: { threadId: 'thread-1' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fixture.sent).toContainEqual({
      id: 5,
      result: { currentTimeAt: expect.any(Number) },
    })

    client.close()
  })
})
