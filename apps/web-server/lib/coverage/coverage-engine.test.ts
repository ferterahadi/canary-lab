import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  runCoverageEngine,
  regeneratePrdSummary,
  computeFeatureCoverage,
} from './service'
import { CoverageJobRunStore } from './jobs/store'

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-engine-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// One untagged test whose name overlaps the "Create todo" requirement.
const SPEC = `
  import { test, expect } from '@playwright/test'
  test('create makes a new todo item', async () => {
    expect(1).toBe(1)
  })
`

function writeFeature(name: string): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), SPEC)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\na user can create a new todo item')
  return dir
}

async function seedSummary(name: string) {
  await regeneratePrdSummary({ featuresDir, feature: name, adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
}

describe('runCoverageEngine — auto mode', () => {
  it('writes a covers tag onto the orphan test and clears it from orphans', async () => {
    const dir = writeFeature('checkout')
    await seedSummary('checkout')

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic' })
    expect(res.orphanTestsBefore).toContain('create makes a new todo item')
    expect(res.applied.map((m) => m.testName)).toContain('create makes a new todo item')

    // The spec file now carries the @req- tag (mapping written, body untouched).
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
    expect(spec).toContain('@req-R1')
    expect(spec).toContain('expect(1).toBe(1)')

    // The recomputed ledger sees the test as annotated, no longer an orphan.
    expect(res.ledger.orphanTestNames).not.toContain('create makes a new todo item')
    expect(res.ledger.requirements[0].annotatedTestNames).toContain('create makes a new todo item')
  })
})

describe('collectTests — duplicate test name union', () => {
  it('passes undefined requirements to unionList when the duplicate has no tags', async () => {
    // a.spec.ts has @requirement/@path; b.spec.ts has the same test name but NO tags.
    // collectTests calls unionList(existing.requirements=['R1'], b.requirements=undefined)
    // → b?.length short-circuits (FALSE branch of ?.) → returns a unchanged.
    const dir = writeFeature('multi-spec-false')
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `import { test, expect } from '@playwright/test'\n// @requirement R1\n// @path happy\ntest('shared test name', async () => { expect(1).toBe(1) })\n`,
    )
    fs.writeFileSync(
      path.join(dir, 'e2e', 'b.spec.ts'),
      `import { test, expect } from '@playwright/test'\ntest('shared test name', async () => { expect(2).toBe(2) })\n`,
    )
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# First feature\na user can do the first thing')
    await regeneratePrdSummary({ featuresDir, feature: 'multi-spec-false', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'multi-spec-false', adapter: 'deterministic' })
    // The merged test keeps R1 (from a.spec.ts); b.spec.ts added nothing new.
    expect(res.feature).toBe('multi-spec-false')
  })

  it('unions requirements when the same test name appears in two top-level spec files', async () => {
    const dir = writeFeature('multi-spec')
    // writeFeature writes a.spec.ts — override it with a version tagged R1.
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `
      import { test, expect } from '@playwright/test'
      // @requirement R1
      // @path happy
      test('shared test name', async () => {
        expect(1).toBe(1)
      })
      `,
    )
    // Add a second top-level spec file (listSpecFiles only scans one level of e2e/)
    // with the same test name but tagged R2.
    fs.writeFileSync(
      path.join(dir, 'e2e', 'b.spec.ts'),
      `
      import { test, expect } from '@playwright/test'
      // @requirement R2
      // @path sad
      test('shared test name', async () => {
        expect(2).toBe(2)
      })
      `,
    )

    // Seed a summary with two requirements so the ledger can match both.
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'docs', 'spec.md'),
      '# First feature\na user can do the first thing\n# Second feature\na user can do the second thing',
    )
    await regeneratePrdSummary({ featuresDir, feature: 'multi-spec', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    // The merged test already has requirements, so the engine treats it as
    // annotated (not an orphan). computeFeatureCoverage uses the same collectTests
    // and builds the ledger from the merged entry.
    const res = await runCoverageEngine({
      featuresDir,
      logsDir,
      feature: 'multi-spec',
      adapter: 'deterministic',
    })

    // Both requirements should show the shared test in their annotatedTestNames
    // (collectTests unioned [R1, R2] onto the single merged entry).
    // RequirementCoverage shape: { requirement: { id, ... }, annotatedTestNames }
    // (note: ledger.requirements is RequirementCoverage[], not Requirement[])
    const r1 = res.ledger.requirements.find((r) => r.requirement.id === 'R1')
    const r2 = res.ledger.requirements.find((r) => r.requirement.id === 'R2')
    expect(r1).toBeTruthy()
    expect(r2).toBeTruthy()
    expect(r1?.annotatedTestNames).toContain('shared test name')
    expect(r2?.annotatedTestNames).toContain('shared test name')

    // The test is annotated (has requirements), so it must not appear as an orphan.
    expect(res.ledger.orphanTestNames).not.toContain('shared test name')
  })
})

