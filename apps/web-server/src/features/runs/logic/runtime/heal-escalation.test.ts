import { describe, it, expect } from 'vitest'
import { ESCALATION_THRESHOLD, buildHealEscalation, escalationTracePaths } from './heal-escalation'

describe('escalationTracePaths', () => {
  it('builds concrete trace paths under the failed dir', () => {
    const { snapshotPath, networkPath } = escalationTracePaths('/runs/r1/failed')
    expect(snapshotPath).toBe('/runs/r1/failed/<slug>/trace-extract/snapshot-at-failure.txt')
    expect(networkPath).toBe('/runs/r1/failed/<slug>/trace-extract/network-failed.txt')
  })

  it('falls back to a placeholder when failedDir is absent', () => {
    expect(escalationTracePaths().snapshotPath).toBe('<failedDir>/<slug>/trace-extract/snapshot-at-failure.txt')
  })
})

describe('buildHealEscalation', () => {
  it('carries the streak, failing set, read-first trace paths, and signal_run tactic', () => {
    const escalation = buildHealEscalation({
      consecutiveSameFailures: 3,
      slugs: ['checkout fails', 'cart empties'],
      journalPath: '/runs/r1/diagnosis-journal.md',
      failedDir: '/runs/r1/failed',
    })
    expect(escalation.consecutiveSameFailures).toBe(3)
    expect(escalation.failingSet).toEqual(['checkout fails', 'cart empties'])
    expect(escalation.message).toContain('2 fix attempts')
    expect(escalation.readFirst).toEqual([
      '/runs/r1/failed/<slug>/trace-extract/snapshot-at-failure.txt',
      '/runs/r1/failed/<slug>/trace-extract/network-failed.txt',
    ])
    // External mechanism, not the PTY .rerun signal file.
    expect(escalation.tactics.join(' ')).toContain('signal_run kind:"rerun"')
    expect(escalation.tactics.join(' ')).toContain('/runs/r1/diagnosis-journal.md')
  })

  it('singularizes the prior-attempt count at the threshold boundary', () => {
    const escalation = buildHealEscalation({
      consecutiveSameFailures: ESCALATION_THRESHOLD - 1,
      slugs: ['a'],
      journalPath: '/j.md',
    })
    // consecutiveSameFailures 2 → 1 prior attempt.
    expect(escalation.message).toContain('1 fix attempt ')
  })
})
