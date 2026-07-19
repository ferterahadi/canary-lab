import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  deriveFeatureEvidence,
  hasAuthoredSpecs,
  hasCapturedEnvset,
  hasPrdSummary,
} from './stage-evidence'

let featureDir: string

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-evidence-'))
})

describe('hasCapturedEnvset', () => {
  it('is false with no envsets dir at all', () => {
    expect(hasCapturedEnvset(featureDir)).toBe(false)
    expect(hasCapturedEnvset(featureDir, 'local')).toBe(false)
  })

  it('is false when the envset dir exists but is empty', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    expect(hasCapturedEnvset(featureDir)).toBe(false)
    expect(hasCapturedEnvset(featureDir, 'local')).toBe(false)
  })

  it('any-env probe accepts any non-empty envset; specific-env probe stays strict', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'staging'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'staging', 'app.env'), 'A=1\n')
    expect(hasCapturedEnvset(featureDir)).toBe(true)
    expect(hasCapturedEnvset(featureDir, 'staging')).toBe(true)
    expect(hasCapturedEnvset(featureDir, 'local')).toBe(false)
  })

  it('ignores stray files at the envsets/ top level (envsets.config.json is not a capture)', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'envsets.config.json'), '{}')
    expect(hasCapturedEnvset(featureDir)).toBe(false)
  })
})

describe('hasPrdSummary', () => {
  it('flips on docs/_prd-summary.json', () => {
    expect(hasPrdSummary(featureDir)).toBe(false)
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
    expect(hasPrdSummary(featureDir)).toBe(true)
  })
})

describe('hasAuthoredSpecs', () => {
  it('is false with no e2e dir or with non-spec files only', () => {
    expect(hasAuthoredSpecs(featureDir)).toBe(false)
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'helpers.ts'), '')
    expect(hasAuthoredSpecs(featureDir)).toBe(false)
  })

  it('accepts the spec-file shapes the validator historically accepted', () => {
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'flow.spec.mts'), '')
    expect(hasAuthoredSpecs(featureDir)).toBe(true)
  })
})

describe('deriveFeatureEvidence', () => {
  it('aggregates the three probes', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'app.env'), 'A=1\n')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'a.spec.ts'), '')
    expect(deriveFeatureEvidence(featureDir)).toEqual({
      envCapture: true,
      prdSummary: false,
      specs: true,
    })
  })
})
