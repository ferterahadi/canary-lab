import { describe, expect, it } from 'vitest'
import { isMissingLogError, paneTerminalNotice } from './pane-terminal-message'

describe('paneTerminalNotice', () => {
  // "log not available" is no longer a buffer notice at all — it is the pane's
  // empty state, so this module only has to recognise it. What it renders as is
  // PaneTerminal's business, and is tested there.
  it.each(['log not available', 'Log Not Available', '  log not available  '])(
    'recognises %j as the pane having no log rather than as output',
    (raw) => {
      expect(isMissingLogError(raw)).toBe(true)
    },
  )

  it.each(['socket error', 'unknown error', ''])('does not mistake %j for a missing log', (raw) => {
    expect(isMissingLogError(raw)).toBe(false)
  })

  it('renders socket failures as connection notices without the word error', () => {
    const notice = paneTerminalNotice('socket error')

    expect(notice.lines.join('\n')).toBe('Connection notice: socket connection interrupted.')
    expect(notice.lines.join('\n').toLowerCase()).not.toContain('error')
  })

  it('softens generic pane messages', () => {
    const notice = paneTerminalNotice('unknown error')

    expect(notice.lines).toEqual(['Pane message: unknown issue'])
    expect(notice.lines.join('\n').toLowerCase()).not.toContain('error')
  })

  it('uses unknown fallbacks for blank pane messages', () => {
    expect(paneTerminalNotice('   ')).toEqual({
      key: 'pane-message:unknown',
      lines: ['Pane message: unknown issue'],
    })
  })
})
