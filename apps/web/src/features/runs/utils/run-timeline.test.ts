import { describe, expect, it } from 'vitest'
import type { AuditEntry, RunLifecycleEvent } from '../../../shared/api/types'
import { buildTimelineRows, lifecycleDurationLabel } from './run-timeline'

function engine(overrides: Partial<RunLifecycleEvent> & Pick<RunLifecycleEvent, 'phase' | 'headline' | 'updatedAt'>): RunLifecycleEvent {
  return { ...overrides }
}

function audit(overrides: Partial<AuditEntry> & Pick<AuditEntry, 'ts' | 'action'>): AuditEntry {
  return { sessionId: null, clientKind: null, ...overrides }
}

const NOW = Date.parse('2026-05-26T10:30:00.000Z')

describe('buildTimelineRows', () => {
  it('maps engine events with durations measured between consecutive engine events', () => {
    const rows = buildTimelineRows(
      [
        engine({ phase: 'starting-services', headline: 'Starting services', detail: 'Starting 2 services.', updatedAt: '2026-05-26T10:19:05.000Z', severity: 'info' }),
        engine({ phase: 'running-tests', headline: 'Running Playwright tests', updatedAt: '2026-05-26T10:19:16.100Z' }),
        engine({ phase: 'failed', headline: 'Run failed', updatedAt: '2026-05-26T10:19:17.600Z', severity: 'error' }),
      ],
      [],
      { now: NOW },
    )

    expect(rows.map((r) => r.headline)).toEqual(['Starting services', 'Running Playwright tests', 'Run failed'])
    expect(rows.every((r) => r.source === 'engine')).toBe(true)
    expect(rows[0].durationLabel).toBe('took 11.1s')
    expect(rows[1].durationLabel).toBe('took 1.5s')
    expect(rows[2].durationLabel).toBeNull() // terminal phase, last event
    expect(rows[0].detail).toBe('Starting 2 services.')
    expect(rows[1].severity).toBe('info') // missing severity falls back to info
    expect(rows[2].severity).toBe('error')
    expect(rows[2].isLastEngine).toBe(true)
    expect(rows[0].isLastEngine).toBe(false)
    expect(rows[2].event?.phase).toBe('failed')
  })

  it('labels the last non-terminal engine event with elapsed time using now', () => {
    const rows = buildTimelineRows(
      [engine({ phase: 'running-tests', headline: 'Running Playwright tests', updatedAt: '2026-05-26T10:29:57.000Z' })],
      [],
      { now: Date.parse('2026-05-26T10:30:00.000Z') },
    )
    expect(rows[0].durationLabel).toBe('for 3.0s')
  })

  it('interleaves external audit entries by timestamp without disturbing engine durations', () => {
    const rows = buildTimelineRows(
      [
        engine({ phase: 'starting-services', headline: 'Starting services', updatedAt: '2026-05-26T10:19:05.000Z' }),
        engine({ phase: 'running-tests', headline: 'Running Playwright tests', updatedAt: '2026-05-26T10:19:16.100Z' }),
        engine({ phase: 'failed', headline: 'Run failed', updatedAt: '2026-05-26T10:19:17.600Z', severity: 'error' }),
      ],
      [
        audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim', clientKind: 'claude-cli', sessionId: 'claude-001' }),
        audit({ ts: '2026-05-26T10:19:10.000Z', action: 'stale-disconnect', clientKind: 'claude-cli', sessionId: 'claude-001' }),
      ],
      { now: NOW },
    )

    expect(rows.map((r) => `${r.source}:${r.headline}`)).toEqual([
      'engine:Starting services',
      'external:Claimed the heal',
      'external:Went stale — disconnected',
      'engine:Running Playwright tests',
      'engine:Run failed',
    ])
    // The interleaved external rows must NOT shorten the engine gap.
    expect(rows[0].durationLabel).toBe('took 11.1s')
    expect(rows[3].durationLabel).toBe('took 1.5s')
    expect(rows[1].durationLabel).toBeNull()
    expect(rows[2].durationLabel).toBeNull()
  })

  it('maps external actions to humanized headlines, severity, client label and arg summary', () => {
    const rows = buildTimelineRows(
      [],
      [
        audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim', clientKind: 'claude-cli', sessionId: 'claude-001', args: { conversationName: 'test line integration' } }),
        audit({ ts: '2026-05-26T10:19:06.000Z', action: 'stale-disconnect', clientKind: 'claude-cli', sessionId: 'claude-001' }),
        audit({ ts: '2026-05-26T10:19:07.000Z', action: 'claim-reconnect', clientKind: 'claude-cli', sessionId: 'claude-001' }),
        audit({ ts: '2026-05-26T10:19:08.000Z', action: 'claim-rejected', clientKind: 'codex-cli', sessionId: 'codex-001' }),
        audit({ ts: '2026-05-26T10:19:09.000Z', action: 'release', clientKind: 'claude-cli', sessionId: 'claude-001' }),
        audit({ ts: '2026-05-26T10:19:10.000Z', action: 'handoff', clientKind: 'claude-cli', sessionId: 'claude-001' }),
      ],
      { now: NOW },
    )

    expect(rows[0]).toMatchObject({ source: 'external', severity: 'success', headline: 'Claimed the heal', clientLabel: 'Claude CLI', durationLabel: null })
    expect(rows[0].detail).toContain('conversationName=test line integration')
    expect(rows[1]).toMatchObject({ severity: 'warning', headline: 'Went stale — disconnected' })
    expect(rows[2]).toMatchObject({ severity: 'success', headline: 'Reconnected to the heal' })
    expect(rows[3]).toMatchObject({ severity: 'error', headline: 'Heal claim rejected', clientLabel: 'Codex CLI' })
    expect(rows[4]).toMatchObject({ severity: 'info', headline: 'Released the heal' })
    expect(rows[5]).toMatchObject({ severity: 'info', headline: 'Handed off the heal' })
  })

  it('falls back to the raw action name for unknown external actions', () => {
    const rows = buildTimelineRows([], [audit({ ts: '2026-05-26T10:19:05.000Z', action: 'frobnicate', clientKind: 'other' })], { now: NOW })
    expect(rows[0]).toMatchObject({ source: 'external', headline: 'Frobnicate', severity: 'info' })
  })

  it('leaves an empty unknown external action label empty', () => {
    const rows = buildTimelineRows([], [audit({ ts: '2026-05-26T10:19:05.000Z', action: '', clientKind: 'other' })], { now: NOW })
    expect(rows[0]).toMatchObject({ source: 'external', headline: '', severity: 'info' })
  })

  it('leaves client label and detail null when the entry has no client or args', () => {
    const rows = buildTimelineRows([], [audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim' })], { now: NOW })
    expect(rows[0].clientLabel).toBeNull()
    expect(rows[0].detail).toBeNull()
  })

  it('returns only engine rows when there is no external activity', () => {
    const events = [
      engine({ phase: 'starting-services', headline: 'Starting services', updatedAt: '2026-05-26T10:19:05.000Z' }),
      engine({ phase: 'passed', headline: 'Run passed', updatedAt: '2026-05-26T10:19:06.000Z', severity: 'success' }),
    ]
    const rows = buildTimelineRows(events, [], { now: NOW })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'engine')).toBe(true)
  })

  it('orders engine before external when timestamps tie', () => {
    const rows = buildTimelineRows(
      [engine({ phase: 'starting-services', headline: 'Starting services', updatedAt: '2026-05-26T10:19:05.000Z' })],
      [audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim', clientKind: 'claude-cli' })],
      { now: NOW },
    )
    expect(rows.map((r) => r.source)).toEqual(['engine', 'external'])
  })

  it('skips null args and formats string (truncated), number, boolean and object values', () => {
    const longNote = 'this note is definitely much longer than forty characters'
    const rows = buildTimelineRows(
      [],
      [
        audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim', args: { skip: null, note: longNote, attempt: 2, force: true } }),
        audit({ ts: '2026-05-26T10:19:06.000Z', action: 'claim', args: { target: { id: 7 } } }),
      ],
      { now: NOW },
    )
    expect(rows[0].detail).toBe(`note=${longNote.slice(0, 39)}…  attempt=2  force=true`)
    expect(rows[1].detail).toBe('target={"id":7}')
  })

  it('maps desktop client kinds to their labels', () => {
    const rows = buildTimelineRows(
      [],
      [
        audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim', clientKind: 'claude-desktop' }),
        audit({ ts: '2026-05-26T10:19:06.000Z', action: 'claim', clientKind: 'codex-desktop' }),
      ],
      { now: NOW },
    )
    expect(rows[0].clientLabel).toBe('Claude Desktop')
    expect(rows[1].clientLabel).toBe('Codex Desktop')
  })

  it('leaves detail null when every arg value is null', () => {
    const rows = buildTimelineRows([], [audit({ ts: '2026-05-26T10:19:05.000Z', action: 'claim', args: { conversationName: null } })], { now: NOW })
    expect(rows[0].detail).toBeNull()
  })
})

describe('lifecycleDurationLabel', () => {
  it('returns null when the event timestamp is missing or unparseable', () => {
    expect(lifecycleDurationLabel([], 0, NOW)).toBeNull()
    expect(lifecycleDurationLabel([engine({ phase: 'running-tests', headline: 'x', updatedAt: 'not-a-date' })], 0, NOW)).toBeNull()
  })

  it('returns null when the next event has an unparseable or earlier timestamp', () => {
    const unparseableNext = [
      engine({ phase: 'starting-services', headline: 'a', updatedAt: '2026-05-26T10:19:05.000Z' }),
      engine({ phase: 'running-tests', headline: 'b', updatedAt: 'not-a-date' }),
    ]
    expect(lifecycleDurationLabel(unparseableNext, 0, NOW)).toBeNull()

    const goesBackwards = [
      engine({ phase: 'starting-services', headline: 'a', updatedAt: '2026-05-26T10:19:06.000Z' }),
      engine({ phase: 'running-tests', headline: 'b', updatedAt: '2026-05-26T10:19:05.000Z' }),
    ]
    expect(lifecycleDurationLabel(goesBackwards, 0, NOW)).toBeNull()
  })
})
