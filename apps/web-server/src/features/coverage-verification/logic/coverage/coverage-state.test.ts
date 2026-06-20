import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeFeatureCoverage, regeneratePrdSummary, runCoverageEngine } from './service'

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-state-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const SPEC = `
  import { test, expect } from '@playwright/test'
  test('create makes a new todo item', async () => { expect(1).toBe(1) })
`

function writeFeature(name: string, doc = '# Create todo\na user can create a new todo item'): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), SPEC)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), doc)
  return dir
}

const cov = (feature: string) => computeFeatureCoverage({ featuresDir, logsDir, feature })

describe('coverage state model (R3) — through the service', () => {
  it('absent summary → summary:absent, coverage:blocked', () => {
    writeFeature('checkout')
    const ledger = cov('checkout')
    expect(ledger.state?.summary).toBe('absent')
    expect(ledger.state?.coverage).toBe('blocked')
    expect(ledger.state?.headline).toBe('Setup needed')
  })

  it('fresh summary, no tags → coverage:absent (No coverage)', async () => {
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    const ledger = cov('checkout')
    expect(ledger.state?.summary).toBe('fresh')
    expect(ledger.state?.coverage).toBe('absent')
  })

  it('after the engine writes tags → coverage:fresh', async () => {
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    const ledger = cov('checkout')
    expect(ledger.state?.coverage).toBe('fresh')
  })

  it('editing a source doc → summary:stale + drift names the changed doc', async () => {
    const dir = writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\nedited body')
    const ledger = cov('checkout')
    expect(ledger.state?.summary).toBe('stale')
    expect(ledger.state?.drift.changedDocs).toEqual(['spec.md'])
    expect(ledger.state?.drift.affectedArtifacts).toEqual(['PRD summary', 'coverage ledger'])
    expect(ledger.docsDrift).toBe(true) // back-compat mirror
  })

  it('adding a requirement after the engine ran → coverage:stale', async () => {
    const dir = writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    // Add a second requirement section + regenerate → requirements set moved.
    fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\nbody\n# Delete todo\na user can delete a todo')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-02T00:00:00Z' })

    const ledger = cov('checkout')
    expect(ledger.state?.summary).toBe('fresh') // docs match the new summary
    expect(ledger.state?.coverage).toBe('stale') // engine ran against the old set
    expect(ledger.state?.drift.affectedArtifacts).toEqual(['coverage ledger'])
  })
})
