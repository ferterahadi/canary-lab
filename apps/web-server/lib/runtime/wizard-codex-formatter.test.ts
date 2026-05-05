import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanCommand,
  elapsed,
  handleCompleted,
  handleLine,
  summarizeOutput,
  tag,
  truncate,
} from './wizard-codex-formatter'

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
  it('formats helper output without ANSI', () => {
    expect(elapsed()).toMatch(/^\d+:\d{2}$/)
    expect(tag()).toMatch(/^\[\d+:\d{2}\]$/)
    expect(truncate('abcdef', 4)).toBe('abc...')
    expect(cleanCommand("/bin/zsh -lc 'npm test'")).toBe('npm test')
    expect(cleanCommand('/bin/bash -c "echo hi"')).toBe('echo hi')
    expect(cleanCommand('git status')).toBe('git status')
    expect(summarizeOutput('')).toBe('(no output)')
    expect(summarizeOutput('\nfirst\nsecond')).toBe('first')
  })

  it('ignores empty, invalid, and incomplete payloads', () => {
    handleLine('')
    handleLine('not json')
    handleLine(JSON.stringify({ type: 'item.completed' }))
    expect(writes).toEqual([])
  })

  it('prints thread progress without ANSI', () => {
    handleLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123456' }))
    expect(writes.join('')).toContain('[[canary-lab:wizard-session agent=codex id=thread-123456]]')
    expect(writes.join('')).toContain('thread thread-1')
    expect(writes.join('')).not.toContain('\u001b')
  })

  it('uses fallback thread label when the id is missing', () => {
    handleLine(JSON.stringify({ type: 'thread.started' }))
    expect(writes.join('')).toContain('thread started')
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

  it('skips blank agent messages and prints reasoning text', () => {
    handleCompleted({ type: 'agent_message', text: '   ' })
    handleCompleted({ type: 'reasoning', text: 'thinking about a fix\nmore detail' })
    handleCompleted({ type: 'reasoning', text: '' })
    const out = writes.join('')
    expect(out).toContain('thinking thinking about a fix')
  })

  it('prints command states and output summaries', () => {
    handleCompleted({
      type: 'command_execution',
      command: "/bin/zsh -lc 'npm run test'",
      exit_code: 0,
      aggregated_output: 'pass\nsecond line',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'npm run dev',
      exit_code: null,
      aggregated_output: '',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'npm run lint',
      exit_code: 2,
      aggregated_output: 'lint failed',
    })
    const out = writes.join('')
    expect(out).toContain('command npm run test (ok)')
    expect(out).toContain('output pass')
    expect(out).toContain('command npm run dev (running)')
    expect(out).toContain('command npm run lint (exit 2)')
    expect(out).toContain('lint failed')
  })

  it('prints file changes and defaults missing fields', () => {
    handleCompleted({
      type: 'file_change',
      changes: [
        { kind: 'add', path: 'new.ts' },
        { path: 'updated.ts' },
        {},
      ],
    })
    handleCompleted({ type: 'file_change', changes: 'not-array' })
    const out = writes.join('')
    expect(out).toContain('file add new.ts')
    expect(out).toContain('file update updated.ts')
    expect(out).toContain('file update')
  })

  it('prints turn usage and defaults missing usage to zeroes', () => {
    handleLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }))
    handleLine(JSON.stringify({ type: 'turn.completed' }))
    const out = writes.join('')
    expect(out).toContain('turn done (7 in / 3 out)')
    expect(out).toContain('turn done (0 in / 0 out)')
  })
})
