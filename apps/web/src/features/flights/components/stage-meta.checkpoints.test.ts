import { describe, expect, it } from 'vitest'
import { CHECKPOINT_OPTIONS } from '@shared/flights/types'
import { checkpointOptionLabel, checkpointTitle } from './stage-meta'

// The checkpoint display vocabulary must cover the whole wire vocabulary.
//
// `checkpointTitle` / `checkpointOptionLabel` fall back to the raw key on a miss,
// and that fallback is deliberate — a client on a newer server still renders a
// readable button instead of a blank one. But a fallback is a safety net, not a
// specification: while nothing checked the maps, a stage could add or rename an
// option and the UI would quietly ship a button labelled `collect-repo-docs`.
//
// So the fallback stays for runtime, and this pins the shipped state at build
// time. `CHECKPOINT_OPTIONS` is the single source both sides answer from, which
// is what makes the assertion meaningful rather than a restatement of the map.
describe('checkpoint display vocabulary', () => {
  const kinds = Object.keys(CHECKPOINT_OPTIONS) as Array<keyof typeof CHECKPOINT_OPTIONS>

  // The one kind whose options are never RENDERED as buttons. `external-work`
  // parks a flight the MCP client drives, and that flight is read-only in this
  // UI — its two answers ('submit', 'run-internally') belong to the agent
  // holding the step. Labels for buttons nobody can press are labels that rot,
  // so the map deliberately has no entry, and this names the exemption rather
  // than weakening the check for every other kind.
  const NEVER_RENDERED: ReadonlySet<string> = new Set(['external-work'])

  it('covers every checkpoint kind with a title', () => {
    const unlabelled = kinds.filter((kind) => checkpointTitle(kind) === kind)
    expect(unlabelled).toEqual([])
  })

  it('covers every option of every kind with a label', () => {
    const unlabelled: string[] = []
    for (const kind of kinds) {
      if (NEVER_RENDERED.has(kind)) continue
      for (const option of CHECKPOINT_OPTIONS[kind]) {
        if (checkpointOptionLabel(kind, option) === option) unlabelled.push(`${kind}/${option}`)
      }
    }
    expect(unlabelled).toEqual([])
  })

  // The negative control: without it the two tests above would still pass if
  // the fallback were changed to return a constant, proving nothing about
  // coverage. An unknown key must still come back as itself.
  it('still falls back to the raw key for an unknown kind or option', () => {
    expect(checkpointTitle('not-a-real-kind')).toBe('not-a-real-kind')
    expect(checkpointOptionLabel('run-failed', 'not-a-real-option')).toBe('not-a-real-option')
    expect(checkpointOptionLabel('not-a-real-kind', 'rerun')).toBe('rerun')
  })
})
