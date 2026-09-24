// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

function progressStyle(mode: 'hidden' | 'half' | 'expanded') {
  const style = document.createElement('style')
  style.textContent = readFileSync('src/styles.css', 'utf8')
  document.head.appendChild(style)
  document.body.innerHTML = `<section class="runtime-drawer runtime-drawer-${mode}">
    <button class="runtime-drawer-handle">
      <span class="runtime-drawer-handle-copy">Downloading 45%</span>
      <span class="runtime-drawer-handle-progress"><span style="width: 45%"></span></span>
      <span class="runtime-drawer-handle-chevron"></span>
    </button>
  </section>`
  return (selector: string) => getComputedStyle(document.querySelector(selector)!)
}

describe('runtime drawer progress background', () => {
  it('fills the hidden capsule behind its text and preserves the percentage', () => {
    const style = progressStyle('hidden')
    expect(style('.runtime-drawer-handle').overflow).toBe('hidden')
    expect(style('.runtime-drawer-handle').isolation).toBe('isolate')
    expect(style('.runtime-drawer-handle-progress').inset).toBe('0')
    expect(style('.runtime-drawer-handle-progress').width).toBe('auto')
    expect(style('.runtime-drawer-handle-progress').height).toBe('auto')
    expect(style('.runtime-drawer-handle-progress').pointerEvents).toBe('none')
    expect(style('.runtime-drawer-handle-progress').zIndex).toBe('0')
    expect(style('.runtime-drawer-handle-progress span').width).toBe('45%')
    expect(style('.runtime-drawer-handle-copy').zIndex).toBe('1')
    expect(style('.runtime-drawer-handle-chevron').zIndex).toBe('1')
  })

  it.each(['half', 'expanded'] as const)('keeps the small progress track in %s mode', mode => {
    const style = progressStyle(mode)
    expect(style('.runtime-drawer-handle-progress').height).toBe('3px')
    expect(style('.runtime-drawer-handle-progress').right).toBe('34px')
  })
})
