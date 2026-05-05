import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleLine } from './wizard-claude-formatter'

let writes: string[]
let spy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  writes = []
  spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
})

afterEach(() => {
  spy.mockRestore()
})

describe('wizard claude formatter', () => {
  it('prints session progress without ANSI', () => {
    handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abcdef1234', model: 'opus' }))
    expect(writes.join('')).toContain('session abcdef12 (opus)')
    expect(writes.join('')).not.toContain('\u001b')
  })

  it('emits assistant text raw so wizard markers remain parseable', () => {
    handleLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<plan-output>\n{"steps":[{"step":"Login","actions":[],"expectedOutcome":"ok"}]}\n</plan-output>',
        }],
      },
    }))
    const out = writes.join('')
    expect(out).toContain('<plan-output>')
    expect(out).toContain('"steps"')
    expect(out).not.toContain('│')
    expect(out).not.toContain('\u001b')
  })
})
