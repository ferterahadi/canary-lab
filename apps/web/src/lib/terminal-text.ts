const ESC = '\u001b'

const ANSI_PATTERNS = [
  new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'),
  new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g'),
  new RegExp(`${ESC}[PX^_][\\s\\S]*?${ESC}\\\\`, 'g'),
  new RegExp(`${ESC}[@-_]`, 'g'),
]

// When a PTY is interrupted, some browsers/log paths can surface CSI/OSC
// fragments after the ESC byte has already been dropped. Keep this narrow so
// normal bracketed progress like "[0:03]" remains visible.
const VISIBLE_CONTROL_REMAINDERS = [
  /\[(?:\?|>|<)[0-9;]*[A-Za-z]/g,
  /\][0-9]+;[^\n\r]*/g,
]

export function stripTerminalControls(input: string): string {
  let output = input
  for (const pattern of ANSI_PATTERNS) {
    output = output.replace(pattern, '')
  }
  for (const pattern of VISIBLE_CONTROL_REMAINDERS) {
    output = output.replace(pattern, '')
  }
  return output.replace(/\r/g, '')
}

export function appendCleanTerminalText(existing: string, chunk: string): string {
  return stripTerminalControls(existing + chunk)
}
