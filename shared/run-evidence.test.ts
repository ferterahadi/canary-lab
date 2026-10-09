import { describe, expect, it } from 'vitest'
import { buildRunEvidence, journalDiffBlock, journalForCycle, mediaForAttempt, playbackAttempts, type RunEvidence } from './run-evidence'
import { buildPlaybackIdentity } from './playback-identity'
import type { JournalSection } from './run-detail'
import type { PlaywrightPlaybackEvent } from './playback'
import type { RunLifecycleEvent } from './run-state'
import {
  evidenceJournalMarkdown, evidenceKnownTests, evidenceLifecycleEvents, evidencePlaybackEvents,
  stampedEvidenceLifecycleEvents, stampedEvidencePlaybackEvents,
} from './__fixtures__/run-evidence'

const legacy = (): RunEvidence => buildRunEvidence({
  events: evidencePlaybackEvents, known: evidenceKnownTests, lifecycle: evidenceLifecycleEvents,
  identity: buildPlaybackIdentity(evidencePlaybackEvents, evidenceKnownTests),
})
const stamped = (): RunEvidence => {
  const events = stampedEvidencePlaybackEvents()
  return buildRunEvidence({ events, known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents() })
}
const byId = (evidence: RunEvidence, id: string) => evidence.cases.find((c) => c.name === evidenceKnownTests.find((t) => t.id === id)!.name && c.location === evidenceKnownTests.find((t) => t.id === id)!.location)!

describe.each([['legacy (derived)', legacy, 'derived'], ['current (stamped)', stamped, 'stamped']] as const)('buildRunEvidence — %s', (_label, build, source) => {
  it('finds three executions and two repair cycles linked input → verification', () => {
    const evidence = build()
    expect(evidence.executions.map((x) => [x.index, x.afterCycle, x.targeted, x.source])).toEqual([
      [1, 0, false, source], [2, 1, true, source], [3, 2, true, source],
    ])
    expect(evidence.cycles.map((c) => [c.cycle, c.inputExecution, c.verifyingExecution, c.source])).toEqual([
      [1, 1, 2, source], [2, 2, 3, source],
    ])
    expect(evidence.unplacedAttempts).toEqual([])
  })

  it('tells the story of a case that failed twice and passed after the second repair', () => {
    const discount = byId(build(), 'discount')
    expect(discount.initial).toMatchObject({ executionIndex: 1, passed: false })
    expect(discount.latest).toMatchObject({ executionIndex: 3, passed: true })
    expect(discount.cycles.map((c) => [c.cycle, c.input.executionIndex, c.verification.kind, c.verification.kind === 'observed' && c.verification.attempt.passed])).toEqual([
      [1, 1, 'observed', false],
      [2, 2, 'observed', true],
    ])
  })

  it('keeps the Playwright retry as the input of the repair, not a separate cycle', () => {
    const inventory = byId(build(), 'inventory')
    expect(inventory.attempts.map((a) => [a.executionIndex, a.retry])).toEqual([[1, 0], [1, 1], [2, 0]])
    expect(inventory.cycles).toHaveLength(1)
    expect(inventory.cycles[0]).toMatchObject({ cycle: 1, input: { retry: 1 }, verification: { kind: 'observed', attempt: { passed: true } } })
  })

  it('never invents a fresh result for a case the reruns did not execute', () => {
    const evidence = build()
    const home = byId(evidence, 'home-loads')
    const admin = byId(evidence, 'admin-loads')
    // Both same-title cases stay separate, keep their execution-1 pass, and
    // are in no repair cycle because neither ever failed.
    expect([home.latest?.executionIndex, admin.latest?.executionIndex]).toEqual([1, 1])
    expect(home.caseKey).not.toBe(admin.caseKey)
    expect([home.cycles, admin.cycles]).toEqual([[], []])
  })
})

