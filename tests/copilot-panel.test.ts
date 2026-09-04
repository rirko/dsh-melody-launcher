import { describe, expect, it } from 'vitest'
import { copilotMessageRoleLabel } from '../src/components/DSHCopilotPanel'

describe('Copilot panel labels', () => {
  it('identifies the assistant backend without changing user or tool roles', () => {
    expect(copilotMessageRoleLabel('assistant')).toBe('DSH Copilot')
    expect(copilotMessageRoleLabel('assistant', 'codex')).toBe('Codex')
    expect(copilotMessageRoleLabel('user', 'codex')).toBe('你')
    expect(copilotMessageRoleLabel('tool', 'codex')).toBe('系统')
    expect(copilotMessageRoleLabel('system', 'codex')).toBe('系统')
  })
})
