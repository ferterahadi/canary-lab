import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  splitJournalSections,
  filterSections,
  newestFirst,
  parseStructured,
  readJournal,
  deleteIterationSection,
} from './journal-store'

const SAMPLE = `# Diagnosis Journal

## Iteration 1 — 2026-04-22T01:20:11Z

- run: 2026-04-22T0120-aaaa
- feature: foo
- failingTests: a, b
- hypothesis: refresh token missing
- fix.file: app/x.ts
- signal: .restart
- outcome: no_change

## Iteration 2 — 2026-04-22T01:25:00Z

- run: 2026-04-22T0125-bbbb
- feature: bar
- hypothesis: wrong header
- signal: .rerun
- outcome: pending

## Iteration 3 — 2026-04-22T01:30:00Z

- run: 2026-04-22T0125-bbbb
- feature: foo
- hypothesis: third
- signal: .restart
- outcome: pending
`

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-jrnl-')))
})

describe('splitJournalSections', () => {
  it('parses iterations into sections with bodies preserved', () => {
    const s = splitJournalSections(SAMPLE)
    expect(s).toHaveLength(3)
    expect(s[0].iteration).toBe(1)
    expect(s[0].timestamp).toBe('2026-04-22T01:20:11Z')
    expect(s[0].feature).toBe('foo')
    expect(s[0].run).toBe('2026-04-22T0120-aaaa')
    expect(s[0].outcome).toBe('no_change')
    expect(s[0].hypothesis).toBe('refresh token missing')
    expect(s[0].body).toContain('## Iteration 1')
    expect(s[0].body).toContain('- fix.file: app/x.ts')
  })

  it('returns empty array for empty input', () => {
    expect(splitJournalSections('')).toEqual([])
  })

  it('ignores stray dash-fields outside any section', () => {
    expect(splitJournalSections('- orphan: x\n- another: y\n')).toEqual([])
  })
})

describe('filterSections / newestFirst', () => {
  it('filters by feature', () => {
    const s = splitJournalSections(SAMPLE)
    const f = filterSections(s, { feature: 'foo' })
    expect(f.map((x) => x.iteration)).toEqual([1, 3])
  })

  it('filters by run', () => {
    const s = splitJournalSections(SAMPLE)
    const f = filterSections(s, { run: '2026-04-22T0125-bbbb' })
    expect(f.map((x) => x.iteration)).toEqual([2, 3])
  })

  it('combined filter', () => {
    const s = splitJournalSections(SAMPLE)
    const f = filterSections(s, { feature: 'foo', run: '2026-04-22T0125-bbbb' })
    expect(f.map((x) => x.iteration)).toEqual([3])
  })

  it('returns all when filter is empty', () => {
    const s = splitJournalSections(SAMPLE)
    expect(filterSections(s, {}).length).toBe(3)
  })

  it('newestFirst orders by iteration descending', () => {
    const s = splitJournalSections(SAMPLE)
    const n = newestFirst(s)
    expect(n.map((x) => x.iteration)).toEqual([3, 2, 1])
  })

  it('newestFirst handles two null iterations equally', () => {
    const a = { iteration: null, timestamp: null, feature: null, run: null, outcome: null, hypothesis: null, body: '' }
    const b = { iteration: null, timestamp: null, feature: null, run: null, outcome: null, hypothesis: null, body: '' }
    expect(newestFirst([a, b])).toHaveLength(2)
  })

  it('newestFirst sinks null iterations to bottom', () => {
    const a = { iteration: null, timestamp: null, feature: null, run: null, outcome: null, hypothesis: null, body: '' }
    const b = { iteration: 5, timestamp: null, feature: null, run: null, outcome: null, hypothesis: null, body: '' }
    expect(newestFirst([a, b]).map((x) => x.iteration)).toEqual([5, null])
  })
})

describe('parseStructured', () => {
  it('delegates to the canonical parser', () => {
    const r = parseStructured(SAMPLE)
    expect(r).toHaveLength(3)
    expect(r[0].iteration).toBe(1)
  })
})

describe('readJournal', () => {
  it('returns empty when file missing', () => {
    expect(readJournal(path.join(tmpDir, 'nope.md'))).toEqual({ sections: [] })
  })

  it('reads and splits an existing file', () => {
    const file = path.join(tmpDir, 'j.md')
    fs.writeFileSync(file, SAMPLE)
    const { sections } = readJournal(file)
    expect(sections).toHaveLength(3)
  })
})

describe('deleteIterationSection', () => {
  it('removes the named iteration and rewrites the file', () => {
    const file = path.join(tmpDir, 'j.md')
    fs.writeFileSync(file, SAMPLE)
    expect(deleteIterationSection(file, 2)).toBe(true)
    const after = fs.readFileSync(file, 'utf-8')
    expect(after).not.toContain('## Iteration 2')
    expect(after).toContain('## Iteration 1')
    expect(after).toContain('## Iteration 3')
  })

  it('returns false when iteration not present', () => {
    const file = path.join(tmpDir, 'j.md')
    fs.writeFileSync(file, SAMPLE)
    expect(deleteIterationSection(file, 99)).toBe(false)
  })

  it('returns false when file missing', () => {
    expect(deleteIterationSection(path.join(tmpDir, 'absent.md'), 1)).toBe(false)
  })

  it('handles a final-iteration deletion (skipping continues to EOF)', () => {
    const file = path.join(tmpDir, 'j.md')
    fs.writeFileSync(file, SAMPLE)
    expect(deleteIterationSection(file, 3)).toBe(true)
    const after = fs.readFileSync(file, 'utf-8')
    expect(after).not.toContain('## Iteration 3')
    expect(after).toContain('## Iteration 2')
  })
})
