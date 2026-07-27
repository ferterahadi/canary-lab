import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeHealIndex } from './heal-index'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-')))
})

describe('writeHealIndex cross-run flake history', () => {
  function mkRun(runsRoot: string, id: string, failed: string[], feature = 'demo'): void {
    const dir = path.join(runsRoot, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ feature }))
    fs.writeFileSync(
      path.join(dir, 'e2e-summary.json'),
      JSON.stringify({ failed: failed.map((name) => ({ name })) }),
    )
  }

  it('skips a prior run whose summary is missing or unreadable, without counting it', () => {
    // The `catch { continue }` around the prior-summary read. It used to be
    // covered only by accident: pointing the scan at a raw mkdtemp dir made its
    // root the system temp dir, where most siblings have no e2e-summary.json.
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'])
    const broken = path.join(runsRoot, '2026-01-02T0001-bad')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'manifest.json'), JSON.stringify({ feature: 'demo' }))
    // no e2e-summary.json at all
    const corrupt = path.join(runsRoot, '2026-01-03T0001-cor')
    fs.mkdirSync(corrupt, { recursive: true })
    fs.writeFileSync(path.join(corrupt, 'manifest.json'), JSON.stringify({ feature: 'demo' }))
    fs.writeFileSync(path.join(corrupt, 'e2e-summary.json'), '{ not json')
    const currentDir = path.join(runsRoot, '2026-01-04T0001-ddd')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    // Only the one readable prior run counts — the two unreadable ones are
    // skipped entirely rather than counted as a pass.
    expect(fs.readFileSync(healIndexPath, 'utf-8')).toContain(
      'failed in 1 of the last 1 run of this feature (persistent)',
    )
  })

  it('adds a per-test history line from prior sibling runs of the same feature', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'])
    mkRun(runsRoot, '2026-01-02T0001-bbb', [])
    mkRun(runsRoot, '2026-01-03T0001-ccc', ['a-test'])
    const currentDir = path.join(runsRoot, '2026-01-04T0001-ddd')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }, { name: 'b-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    const index = fs.readFileSync(healIndexPath, 'utf-8')
    expect(index).toContain('failed in 2 of the last 3 runs of this feature (intermittent — possible flake)')
    expect(index).toContain('failed in 0 of the last 3 runs of this feature (new — first failure in recent runs)')
  })

  it('only counts prior runs of the same feature and omits history when there are none', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'], 'other-feature')
    const currentDir = path.join(runsRoot, '2026-01-02T0001-bbb')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    expect(fs.readFileSync(healIndexPath, 'utf-8')).not.toContain('history:')
  })

  it('reads persistent for a test that failed every prior run', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-01-01T0001-aaa', ['a-test'])
    mkRun(runsRoot, '2026-01-02T0001-bbb', ['a-test'])
    const currentDir = path.join(runsRoot, '2026-01-03T0001-ccc')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 2 of the last 2 runs of this feature (persistent)')
  })

  it('uses singular "run" wording when exactly one prior run is inspected', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    mkRun(runsRoot, '2026-04-01T0001-aaa', ['a-test'])
    const currentDir = path.join(runsRoot, '2026-04-02T0001-bbb')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 1 of the last 1 run of this feature (persistent)')
  })

  it('caps cross-run inspection at FLAKE_HISTORY_RUN_LIMIT (5) even with more sibling runs', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    // 6 prior runs, all matching feature, all failing 'a-test'. Only the 5
    // lexicographically-newest may be inspected.
    for (let i = 1; i <= 6; i++) {
      mkRun(runsRoot, `2026-05-0${i}T0001-aaa`, ['a-test'])
    }
    const currentDir = path.join(runsRoot, '2026-05-07T0001-zzz')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    // If the limit weren't enforced this would read "6 of the last 6".
    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 5 of the last 5 runs of this feature (persistent)')
  })

  it('tolerates a prior run summary with a non-array `failed` field and non-string names', () => {
    const runsRoot = path.join(tmpDir, 'runs')
    const dirA = path.join(runsRoot, '2026-06-01T0001-aaa')
    fs.mkdirSync(dirA, { recursive: true })
    fs.writeFileSync(path.join(dirA, 'manifest.json'), JSON.stringify({ feature: 'demo' }))
    fs.writeFileSync(path.join(dirA, 'e2e-summary.json'), JSON.stringify({})) // no `failed` field at all

    const dirB = path.join(runsRoot, '2026-06-02T0001-bbb')
    fs.mkdirSync(dirB, { recursive: true })
    fs.writeFileSync(path.join(dirB, 'manifest.json'), JSON.stringify({ feature: 'demo' }))
    fs.writeFileSync(path.join(dirB, 'e2e-summary.json'), JSON.stringify({ failed: [{ name: 123 }] })) // non-string name

    const currentDir = path.join(runsRoot, '2026-06-03T0001-ccc')
    fs.mkdirSync(currentDir, { recursive: true })
    const healIndexPath = path.join(currentDir, 'heal-index.md')

    writeHealIndex({
      manifest: { feature: 'demo' },
      summary: { failed: [{ name: 'a-test' }] },
      healIndexPath,
      journalPath: path.join(currentDir, 'diagnosis-journal.md'),
    })

    // Both prior runs parse without throwing and both count as "inspected",
    // but neither ever matches 'a-test' as failed (one had no `failed` array,
    // the other's only entry had a non-string name that never equals the slug).
    expect(fs.readFileSync(healIndexPath, 'utf-8'))
      .toContain('failed in 0 of the last 2 runs of this feature (new — first failure in recent runs)')
  })
})

describe('cross-run flake history when the runs root is unreadable', () => {
  it('omits the history rather than failing the heal index', () => {
    // The heal index is written into a run dir whose PARENT (the runs root the
    // history scan walks) does not exist. A run that cannot look at its
    // siblings must still get an index — losing the flake line is acceptable,
    // losing the agent's instructions is not.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-le-'))
    const healIndexPath = path.join(base, 'missing-root', 'run-1', 'heal-index.md')
    try {
      writeHealIndex({
        manifest: { feature: 'demo' },
        summary: { failed: [{ name: 'test-case-a', error: { message: 'boom' } }] },
        healIndexPath,
        journalPath: path.join(base, 'missing-root', 'run-1', 'journal.md'),
      })

      const written = fs.readFileSync(healIndexPath, 'utf-8')
      expect(written).toContain('## Failures')
      expect(written).not.toContain('flaky')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
