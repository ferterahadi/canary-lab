import { describe, it, expect } from 'vitest'
import { classifyHealFailure } from './heal-failure-classifier'

describe('classifyHealFailure', () => {
  it('returns undefined for an empty / whitespace tail', () => {
    expect(classifyHealFailure('')).toBeUndefined()
    expect(classifyHealFailure('   \n\t  ')).toBeUndefined()
  })

  it('returns unknown when the tail matches no fingerprint', () => {
    expect(classifyHealFailure('Thinking about the failing test...')).toBe('unknown')
  })

  it('classifies codex usage-limit output', () => {
    expect(
      classifyHealFailure("You've hit your usage limit. Upgrade your plan to continue.", 'codex'),
    ).toBe('usage-limit')
    expect(classifyHealFailure('Error: weekly limit reached for this account')).toBe('usage-limit')
  })

  it('classifies claude credit-balance output as usage-limit', () => {
    expect(
      classifyHealFailure('Your credit balance is too low to access the API.', 'claude'),
    ).toBe('usage-limit')
  })

  it('classifies auth failures', () => {
    expect(classifyHealFailure('You are not logged in. Run `codex login`.', 'codex')).toBe('auth')
    expect(classifyHealFailure('HTTP 401 Unauthorized: invalid api key')).toBe('auth')
  })

  it('classifies rate-limit / overloaded output', () => {
    expect(classifyHealFailure('Error 429: too many requests, try again later')).toBe('rate-limit')
    expect(classifyHealFailure('The server is overloaded. Please retry.', 'claude')).toBe(
      'rate-limit',
    )
  })

  it('classifies a crash / spawn error', () => {
    expect(classifyHealFailure('codex: command not found')).toBe('crash')
    expect(classifyHealFailure('panic: runtime error: nil pointer dereference')).toBe('crash')
  })

  it('is case-insensitive and tolerates ANSI color codes', () => {
    expect(classifyHealFailure('\x1b[31mUSAGE LIMIT\x1b[0m exceeded')).toBe('usage-limit')
  })

  it('prefers the more specific cause when several could match', () => {
    // "usage limit" also contains "limit"; usage-limit must win over rate-limit.
    expect(classifyHealFailure('monthly usage limit — rate limit note below')).toBe('usage-limit')
  })

  // Verbatim from run 2026-08-02T1142-aih6's heal-agent-tail.txt, where the
  // agent sat on this prompt for its whole idle window. A full-screen TUI
  // places each word with a cursor escape instead of a space, so stripping ANSI
  // leaves one run-together word — the reason the matcher also squeezes space.
  const REAL_TRUST_PROMPT_TAIL =
    '\x1b[2GAccessing\x1b[12Gworkspace:\r\n\r\n' +
    '\x1b[2G/private/var/folders/T/canary-flight-lab/demo-project/logs/runs/2026-08-02T1142-aih6\r\n\r\n' +
    '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated' +
    '\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\n\r\n' +
    "\x1b[2GClaude\x1b[9GCode'll\x1b[17Gbe\x1b[20Gable\x1b[25Gto\x1b[28Gread,\x1b[34Gedit,\x1b[40Gand\x1b[44Gexecute\x1b[52Gfiles\x1b[58Ghere.\r\n\r\n" +
    '\x1b[2G❯\x1b[4G1.\x1b[7GYes,\x1b[12GI\x1b[14Gtrust\x1b[20Gthis\x1b[25Gfolder\r\n\x1b[4G2.\x1b[7GNo,\x1b[11Gexit\r\n'

  it('classifies the folder-trust prompt from a real captured tail', () => {
    expect(classifyHealFailure(REAL_TRUST_PROMPT_TAIL, 'claude')).toBe('trust-prompt')
  })

  it('classifies the trust prompt ahead of crash — its body says "execute"', () => {
    // 'killed'/'command not found' aren't present, but the prompt's own copy is
    // full of words a looser fingerprint table could misread. Pin the order.
    expect(classifyHealFailure('Is this a project you created or one you trust?')).toBe('trust-prompt')
    expect(classifyHealFailure('❯ 1. Yes, I trust this folder')).toBe('trust-prompt')
  })

  // Captured from a real 2026-08-04 demo_catalog heal run: the agent had made a
  // complete, correct repair and then stopped on a Bash approval prompt nobody
  // was there to answer. The watchdog reported it as "no code changes were
  // made", which was false. This cause exists so that failure is named.
  it('classifies an unanswered Bash approval prompt', () => {
    expect(classifyHealFailure('Contains simple_expansion\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No', 'claude'))
      .toBe('approval-prompt')
    expect(classifyHealFailure('Do you want to proceed?\n  2. Yes, allow reading from workspace/ from this project'))
      .toBe('approval-prompt')
    expect(classifyHealFailure('Do you want to make this edit to server.ts?', 'claude'))
      .toBe('approval-prompt')
  })

  it('lets a hard blocker outrank a pending approval prompt', () => {
    // A tail can hold both: the prompt was rendered, then the session died on a
    // limit. The blocker is the actionable cause, so it wins. The reverse order
    // would report "answer the prompt" for a session that could not continue.
    expect(classifyHealFailure('Do you want to proceed?\n\nYou have reached your usage limit'))
      .toBe('usage-limit')
  })

  it('classifies an approval prompt ahead of crash — a REPL tail is full of shell noise', () => {
    // `enoent`/`killed`/`command not found` show up in ordinary Bash output the
    // agent was reading. A rendered prompt is the specific signal; pin the order.
    expect(classifyHealFailure('cat: logs/x: ENOENT\n\nDo you want to proceed?\n❯ 1. Yes'))
      .toBe('approval-prompt')
  })

  it('still classifies spaced fingerprints after the squeeze pass', () => {
    // The squeeze is additive: everything that matched before must still match.
    expect(classifyHealFailure('You have reached your usage limit')).toBe('usage-limit')
    expect(classifyHealFailure('\x1b[31mtoo\x1b[0m many requests')).toBe('rate-limit')
  })
})
