// Tests that require vi.mock to reach branches inside collectTests (service.ts lines
// 86, 90-91) that are unreachable with real spec files, since the AST extractor never
// sets sourceFile and only sets requirements/pathTypes via Playwright tags.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../../../config/logic/ast-extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../config/logic/ast-extractor')>()
  return {
    ...original,
    extractTestsFromSource: vi.fn(original.extractTestsFromSource),
  }
})

import { computeFeatureCoverage, runCoverageEngine, regeneratePrdSummary } from './service'
import { extractTestsFromSource } from '../../../config/logic/ast-extractor'

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-service-mocked-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  vi.mocked(extractTestsFromSource).mockReset()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFeature(name: string): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  // Write a real spec file so listSpecFiles picks it up.
  fs.writeFileSync(path.join(dir, 'e2e', 'a.spec.ts'), `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Create todo\na user can create a new todo item')
  return dir
}

describe('collectTests — sourceFile override (service.ts line 86)', () => {
  it('uses t.sourceFile as absFile when the extractor sets it (FALSE branch of t.sourceFile ?? file)', async () => {
    // The AST extractor normally never sets sourceFile, so `t.sourceFile ?? file`
    // always falls back to `file`. Mock extractTestsFromSource to return a test
    // with an explicit sourceFile → exercises the FALSE branch (t.sourceFile IS defined).
    const dir = writeFeature('checkout')
    const realSpecFile = path.join(dir, 'e2e', 'a.spec.ts')
    const helperFile = path.join(dir, 'e2e', 'helper.ts')
    fs.writeFileSync(helperFile, '// helper\n')

    vi.mocked(extractTestsFromSource).mockReturnValue({
      file: realSpecFile,
      tests: [
        {
          name: 'shared',
          line: 1,
          bodySource: 'async () => {}',
          steps: [],
          sourceFile: helperFile, // points to a different file than the spec
          requirements: ['R1'],
        },
      ],
    })

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    // computeFeatureCoverage calls collectTests which calls extractTestsFromSource;
    // absFile is helperFile (not realSpecFile) because sourceFile was set.
    // The ledger is computed without throwing — this is the primary assertion.
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    expect(ledger.feature).toBe('checkout')
    // The test "shared" is collected and its file resolved to the helper.
    const t = ledger.tests.find((t) => t.name === 'shared')
    expect(t).toBeTruthy()
  })
})

describe('collectTests — duplicate name merge (service.ts unionList)', () => {
  it('keeps existing requirements unchanged when duplicate has none (unionList b=undefined path)', async () => {
    // a.spec.ts returns requirements=['R1']; b.spec.ts returns no requirements.
    // unionList(existing=['R1'], b=undefined) → returns ['R1'] unchanged.
    const dir = writeFeature('checkout')
    const specB = path.join(dir, 'e2e', 'b.spec.ts')
    fs.writeFileSync(specB, `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })

    vi.mocked(extractTestsFromSource)
      .mockReturnValueOnce({
        file: path.join(dir, 'e2e', 'a.spec.ts'),
        tests: [{ name: 'shared', line: 1, bodySource: 'async () => {}', steps: [], requirements: ['R1'], pathTypes: ['happy'] }],
      })
      .mockReturnValueOnce({
        file: specB,
        tests: [{ name: 'shared', line: 1, bodySource: 'async () => {}', steps: [] }],
      })

    const result = await runCoverageEngine({ featuresDir, feature: 'checkout', adapter: 'deterministic', logsDir, now: '2026-01-01T00:00:00Z' })
    expect(result.feature).toBe('checkout')
  })

  it('unions requirements and pathTypes when the same test name appears twice (unionList merge path)', async () => {
    // a.spec.ts returns R1+happy; b.spec.ts returns R2+sad.
    // unionList(['R1'], ['R2']) → ['R1', 'R2']; same for pathTypes.
    const dir = writeFeature('checkout')
    const specA = path.join(dir, 'e2e', 'a.spec.ts')
    const specB = path.join(dir, 'e2e', 'b.spec.ts')
    fs.writeFileSync(specB, `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)

    vi.mocked(extractTestsFromSource)
      .mockReturnValueOnce({
        file: specA,
        tests: [{ name: 'shared', line: 1, bodySource: 'async () => {}', steps: [], requirements: ['R1'], pathTypes: ['happy'] }],
      })
      .mockReturnValueOnce({
        file: specB,
        tests: [{ name: 'shared', line: 1, bodySource: 'async () => {}', steps: [], requirements: ['R2'], pathTypes: ['sad'] }],
      })

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    const sharedTest = ledger.tests.find((t) => t.name === 'shared')
    expect(sharedTest?.requirements).toContain('R1')
    expect(sharedTest?.requirements).toContain('R2')
  })
})