describe('buildRunEvidence — partial and live runs', () => {
  it('reports a repair with no execution after it as pending, and a case the rerun skipped as not rerun', () => {
    // Cut the stamped run right after cycle 2 started: no execution 3 yet.
    const lifecycle = stampedEvidenceLifecycleEvents().slice(0, 6)
    const events = stampedEvidencePlaybackEvents().filter((e) => e.time < '2026-10-08T10:09:00.000Z')
    const evidence = buildRunEvidence({ events, known: evidenceKnownTests, lifecycle })
    expect(byId(evidence, 'discount').cycles.at(-1)!.verification).toEqual({ kind: 'pending' })

    // Execution 2 reran discount and inventory only. Had inventory been left
    // out, cycle 1 must say so rather than borrow its execution-1 failure.
    const withoutInventoryRerun = buildRunEvidence({
      events: stampedEvidencePlaybackEvents().filter((e) => !(e.test.id === 'inventory' && e.time >= '2026-10-08T10:05:00.000Z')),
      known: evidenceKnownTests, lifecycle: stampedEvidenceLifecycleEvents(),
    })
    expect(byId(withoutInventoryRerun, 'inventory').cycles[0].verification).toEqual({ kind: 'not-rerun', execution: 2 })
  })

  it('leaves an attempt outside every execution unplaced instead of guessing its cycle', () => {
    const stray: PlaywrightPlaybackEvent[] = [
      { type: 'test-begin', time: '2026-10-08T11:00:00.000Z', test: { name: 'test-case-x', title: 'x', location: 'e2e/x.spec.ts:1' } },
      { type: 'test-end', time: '2026-10-08T11:00:01.000Z', test: { name: 'test-case-x', title: 'x', location: 'e2e/x.spec.ts:1' }, status: 'failed', passed: false, durationMs: 1, retry: 0 },
    ]
    const evidence = buildRunEvidence({ events: [...evidencePlaybackEvents, ...stray], known: evidenceKnownTests, lifecycle: evidenceLifecycleEvents })
    expect(evidence.unplacedAttempts.map((a) => a.name)).toEqual(['test-case-x'])
    const x = evidence.cases.find((c) => c.name === 'test-case-x')!
    expect(x).toMatchObject({ declared: false, cycles: [] })
    expect(x.initial).toBeUndefined()
  })

  it('treats an open execution as running and numbers legacy cycles by order after a restart', () => {
    const lifecycle = [
      { phase: 'running-tests', headline: 'h', updatedAt: '1' },
      { phase: 'failed', headline: 'h', updatedAt: '2' },
      { phase: 'agent-healing', headline: 'Heal cycle 1 started', updatedAt: '3', activeCycle: 1 },
      // A restart-heal: the loop narrates "cycle 1" again.
      { phase: 'agent-healing', headline: 'Heal cycle 1 started', updatedAt: '4', activeCycle: 1 },
      { phase: 'agent-healing', headline: 'Service still failed: api', updatedAt: '5' },
      { phase: 'rerunning-tests', headline: 'h', updatedAt: '6' },
    ] as const
    const evidence = buildRunEvidence({ lifecycle: [...lifecycle] })
    expect(evidence.cycles.map((c) => c.cycle)).toEqual([1, 2])
    expect(evidence.executions.at(-1)).toMatchObject({ index: 2, afterCycle: 2 })
    expect(evidence.executions.at(-1)!.endedAt).toBeUndefined()
  })

  it('keeps a declared case that never ran, without inventing an attempt or a result', () => {
    const evidence = buildRunEvidence({ known: [{ name: 'test-case-never', title: 'never' }, { name: 'test-case-untitled' }], lifecycle: evidenceLifecycleEvents })
    expect(evidence.cases.map((c) => [c.name, c.title, c.location, c.latest, c.initial, c.attempts, c.cycles])).toEqual([
      ['test-case-never', 'never', undefined, undefined, undefined, [], []],
      ['test-case-untitled', 'test-case-untitled', undefined, undefined, undefined, [], []],
    ])
  })

  it('places no attempt by time when it carries none, and ignores stamped records that open or close nothing', () => {
    const lifecycle = [
      { phase: 'failed', headline: 'orphan exit', updatedAt: '0', execution: { index: 9, afterCycle: 0 } },
      { phase: 'agent-healing', headline: 'Boot failure heal', updatedAt: '1', activeCycle: 1, repairCycle: 1 },
      { phase: 'running-tests', headline: 'h', updatedAt: '2', execution: { index: 1, afterCycle: 1 } },
      { phase: 'running-tests', headline: 'duplicate start', updatedAt: '3', execution: { index: 1, afterCycle: 1 } },
      { phase: 'completed', headline: 'h', updatedAt: '4', execution: { index: 1, afterCycle: 1 } },
    ] as RunLifecycleEvent[]
    // A legacy step with no test-begin opens an attempt that has no time at all.
    const events: PlaywrightPlaybackEvent[] = [{ type: 'step-begin', time: '', test: { name: 'orphan', title: 'orphan' }, step: { title: 's', category: 'pw:api' } }]
    const evidence = buildRunEvidence({ events, lifecycle })
    expect(evidence.executions).toEqual([{ index: 1, afterCycle: 1, startedAt: '2', endedAt: '4', targeted: false, source: 'stamped' }])
    // A repair before any execution (a boot-failure heal) has no test input.
    expect(evidence.cycles).toEqual([{ cycle: 1, startedAt: '1', inputExecution: undefined, verifyingExecution: 1, source: 'stamped' }])
    expect(evidence.unplacedAttempts.map((a) => a.name)).toEqual(['orphan'])
  })

  it('handles a run with no recorded evidence at all', () => {
    expect(buildRunEvidence({})).toEqual({ executions: [], cycles: [], cases: [], unplacedAttempts: [] })
  })
})

