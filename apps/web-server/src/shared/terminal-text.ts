const TERMINAL_ESCAPE_PATTERNS = {
  color: /\x1b\[[0-9;]*m/g,
  classifier: /\x1b\[[0-9;?]*[ -/]*[@-~]/g,
  verification: /\x1B\[[0-?]*[ -/]*[@-~]/g,
  diagnostic: /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|[=>])/g,
}

export type TerminalTextProfile = keyof typeof TERMINAL_ESCAPE_PATTERNS

/** Profiles preserve each consumer's existing capture format. Bare bracket
 *  sequences are reporter noise only in diagnostic output, not ordinary text. */
export function stripTerminalEscapes(value: string, profile: TerminalTextProfile): string {
  const cleaned = value.replace(TERMINAL_ESCAPE_PATTERNS[profile], '')
  return profile === 'diagnostic' ? cleaned.replace(/\[\d+(?:;\d+)*m/g, '') : cleaned
}
