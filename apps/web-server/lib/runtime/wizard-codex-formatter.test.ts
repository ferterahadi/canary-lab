import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleLine } from './wizard-codex-formatter'

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

describe('wizard codex formatter', () => {
  it('prints thread progress without ANSI', () => {
    handleLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123456' }))
    expect(writes.join('')).toContain('thread thread-1')
    expect(writes.join('')).not.toContain('\u001b')
  })

  it('emits agent messages raw so wizard markers remain parseable', () => {
    handleLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '<file path="generated/example.spec.ts">\ntest("x", async () => {})\n</file>',
      },
    }))
    const out = writes.join('')
    expect(out).toContain('<file path="generated/example.spec.ts">')
    expect(out).toContain('test("x"')
    expect(out).not.toContain('│')
    expect(out).not.toContain('\u001b')
  })
})