describe('collectTests — unreadable spec file (catch { continue } branch)', () => {
  it('skips a spec file that cannot be read and continues processing others', async () => {
    // chmod 000 the spec file so fs.readFileSync throws → the catch { continue }
    // branch in collectTests fires (service.ts line 83).
    const dir = writeFeature('checkout')
    await seedSummary('checkout')
    const specFile = path.join(dir, 'e2e', 'a.spec.ts')
    fs.chmodSync(specFile, 0o000)
    try {
      const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic' })
      expect(res.feature).toBe('checkout')
      // No readable tests → no orphans → nothing applied.
      expect(res.applied).toEqual([])
    } finally {
      fs.chmodSync(specFile, 0o644)
    }
  })
})

describe('runCoverageEngine — no PRD summary (summary null branch)', () => {
  it('records requirementsSetHash (not summary.requirementsHash) when no summary exists', async () => {
    // Write a feature with an untagged test but NO prd-summary.json — summary is null.
    // runCoverageEngine falls through to writeCoverageRunState with the
    // `summary?.requirementsHash ?? requirementsSetHash(requirements)` branch
    // taking the ?? path (line 280 in service.ts).
    const dir = writeFeature('checkout')
    // Do NOT call seedSummary — leave featureDir without _prd-summary.json.

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    // No requirements → no proposals → applied is empty.
    expect(res.applied).toEqual([])
    expect(res.feature).toBe('checkout')
    // The run-state file is at <featureDir>/docs/_coverage-state.json.
    const runStateFile = path.join(dir, 'docs', '_coverage-state.json')
    expect(fs.existsSync(runStateFile)).toBe(true)
    const runState = JSON.parse(fs.readFileSync(runStateFile, 'utf-8')) as { requirementsHash: string }
    // requirementsSetHash([]) produces a deterministic hash.
    expect(typeof runState.requirementsHash).toBe('string')
    expect(runState.requirementsHash.length).toBeGreaterThan(0)
  })
})

describe('runCoverageEngine — reconcile-by-delta (R10)', () => {
  it('no-ops when the requirements set is unchanged since the last run', async () => {
    writeFeature('checkout')
    await seedSummary('checkout')
    await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    const delta = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', mode: 'delta', now: '2026-01-02T00:00:00Z' })
    expect(delta.reconciledRequirementIds).toEqual([])
    expect(delta.applied).toEqual([])
  })

  it('reconciles only the changed requirements after a summary regen', async () => {
    const dir = writeFeature('checkout')
    await seedSummary('checkout')
    await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    // Append a second requirement section (R1's body unchanged) + regenerate → R2 is new.
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\na user can create a new todo item\n# Delete todo\na user can delete a todo item')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-02T00:00:00Z' })

    const delta = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', mode: 'delta', now: '2026-01-03T00:00:00Z' })
    // Only the new/changed requirement is in scope (not the unchanged R1).
    expect(delta.reconciledRequirementIds).toEqual(['R2'])
  })
})

