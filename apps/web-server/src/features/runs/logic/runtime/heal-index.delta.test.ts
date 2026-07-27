import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeHealIndex } from './heal-index'
import { HEAL_INDEX_PATH as REAL_HEAL_INDEX, LOGS_DIR as REAL_LOGS } from './paths'

let tmpDir: string

beforeEach(() => {
  // The run dir sits under its own `runs/` root on purpose. writeHealIndex reads
  // cross-run flake history from `dirname(dirname(healIndexPath))` — pointing it
  // straight at a mkdtemp dir makes that the SYSTEM temp root, so the scan walks
  // every other test's leftovers: non-deterministic, and seconds slow once the
  // suite has been running a while.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-')))
  tmpDir = path.join(root, 'runs', '2026-01-01T0000-heal')
  fs.mkdirSync(tmpDir, { recursive: true })
})

describe('writeHealIndex failure delta vs previous cycle', () => {
  // The delta section gives the agent cross-cycle attribution: which tests
  // its prior turn unblocked, which it broke, which it left alone. Suppressed
  // on cycle 1 (no prior cycle to compare). Each bucket only appears when
  // non-empty.

  function readBody(healIndexPath: string): string {
    return fs.readFileSync(healIndexPath, 'utf-8')
  }

  it('suppresses the delta section on the first cycle (previousFailingSlugs empty/omitted)', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }, { name: 't2' }] },
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('suppresses the delta section when previousFailingSlugs is an empty array', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }] },
      previousFailingSlugs: [],
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('suppresses the section when current failures is empty (no failures, no delta to show)', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [] },
      previousFailingSlugs: ['t1', 't2'],
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('emits all three buckets when the failure set has mixed deltas', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      // Previous: t1, t2, t3 — current: t1 (still), t4 (new); t2 + t3 newly passing.
      summary: { failed: [{ name: 't1' }, { name: 't4' }] },
      previousFailingSlugs: ['t1', 't2', 't3'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (1): t1')
    expect(body).toContain('- newly failing (1): t4')
    expect(body).toContain('- newly passing (2): t2, t3')
  })

  it('emits only the still-failing bucket when nothing changed', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }, { name: 't2' }] },
      previousFailingSlugs: ['t1', 't2'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (2): t1, t2')
    expect(body).not.toContain('- newly failing')
    expect(body).not.toContain('- newly passing')
  })

  it('emits only the newly-failing bucket when previous failures all passed but new ones appeared', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't3' }, { name: 't4' }] },
      previousFailingSlugs: ['t1', 't2'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- newly failing (2): t3, t4')
    expect(body).toContain('- newly passing (2): t1, t2')
    expect(body).not.toContain('- still failing')
  })

  it('preserves current-failure order from the summary in the still-failing bucket', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    writeHealIndex({
      manifest: { featureName: 'demo' },
      // Previous slugs in a different order than current.
      summary: { failed: [{ name: 'z' }, { name: 'a' }, { name: 'm' }] },
      previousFailingSlugs: ['a', 'm', 'z'],
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('- still failing (3): z, a, m')
  })

  it('falls back to the journal\'s latest failingTests when previousFailingSlugs is omitted', () => {
    // This is the production path: the reporter calls writeHealIndex without
    // any orchestrator state. The journal entry recorded in the prior cycle
    // becomes the previous-cycle source of truth.
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(runJournalPath, `## Iteration 1 — 2026-05-16T10:00:00Z

- run: r1
- failingTests: t1, t2, t3
- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }, { name: 't4' }] },
      journalPath: runJournalPath,
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('## Failure delta vs previous cycle')
    expect(body).toContain('- still failing (1): t1')
    expect(body).toContain('- newly failing (1): t4')
    expect(body).toContain('- newly passing (2): t2, t3')
  })

  it('explicit previousFailingSlugs takes precedence over the journal fallback', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(runJournalPath, `## Iteration 1 — t1

- failingTests: x, y
- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }] },
      // Caller's slugs override the journal — used by tests and any future
      // caller that knows the prior set independently.
      previousFailingSlugs: ['t1', 't2'],
      journalPath: runJournalPath,
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('- still failing (1): t1')
    expect(body).toContain('- newly passing (1): t2')
    // The journal slugs (x, y) MUST NOT appear.
    expect(body).not.toContain('newly passing (2): x, y')
  })

  it('falls back to no-delta when the latest journal entry has no failingTests field', () => {
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    // Iteration with no failingTests line — e.g., the journal append happened
    // before the summary was ready. Behavior: suppress the delta section.
    fs.writeFileSync(runJournalPath, `## Iteration 1 — t1

- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 't1' }] },
      journalPath: runJournalPath,
      healIndexPath,
    })
    expect(readBody(healIndexPath)).not.toContain('## Failure delta vs previous cycle')
  })

  it('uses ONLY the latest journal entry (older iterations are ignored)', () => {
    // The "previous" cycle is whichever one ran most recently — not a union
    // across all prior cycles. This pins that semantic.
    const healIndexPath = path.join(tmpDir, 'heal-index.md')
    const runJournalPath = path.join(tmpDir, 'diagnosis-journal.md')
    fs.writeFileSync(runJournalPath, `## Iteration 1 — t1

- failingTests: ancient-a, ancient-b
- signal: .rerun
- outcome: regression

## Iteration 2 — t2

- failingTests: recent-a, recent-b
- signal: .rerun
- outcome: pending
`)
    writeHealIndex({
      manifest: { featureName: 'demo' },
      summary: { failed: [{ name: 'recent-a' }, { name: 'new-c' }] },
      journalPath: runJournalPath,
      healIndexPath,
    })
    const body = readBody(healIndexPath)
    expect(body).toContain('- still failing (1): recent-a')
    expect(body).toContain('- newly failing (1): new-c')
    expect(body).toContain('- newly passing (1): recent-b')
    // Ancient iteration entries don't bleed in.
    expect(body).not.toContain('ancient-a')
    expect(body).not.toContain('ancient-b')
  })
})

describe('writeHealIndex partial-suite header (stoppedEarly)', () => {
  it('omits the stoppedEarly note when manifest does not carry one', () => {
    expect(() =>
      writeHealIndex({
        manifest: { featureName: 'demo' },
        summary: { failed: [{ name: 'a' }] },
      }),
    ).not.toThrow()
  })

  it('renders a one-line note for max-failures stops', () => {
    // We can't easily inspect the on-disk file without touching real paths,
    // but we can assert the function tolerates the field. The pluralisation
    // branches below cover the actual rendered text via a temp HEAL_INDEX.
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'max-failures', failuresAtStop: 1, suiteTotal: 11 },
        },
        summary: { failed: [{ name: 'a' }] },
      }),
    ).not.toThrow()
  })

  it('renders a one-line note for user-pause stops with plural failure counts', () => {
    expect(() =>
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'user-pause', failuresAtStop: 3, suiteTotal: 7 },
        },
        summary: { failed: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      }),
    ).not.toThrow()
  })

  it('writes the note text to disk and toggles plural forms', () => {
    // Drive writeHealIndex against the real LOGS_DIR (the module hard-codes
    // HEAL_INDEX_PATH). Snapshot + restore so the test is hermetic.
    let createdLogs = false
    if (!fs.existsSync(REAL_LOGS)) {
      fs.mkdirSync(REAL_LOGS, { recursive: true })
      createdLogs = true
    }
    const prior = fs.existsSync(REAL_HEAL_INDEX) ? fs.readFileSync(REAL_HEAL_INDEX, 'utf-8') : null
    try {
      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'max-failures', failuresAtStop: 1, suiteTotal: 1 },
        },
        summary: { failed: [{ name: 'a' }] },
      })
      const oneOne = fs.readFileSync(REAL_HEAL_INDEX, 'utf-8')
      expect(oneOne).toMatch(/Stopped early: max-failures after 1 failure \(suite has 1 test;/)

      writeHealIndex({
        manifest: {
          featureName: 'demo',
          stoppedEarly: { reason: 'user-pause', failuresAtStop: 2, suiteTotal: 11 },
        },
        summary: { failed: [{ name: 'a' }, { name: 'b' }] },
      })
      const plural = fs.readFileSync(REAL_HEAL_INDEX, 'utf-8')
      expect(plural).toMatch(/Stopped early: user-pause after 2 failures \(suite has 11 tests;/)
    } finally {
      if (prior !== null) fs.writeFileSync(REAL_HEAL_INDEX, prior)
      else { try { fs.unlinkSync(REAL_HEAL_INDEX) } catch { /* ignore */ } }
      if (createdLogs) { try { fs.rmdirSync(REAL_LOGS) } catch { /* ignore */ } }
    }
  })
})
