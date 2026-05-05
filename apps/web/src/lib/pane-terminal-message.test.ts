import { describe, expect, it } from 'vitest'
import { paneTerminalNotice } from './pane-terminal-message'

describe('paneTerminalNotice', () => {
  it.each([
    ['playwright', 'No Playwright log captured yet.'],
    ['agent', 'No heal-agent transcript captured yet.'],
    ['service:api', 'No service log captured yet.'],
    ['draft:1', 'No log captured yet.'],
  ])('maps missing logs for %s to friendly copy', (paneId, title) => {
    expect(paneTerminalNotice(paneId, 'log not available')).toEqual({
      key: `missing-log:${paneId}`,
      lines: [
        title,
        'This run may have ended before this pane wrote output.',
      ],
    })
  })

  it('renders socket failures as connection notices without the word error', () => {
    const notice = paneTerminalNotice('playwright', 'socket error')

    expect(notice.lines.join('\n')).toBe('Connection notice: socket connection interrupted.')
    expect(notice.lines.join('\n').toLowerCase()).not.toContain('error')
  })

  it('softens generic pane messages', () => {
    const notice = paneTerminalNotice('playwright', 'unknown error')

    expect(notice.lines).toEqual(['Pane message: unknown issue'])
    expect(notice.lines.join('\n').toLowerCase()).not.toContain('error')
  })

  it('uses unknown fallbacks for blank pane messages', () => {
    expect(paneTerminalNotice('playwright', '   ')).toEqual({
      key: 'pane-message:unknown',
      lines: ['Pane message: unknown issue'],
    })
  })
})
