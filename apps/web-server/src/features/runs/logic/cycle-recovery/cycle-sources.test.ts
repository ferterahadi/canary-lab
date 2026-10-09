import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { cycleDiffs, cyclePatchPath } from './cycle-sources'
import { truncateDiffForJournal } from '../runtime/heal-journal'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-cycle-sources-')

const diffOf = (file: string, from: string, to: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}`
const entry = (iteration: number, diff?: string) =>
  `## Iteration ${iteration} — 2026-01-01T00:0${iteration}:00.000Z\n\n- outcome: pending\n\n${diff === undefined ? '' : `### Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`}\n`

function runDir(journal: string, patches: Record<string, string> = {}): string {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'diagnosis-journal.md'), journal)
  for (const [name, text] of Object.entries(patches)) {
    fs.mkdirSync(path.join(dir, 'diffs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'diffs', name), text)
  }
  return dir
}

describe('cycleDiffs', () => {
  it('prefers a cycle\'s persisted patch over the journal\'s inline copy', () => {
    const dir = runDir(entry(1, diffOf('a.ts', 'one', 'inline')), { 'iteration-1.patch': `${diffOf('a.ts', 'one', 'patch')}\n` })
    const diff = cycleDiffs(dir).get(1)!
    expect(diff).toMatchObject({ iteration: 1, source: 'patch', patchPath: cyclePatchPath(dir, 1), truncated: false, timestamp: '2026-01-01T00:01:00.000Z' })
    expect(diff.files[0].rows.map((row) => row.after)).toEqual(['patch'])
  })

  it('falls back to the inline diff and says when the journal cut it', () => {
    const long = `${diffOf('a.ts', 'one', 'two')}\n+${'x'.repeat(200)}`
    const dir = runDir(entry(1, truncateDiffForJournal(long, 120)) + entry(2, diffOf('b.ts', 'b', 'c')))
    const diffs = cycleDiffs(dir)
    expect(diffs.get(1)).toMatchObject({ source: 'journal', patchPath: null, truncated: true })
    expect(diffs.get(1)!.files[0].truncated).toBe(true)
    expect(diffs.get(2)).toMatchObject({ source: 'journal', truncated: false })
  })

  it('skips a cycle with no diff, keeps a patch with no entry, and orders cycles', () => {
    const dir = runDir(entry(3, diffOf('a.ts', 'a', 'b')) + entry(1), { 'iteration-2.patch': diffOf('a.ts', 'z', 'a'), 'notes.txt': 'not a patch' })
    const diffs = cycleDiffs(dir)
    expect([...diffs.keys()]).toEqual([2, 3])
    expect(diffs.get(2)).toMatchObject({ source: 'patch', timestamp: null })
  })

  it('keeps the entry the journal wrote last for a repeated cycle', () => {
    const dir = runDir(entry(1, diffOf('a.ts', 'a', 'first')) + entry(1, diffOf('a.ts', 'a', 'second')))
    expect(cycleDiffs(dir).get(1)!.files[0].rows[0].after).toBe('second')
  })

  it('reads nothing from a run with no journal and no patches', () => {
    expect(cycleDiffs(tempDir()).size).toBe(0)
  })
})
