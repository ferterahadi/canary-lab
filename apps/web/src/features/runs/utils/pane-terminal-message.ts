export interface PaneTerminalNotice {
  key: string
  lines: string[]
}

/**
 * "The log isn't there" is not a transport message — it is the pane's empty
 * state, and it renders as one. Writing it into the xterm buffer (as this file
 * used to) both painted it in a different idiom from every other empty pane and
 * marked the pane as having produced output, which suppressed the real
 * placeholder underneath. `PaneTerminal` reads this and swaps its overlay copy.
 */
export function isMissingLogError(rawMessage: string): boolean {
  return rawMessage.trim().toLowerCase() === 'log not available'
}

export function paneTerminalNotice(rawMessage: string): PaneTerminalNotice {
  const message = rawMessage.trim()
  const normalized = message.toLowerCase()

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

function softenMessage(message: string): string {
  return message.replace(/\berror\b/gi, 'issue')
}
