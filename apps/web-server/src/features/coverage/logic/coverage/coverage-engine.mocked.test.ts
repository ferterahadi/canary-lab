// Tests that require vi.mock to control proposeCoverageMappings output.
// Kept in a separate file because vi.mock is file-scoped and module-hoisted.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Mock the annotate-engine module so we can return proposals without `file`.
vi.mock('./annotate-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../coverage/logic/coverage/annotate-engine')>()
  return {
    ...original,
    proposeCoverageMappings: vi.fn(),
  }
})

import { runCoverageEngine, regeneratePrdSummary } from './service'
import { proposeCoverageMappings } from '../../../coverage/logic/coverage/annotate-engine'

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cov-mocked-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  vi.mocked(proposeCoverageMappings).mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

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

describe('runCoverageEngine — agent proposal without file (line 273)', () => {
  it('skips a proposal that has no file field (agent-sourced mapping)', async () => {
    // Agent proposals (parsed from JSON output) omit `file` because the agent
    // only knows the test name, not which spec file it came from. The engine
    // must skip those proposals via `if (!m.file) continue` (line 273).
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    // Return a proposal with no file (agent-sourced shape — file is undefined).
    vi.mocked(proposeCoverageMappings).mockResolvedValue([
      {
        testName: 'create makes a new todo item',
        // file intentionally omitted — exercises the !m.file branch
        requirements: ['R1'],
        pathTypes: ['happy'],
        source: 'agent',
      },
    ])

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic' })
    // The proposal was skipped (no file → cannot write tag) so applied is empty.
    expect(res.applied).toEqual([])
    // The test is still an orphan since no tag was written.
    expect(res.orphanTestsBefore).toContain('create makes a new todo item')
  })

  it('skips a proposal whose file does not exist on disk (applyTagToFile early-return)', async () => {
    // A proposal with a `file` that doesn't exist on disk → applyTagToFile returns
    // false on fs.existsSync → the proposal is NOT pushed to applied.
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    vi.mocked(proposeCoverageMappings).mockResolvedValue([
      {
        testName: 'create makes a new todo item',
        file: 'e2e/nonexistent.spec.ts',  // file doesn't exist on disk
        requirements: ['R1'],
        pathTypes: ['happy'],
        source: 'deterministic',
      },
    ])

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic' })
    // The file doesn't exist → applyTagToFile returns false → applied is empty.
    expect(res.applied).toEqual([])
  })

  it('skips a proposal where writeCoversTag returns unchanged source (already tagged)', async () => {
    // A proposal whose test already has the @req-R1 tag in the spec file →
    // writeCoversTag returns the same source → applyTagToFile returns false (line 227).
    const dir = writeFeature('checkout')
    // Pre-tag the spec using the tag-writer format { tag: ['@req-R1', '@path-happy'] }
    // so writeCoversTag sees all required tokens already present → returns unchanged source.
    const specPath = path.join(dir, 'e2e', 'a.spec.ts')
    fs.writeFileSync(specPath,
      `import { test, expect } from '@playwright/test'\n` +
      `test('create makes a new todo item', { tag: ['@req-R1', '@path-happy'] }, async () => {\n  expect(1).toBe(1)\n})\n`,
    )
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    vi.mocked(proposeCoverageMappings).mockResolvedValue([
      {
        testName: 'create makes a new todo item',
        file: 'e2e/a.spec.ts',
        requirements: ['R1'],
        pathTypes: ['happy'],
        source: 'deterministic',
      },
    ])

    const res = await runCoverageEngine({ featuresDir, logsDir, feature: 'checkout', adapter: 'deterministic' })
    // writeCoversTag returned unchanged source → applyTagToFile returns false → not in applied.
    expect(res.applied).toEqual([])
  })
})
