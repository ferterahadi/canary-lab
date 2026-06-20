export interface PaneTerminalNotice {
  key: string
  lines: string[]
}

export function paneTerminalNotice(paneId: string, rawMessage: string): PaneTerminalNotice {
  const message = rawMessage.trim()
  const normalized = message.toLowerCase()

  if (normalized === 'log not available') {
    return {
      key: `missing-log:${paneId}`,
      lines: [
        missingLogTitle(paneId),
        'This run may have ended before this pane wrote output.',
      ],
    }
  }

  if (normalized === 'socket error') {
    return {
      key: `connection:${normalized}`,
      lines: ['Connection notice: socket connection interrupted.'],
    }
  }

  return {
    key: `pane-message:${normalized || 'unknown'}`,
    lines: [`Pane message: ${softenMessage(message || 'unknown issue')}`],
  }
}

function missingLogTitle(paneId: string): string {
  if (paneId === 'playwright') return 'No Playwright log captured yet.'
  if (paneId === 'agent') return 'No heal-agent transcript captured yet.'
  if (paneId.startsWith('service:')) return 'No service log captured yet.'
  return 'No log captured yet.'
}

function softenMessage(message: string): string {
  return message.replace(/\berror\b/gi, 'issue')
}
