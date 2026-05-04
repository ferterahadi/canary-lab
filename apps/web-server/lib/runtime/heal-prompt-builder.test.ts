import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-hpb-')))
const logsDir = path.join(tmpRoot, 'logs')
const summaryPath = path.join(logsDir, 'e2e-summary.json')
const journalPath = path.join(logsDir, 'diagnosis-journal.md')

vi.mock('./paths', () => ({
  DIAGNOSIS_JOURNAL_PATH: journalPath,
  getSummaryPath: () => summaryPath,
}))

const { buildHealAddendum } = await import('./heal-prompt-builder')

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

describe('buildHealAddendum', () => {
  it('omits optional cycle and failure details when no summary exists', () => {
    const addendum = buildHealAddendum({ cycle: 1 })
    expect(addendum).toContain('Cycle 1.')
    expect(addendum).not.toContain('Failing tests:')
    expect(addendum).not.toContain('Prior iterations exist')
  })

  it('includes max cycle, failed slugs, and journal guidance after the first cycle', () => {
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        failed: [{ name: 'test-case-a' }, { name: 123 }, {}, { name: 'test-case-b' }],
      }),
    )
    fs.writeFileSync(journalPath, '# Diagnosis Journal\n')

    const addendum = buildHealAddendum({ cycle: 2, maxCycles: 3 })

    expect(addendum).toContain('Cycle 2 of 3. Failing tests: test-case-a, test-case-b.')
    expect(addendum).toContain('Prior iterations exist')
  })
})
