import { describe, expect, it } from 'vitest'
import { isClientKind } from './run-mode'

describe('isClientKind', () => {
  // The guard is the validation seam for untrusted MCP args and persisted
  // records, so every accepted literal is asserted individually — a dropped
  // arm would silently stop a real client from being recognised.
  it('accepts every ClientKind literal', () => {
    for (const kind of ['claude', 'codex', 'claude-pty', 'codex-pty', 'other']) {
      expect(isClientKind(kind)).toBe(true)
    }
  })

  it('rejects look-alikes and non-strings', () => {
    expect(isClientKind('Claude')).toBe(false)
    expect(isClientKind('claude-cli')).toBe(false)
    expect(isClientKind('')).toBe(false)
    expect(isClientKind(undefined)).toBe(false)
    expect(isClientKind(null)).toBe(false)
    expect(isClientKind({ clientKind: 'claude' })).toBe(false)
  })
})
