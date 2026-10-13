import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import { appendJournalIteration } from './run-manifest-writer'
import type { JournalAppendInput } from './heal-journal'

const dirs = trackTempDirs('journal-context-')
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture() {
  const made = makeHealLoopContext({ root: dirs() })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  fs.writeFileSync(made.ctx.paths.manifestPath, JSON.stringify({ feature: 'selected-suite' }))
  fs.writeFileSync(made.ctx.paths.summaryPath, JSON.stringify({ failed: [{ name: 'selected failure' }] }))
  return made
}

describe('run journal context', () => {
  it('accepts entry content without caller-owned run paths', () => {
    expectTypeOf<Parameters<typeof appendJournalIteration>[1]>().toEqualTypeOf<
      Omit<JournalAppendInput, 'runId' | 'manifestPath' | 'summaryPath' | 'journalPath'>
    >()
  })

  it('writes the same entry to the selected run before notifying its store', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    const { ctx, sink } = fixture()
    const journal = ctx.paths.diagnosisJournalPath
    vi.mocked(sink.recordJournalChange).mockImplementation((runId) => {
      expect(runId).toBe(ctx.runId)
      expect(fs.readFileSync(journal, 'utf8')).toContain('## Iteration 1')
    })
    // Extra runtime fields cannot redirect writes even if an untyped caller supplies them.
    const entry = {
      signal: '.restart' as const, hypothesis: 'Repair selected failure',
      filesChanged: ['app.ts'], fixDescription: 'Correct behavior', diffContent: '-old\n+new',
      runId: 'wrong-run', manifestPath: 'wrong-manifest', summaryPath: 'wrong-summary',
      journalPath: path.join(ctx.runDir, 'wrong-journal.md'),
    }
    appendJournalIteration(ctx, entry)
    expect(fs.readFileSync(journal, 'utf8')).toBe([
      '# Diagnosis Journal', '',
      '## Iteration 1 — 2026-01-02T03:04:05.000Z', '',
      `- run: ${ctx.runId}`, '- feature: selected-suite', '- failingTests: selected failure',
      '- hypothesis: Repair selected failure', '- fix.file: app.ts',
      '- fix.description: Correct behavior', '- signal: .restart', '- outcome: pending', '',
      '### Diff', '', '```diff', '-old', '+new', '```', '',
    ].join('\n'))
    expect(fs.existsSync(entry.journalPath)).toBe(false)
    expect(entry.runId).toBe('wrong-run')
    expect(sink.recordJournalChange).toHaveBeenCalledExactlyOnceWith(ctx.runId)
  })

  it('notifies after a skipped empty hypothesis without creating a journal', () => {
    const { ctx, sink } = fixture()
    appendJournalIteration(ctx, { signal: '.rerun', hypothesis: '  ' })
    expect(fs.existsSync(ctx.paths.diagnosisJournalPath)).toBe(false)
    expect(sink.recordJournalChange).toHaveBeenCalledExactlyOnceWith(ctx.runId)
  })

  it('propagates a write failure without notifying', () => {
    const { ctx, sink } = fixture()
    fs.mkdirSync(ctx.paths.diagnosisJournalPath)
    expect(() => appendJournalIteration(ctx, { signal: 'none', hypothesis: 'No repair' })).toThrow()
    expect(sink.recordJournalChange).not.toHaveBeenCalled()
  })

  it('propagates a store failure after preserving the written entry', () => {
    const { ctx, sink } = fixture()
    const failure = new Error('store unavailable')
    vi.mocked(sink.recordJournalChange).mockImplementation(() => { throw failure })
    expect(() => appendJournalIteration(ctx, { signal: '.rerun', hypothesis: 'Repair' })).toThrow(failure)
    expect(fs.readFileSync(ctx.paths.diagnosisJournalPath, 'utf8')).toContain('- hypothesis: Repair')
    expect(sink.recordJournalChange).toHaveBeenCalledExactlyOnceWith(ctx.runId)
  })
})
