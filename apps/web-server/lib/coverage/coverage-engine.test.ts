import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  runCoverageEngine,
  acceptProposedMapping,
  rejectProposedMapping,
  regeneratePrdSummary,
} from './service'
import { readProposedMappings } from './proposed-mappings'

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
    expect(res.proposed).toEqual([])

    // The spec file now carries the @req- tag (mapping written, body untouched).
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
    expect(spec).toContain('@req-R1')
    expect(spec).toContain('expect(1).toBe(1)')

    // The recomputed ledger sees the test as annotated, no longer an orphan.
    expect(res.ledger.orphanTestNames).not.toContain('create makes a new todo item')
    expect(res.ledger.requirements[0].annotatedTestNames).toContain('create makes a new todo item')
  })
})

describe('runCoverageEngine — review mode', () => {
  it('stores proposals without touching the spec, then accept writes the tag', async () => {
    const dir = writeFeature('checkout')
    await seedSummary('checkout')

    const res = await runCoverageEngine({
      featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', reviewMode: true, now: '2026-01-01T00:00:00Z',
    })
    expect(res.applied).toEqual([])
    expect(res.proposed.map((m) => m.testName)).toContain('create makes a new todo item')
    // Spec untouched in review mode.
    expect(fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')).not.toContain('@req-')
    // Proposals persisted + surfaced on the ledger.
    expect(readProposedMappings(dir)?.proposals.length).toBe(1)
    expect(res.ledger.proposedMappings?.length).toBe(1)

    // Accept → tag written, store cleared.
    const accepted = acceptProposedMapping({ featuresDir, logsDir, feature: 'checkout', testName: 'create makes a new todo item' })
    expect(accepted.applied?.requirements).toEqual(['R1'])
    expect(fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')).toContain('@req-R1')
    expect(readProposedMappings(dir)).toBeNull()
    expect(accepted.ledger.proposedMappings).toBeUndefined()
  })

  it('reject drops the proposal and never writes a tag', async () => {
    const dir = writeFeature('checkout')
    await seedSummary('checkout')
    await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', reviewMode: true })

    const rejected = rejectProposedMapping({ featuresDir, logsDir, feature: 'checkout', testName: 'create makes a new todo item' })
    expect(rejected.rejected?.testName).toBe('create makes a new todo item')
    expect(fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')).not.toContain('@req-')
    expect(readProposedMappings(dir)).toBeNull()
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
