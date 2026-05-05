import { describe, expect, it } from 'vitest'
import { appendCleanTerminalText, stripTerminalControls } from './terminal-text'

describe('terminal text cleanup', () => {
  it('strips escaped ANSI and terminal control sequences', () => {
    const raw = `Plan generation CLAUDE \u001b[?1006l\u001b[?1003l\u001b[>4m\u001b[<u done`
    expect(stripTerminalControls(raw)).toBe('Plan generation CLAUDE  done')
  })

  it('strips visible PTY control fragments without removing normal timestamps', () => {
    const raw = '[0:03] Read package.json [?1006l [>4m [<u ]9;4;0;'
    expect(stripTerminalControls(raw)).toBe('[0:03] Read package.json    ')
  })

  it('cleans appended chunks as one stream', () => {
    expect(appendCleanTerminalText('hello', '\u001b[31m world\u001b[0m')).toBe('hello world')
  })
})
