import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readCoverageRunState, writeCoverageRunState } from './run-state'
import { docsDirFor } from './docs-collection'

let tmpDir: string
let featureDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-runstate-')))
  featureDir = path.join(tmpDir, 'checkout')
  fs.mkdirSync(featureDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function stateFilePath(): string {
  return path.join(docsDirFor(featureDir), '_coverage-state.json')
}

describe('readCoverageRunState', () => {
  it('returns null when the state file does not exist', () => {
    expect(readCoverageRunState(featureDir)).toBeNull()
  })

  it('returns null when the state file has invalid requirementsHash field (not a string)', () => {
    const docsDir = docsDirFor(featureDir)
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(stateFilePath(), JSON.stringify({ requirementsHash: 123, ranAt: '2026-01-01T00:00:00Z' }))
    expect(readCoverageRunState(featureDir)).toBeNull()
  })

  it('returns null when the state file is not valid JSON', () => {
    const docsDir = docsDirFor(featureDir)
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(stateFilePath(), 'not { valid json')
    expect(readCoverageRunState(featureDir)).toBeNull()
  })

  it('returns null when requirementsHash is missing', () => {
    const docsDir = docsDirFor(featureDir)
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(stateFilePath(), JSON.stringify({ ranAt: '2026-01-01T00:00:00Z' }))
    expect(readCoverageRunState(featureDir)).toBeNull()
  })

  it('returns the parsed state when the file is valid', () => {
    const state = { requirementsHash: 'abc123', ranAt: '2026-01-01T00:00:00Z' }
    writeCoverageRunState(featureDir, state)
    expect(readCoverageRunState(featureDir)).toEqual(state)
  })
})

describe('writeCoverageRunState', () => {
  it('creates the docs dir and writes the state file', () => {
    const state = { requirementsHash: 'h1', ranAt: '2026-01-01T00:00:00Z' }
    writeCoverageRunState(featureDir, state)
    expect(fs.existsSync(stateFilePath())).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8'))
    expect(parsed).toEqual(state)
  })

  it('overwrites an existing state file with new values', () => {
    writeCoverageRunState(featureDir, { requirementsHash: 'old', ranAt: '2026-01-01T00:00:00Z' })
    writeCoverageRunState(featureDir, { requirementsHash: 'new', ranAt: '2026-01-02T00:00:00Z' })
    expect(readCoverageRunState(featureDir)?.requirementsHash).toBe('new')
  })

  it('includes requirementFingerprints when provided', () => {
    const state = {
      requirementsHash: 'h1',
      ranAt: '2026-01-01T00:00:00Z',
      requirementFingerprints: { R1: 'fp1', R2: 'fp2' },
    }
    writeCoverageRunState(featureDir, state)
    expect(readCoverageRunState(featureDir)).toEqual(state)
  })
})
