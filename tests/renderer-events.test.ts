import { describe, expect, it } from 'vitest'
import type { RendererChannel } from '../electron/app-window'
import { createRendererEvents, normalizeOutputText } from '../electron/renderer-events'

function recordingChannel() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const channel: RendererChannel = { send: (name, payload) => sent.push({ channel: name, payload }) }
  return { channel, sent }
}

describe('normalizeOutputText', () => {
  it('converts CRLF and trims trailing whitespace', () => {
    expect(normalizeOutputText('first\r\nsecond\r\n')).toBe('first\nsecond')
  })

  it('leaves interior whitespace alone', () => {
    expect(normalizeOutputText('  indented line')).toBe('  indented line')
  })

  it('turns carriage-return progress refreshes into visible terminal lines', () => {
    expect(normalizeOutputText('fetching 10%\rfetching 20%\r')).toBe('fetching 10%\nfetching 20%')
  })
})

describe('createRendererEvents', () => {
  it('stamps output with the source channel, level and timestamp', () => {
    const { channel, sent } = recordingChannel()
    const events = createRendererEvents(channel, () => '2026-08-14T00:00:00.000Z')

    events.output('plugin', 'error', 'install failed\r\n')

    expect(sent).toEqual([{
      channel: 'runtime:output',
      payload: {
        channel: 'plugin',
        level: 'error',
        text: 'install failed',
        timestamp: '2026-08-14T00:00:00.000Z',
      },
    }])
  })

  it('drops output that is empty once normalized', () => {
    const { channel, sent } = recordingChannel()
    const events = createRendererEvents(channel)

    events.output('runtime', 'info', '   \r\n')
    events.output('runtime', 'info', '')

    expect(sent).toEqual([])
  })

  it('forwards runtime state and install progress unchanged', () => {
    const { channel, sent } = recordingChannel()
    const events = createRendererEvents(channel)
    const state = { running: true, pid: 4321, startedAt: '2026-08-14T00:00:00.000Z', url: 'http://127.0.0.1:5173', port: 5173 }
    const progress = {
      repository: 'someone/plugin',
      kind: 'plugin' as const,
      phase: 'downloading' as const,
      percent: 40,
      message: '正在下载',
    }

    events.runtimeState(state)
    events.installProgress(progress)

    expect(sent).toEqual([
      { channel: 'runtime:state-changed', payload: state },
      { channel: 'plugins:install-progress', payload: progress },
    ])
  })
})