describe('journalForCycle', () => {
  const section = (over: Partial<JournalSection>): JournalSection => ({
    iteration: 1, timestamp: null, feature: null, run: null, outcome: null, hypothesis: null, body: '', ...over,
  })

  it('attributes a single-failure entry to its case and a shared one run-wide', () => {
    const evidence = stamped()
    const sections = [
      section({ iteration: 1, cycle: 1, failingTests: ['test-case-applies-the-discount', 'test-case-reserves-stock'] }),
      section({ iteration: 2, cycle: 2, failingTests: ['test-case-applies-the-discount'] }),
    ]
    expect(journalForCycle(1, sections, evidence, 'test-case-applies-the-discount')).toMatchObject({ scope: 'run-wide', source: 'stamped', section: { iteration: 1 } })
    expect(journalForCycle(2, sections, evidence, 'test-case-applies-the-discount')).toMatchObject({ scope: 'case', source: 'stamped', section: { iteration: 2 } })
    expect(journalForCycle(3, sections, evidence)).toBeUndefined()
  })

  it('never narrows an entry to one of two cases that share a name', () => {
    const evidence = stamped()
    const sections = [section({ cycle: 1, failingTests: ['test-case-loads-the-page'] })]
    expect(journalForCycle(1, sections, evidence, 'test-case-loads-the-page')?.scope).toBe('run-wide')
  })

  it('pairs a legacy journal with cycles by order only when the counts match', () => {
    const evidence = legacy()
    const two = [section({ iteration: 2 }), section({ iteration: 1 })]
    expect(journalForCycle(2, two, evidence)).toMatchObject({ source: 'derived', section: { iteration: 2 } })
    // A heading the parser could not number sorts first rather than throwing.
    expect(journalForCycle(1, [section({ iteration: 2 }), section({ iteration: null })], evidence)?.section.iteration).toBeNull()
    expect(journalForCycle(1, [section({ iteration: 1 })], evidence)).toBeUndefined()
  })
})

describe('playbackAttempts', () => {
  it('ignores events the identity left unassigned and records raw steps', () => {
    const events: PlaywrightPlaybackEvent[] = [
      { type: 'step-begin', time: '0', test: { name: 'orphan', title: 'orphan' }, step: { title: 's', category: 'pw:api' } },
      { type: 'test-begin', time: '1', test: { name: 'a', title: 'a', location: 'a.spec.ts:1' } },
      { type: 'step-end', time: '2', test: { name: 'a', title: '' }, step: { title: 'unopened', category: 'pw:api' } },
    ]
    const { attempts, caseEvidence } = playbackAttempts(events, { eventKeys: [null, { caseKey: 'a', attemptKey: '1' }, { caseKey: 'a', attemptKey: '1' }] })
    expect(attempts).toEqual([{ attemptKey: '1', caseKey: 'a', name: 'a', title: 'a', location: 'a.spec.ts:1', startedAt: '1', steps: [{ title: 'unopened', category: 'pw:api', ended: true }] }])
    expect([...caseEvidence.get('a')!.locations]).toEqual(['a.spec.ts:1'])
  })
})

describe('mediaForAttempt', () => {
  const shot = (name: string) => ({ name, kind: 'screenshot' as const, path: name, url: `/u/${name}`, sizeBytes: 1, mtimeMs: 1 })

  it('uses an attempt\'s own retained copy and says when a stamped attempt kept none', () => {
    const evidence = stamped()
    const discount = byId(evidence, 'discount')
    const [first, , last] = discount.attempts
    const detail = { attemptArtifacts: { [first.attemptKey]: [shot('before.png')] } }
    expect(mediaForAttempt(first, evidence, detail)).toEqual({ kind: 'attempt', artifacts: [shot('before.png')] })
    expect(mediaForAttempt(last, evidence, detail)).toEqual({ kind: 'none', reason: 'not-retained' })
  })

  it('gives a legacy latest attempt the latest copy, and refuses older or same-name attempts', () => {
    const evidence = legacy()
    const discount = byId(evidence, 'discount')
    const detail = { playwrightArtifacts: [
      { testName: 'test-case-applies-the-discount', artifacts: [shot('latest.png')] },
      { testName: 'test-case-loads-the-page', artifacts: [shot('whose.png')] },
    ] }
    expect(mediaForAttempt(discount.latest!, evidence, detail)).toEqual({ kind: 'latest-copy', artifacts: [shot('latest.png')] })
    expect(mediaForAttempt(discount.attempts[0], evidence, detail)).toEqual({ kind: 'none', reason: 'superseded' })
    expect(mediaForAttempt(byId(evidence, 'home-loads').latest!, evidence, detail)).toEqual({ kind: 'none', reason: 'ambiguous' })
    expect(mediaForAttempt(byId(evidence, 'inventory').latest!, evidence, detail)).toEqual({ kind: 'none', reason: 'not-retained' })
  })
})

describe('journalDiffBlock', () => {
  it('reads the inline cycle diff and flags a capped one', () => {
    expect(journalDiffBlock(evidenceJournalMarkdown)).toEqual({ diff: expect.stringContaining('+++ b/src/pricing.ts'), truncated: false })
    const cut = '### Diff\n\n```diff\n--- a/x\n... (truncated, 120 more bytes)\n```\n'
    expect(journalDiffBlock(cut)).toEqual({ diff: '--- a/x\n... (truncated, 120 more bytes)', truncated: true })
    expect(journalDiffBlock('- hypothesis: no diff')).toBeUndefined()
  })
})
