import { describe, it, expect } from 'vitest'
import { newestFirst } from './journal-order'
import type { JournalSection } from './run-detail'

const entry = (overrides: Partial<JournalSection>): JournalSection => ({
  iteration: 1,
  timestamp: 't',
  feature: null,
  run: null,
  outcome: null,
  hypothesis: null,
  body: '',
  ...overrides,
})

describe('newestFirst', () => {
  it('sorts by iteration descending', () => {
    const out = newestFirst([entry({ iteration: 1 }), entry({ iteration: 3 }), entry({ iteration: 2 })])
    expect(out.map((e) => e.iteration)).toEqual([3, 2, 1])
  })

  it('sinks entries with null iteration to the bottom', () => {
    const out = newestFirst([entry({ iteration: null }), entry({ iteration: 5 })])
    expect(out.map((e) => e.iteration)).toEqual([5, null])
  })

  it('treats missing iteration like null when sorting', () => {
    const missingIteration = entry({}) as JournalSection
    delete (missingIteration as { iteration?: number | null }).iteration

    const out = newestFirst([missingIteration, entry({ iteration: 2 })])
    expect(out.map((e) => e.iteration ?? null)).toEqual([2, null])
  })

  it('sinks null iteration when the null entry is already last', () => {
    // V8's sort calls compare(arr[i+1], arr[i]), so we need the nullish
    // entry as the *later* element to exercise the `a.iteration ?? ...`
    // nullish arm (as opposed to `b.iteration ?? ...` which fires when
    // the null entry is first).
    const out = newestFirst([entry({ iteration: 5 }), entry({ iteration: null })])
    expect(out.map((e) => e.iteration)).toEqual([5, null])
  })

  it('treats equal iterations as stable (returns 0)', () => {
    const out = newestFirst([
      entry({ iteration: 2, hypothesis: 'a' }),
      entry({ iteration: 2, hypothesis: 'b' }),
    ])
    expect(out.map((e) => e.hypothesis)).toEqual(['a', 'b'])
  })
})

it('preserves null ties, input order and entry identity', () => {
  const first = Object.freeze(entry({ iteration: null, hypothesis: 'first' }))
  const second = Object.freeze(entry({ iteration: null, hypothesis: 'second' }))
  const latest = Object.freeze(entry({ iteration: 3 }))
  const input = Object.freeze([first, second, latest])
  const output = newestFirst(input)
  expect(output).toEqual([latest, first, second])
  expect(output[1]).toBe(first)
  expect(input).toEqual([first, second, latest])
  expect(output).not.toBe(input)
})