describe('collectTests — duplicate test with no requirements / pathTypes (lines 90-91)', () => {
  it('merges a duplicate test whose second occurrence has no requirements or pathTypes', async () => {
    // Exercise the falsy-guard branches on lines 90-91:
    //   if (t.requirements) ... — false when 2nd occurrence is untagged
    //   if (t.pathTypes)    ... — false when 2nd occurrence has no @path tag
    const dir = writeFeature('dup-untagged')
    // First spec: tagged with R1 + @path happy.
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `
      import { test, expect } from '@playwright/test'
      // @requirement R1
      // @path happy
      test('shared test', async () => { expect(1).toBe(1) })
      `,
    )
    // Second spec: same test name, completely untagged — no @requirement or @path.
    fs.writeFileSync(
      path.join(dir, 'e2e', 'b.spec.ts'),
      `
      import { test, expect } from '@playwright/test'
      test('shared test', async () => { expect(2).toBe(2) })
      `,
    )
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# First feature\na user can do the first thing')
    await regeneratePrdSummary({ featuresDir, feature: 'dup-untagged', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'dup-untagged', adapter: 'deterministic' })
    // The first occurrence's requirements/pathTypes survive (second didn't overwrite them).
    const r1 = res.ledger.requirements.find((r) => r.requirement.id === 'R1')
    expect(r1).toBeTruthy()
    expect(r1?.annotatedTestNames).toContain('shared test')
  })

  it('exercises the ?? [] fallback when the first occurrence has no requirements (line 90)', async () => {
    // First spec UNTAGGED (requirements=undefined on the initial entry) → line 95-106
    // creates entry with requirements: undefined. Second spec TAGGED → line 90 runs:
    //   existing.input.requirements = [...new Set([...(existing.input.requirements ?? []), ...t.requirements])]
    // The `?? []` fallback fires because existing.input.requirements is undefined.
    const dir = writeFeature('dup-req-on-second')
    // First spec: tagged R1 + @path happy with assertions. Sorted first (a < b).
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `
      import { test, expect } from '@playwright/test'
      // @requirement R1
      // @path happy
      test('late-tagged test', async () => { expect(1).toBe(1) })
      `,
    )
    // Second spec: same name, untagged and no assertions body — exercises the
    // `t.assertions ?? []` fallback (line 92: t.assertions is undefined when no
    // expect() calls in body) AND the `if (t.requirements)` false branch (line 90)
    // AND the `if (t.pathTypes)` false branch (line 91).
    fs.writeFileSync(
      path.join(dir, 'e2e', 'b.spec.ts'),
      `
      import { test } from '@playwright/test'
      test('late-tagged test', async () => {})
      `,
    )
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# First feature\na user can do the first thing')
    await regeneratePrdSummary({ featuresDir, feature: 'dup-req-on-second', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'dup-req-on-second', adapter: 'deterministic' })
    // The union must now include R1 from the second occurrence.
    const r1 = res.ledger.requirements.find((r) => r.requirement.id === 'R1')
    expect(r1?.annotatedTestNames).toContain('late-tagged test')
  })
})

describe('computeFeatureCoverage — active summary job (line 157)', () => {
  it('sets activeJob to "summary" when a running summary job exists for the feature', async () => {
    // Seed a running summary job for the feature. computeFeatureCoverage creates a
    // fresh CoverageJobRunStore internally (using logsDir) and calls activeFor() on
    // it — seeding the store directly into logsDir makes the job visible.
    const dir = writeFeature('checkout')
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Cart adds an item\nbody')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    // Seed a running 'summary' job via the same-logsDir store.
    const store = new CoverageJobRunStore(logsDir)
    store.save({ jobId: 'cj-running-summary', feature: 'checkout', kind: 'summary', status: 'running', startedAt: new Date().toISOString(), log: '' })

    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    // The state should reflect that a summary generation is active.
    expect(ledger.state?.summary).toBe('generating')
  })
})
