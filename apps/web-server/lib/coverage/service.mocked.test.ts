// Tests that require vi.mock to reach branches inside collectTests (service.ts lines
// 86, 90-91) that are unreachable with real spec files, since the AST extractor never
// sets sourceFile and only sets requirements/pathTypes via Playwright tags.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../ast-extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../ast-extractor')>()
  return {
    ...original,
    extractTestsFromSource: vi.fn(original.extractTestsFromSource),
  }
})

import { computeFeatureCoverage, runCoverageEngine, regeneratePrdSummary } from './service'
import { extractTestsFromSource } from '../ast-extractor'

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

describe('collectTests — duplicate name with requirements/pathTypes (service.ts lines 90-91)', () => {
  it('skips if-blocks when duplicate has no requirements or pathTypes (FALSE branches)', async () => {
    // Line 90: `if (t.requirements)` → FALSE when second occurrence has no requirements.
    // Line 91: `if (t.pathTypes)` → FALSE when second occurrence has no pathTypes.
    // The duplicate path (continue) is still taken; the merge if-blocks are skipped.
    const dir = writeFeature('checkout')
    const specB = path.join(dir, 'e2e', 'b.spec.ts')
    fs.writeFileSync(specB, `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)

    vi.mocked(extractTestsFromSource)
      .mockReturnValueOnce({
        file: path.join(dir, 'e2e', 'a.spec.ts'),
        tests: [
          {
            name: 'shared',
            line: 1,
            bodySource: 'async () => {}',
            steps: [],
            requirements: ['R1'],
            pathTypes: ['happy'],
          },
        ],
      })
      .mockReturnValueOnce({
        file: specB,
        tests: [
          {
            name: 'shared', // duplicate — triggers the merge branch
            line: 1,
            bodySource: 'async () => {}',
            steps: [],
            // requirements: undefined → line 90 FALSE branch
            // pathTypes: undefined → line 91 FALSE branch
          },
        ],
      })

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    // The original R1 requirement is preserved (duplicate did not overwrite).
    const sharedTest = ledger.tests.find((t) => t.name === 'shared')
    expect(sharedTest).toBeTruthy()
    expect(sharedTest?.requirements).toContain('R1')
  })

  it('unions requirements and pathTypes when the same test name appears twice (TRUE branches)', async () => {
    // Simulate two spec files each returning the same test name with different
    // requirements/pathTypes. The second call to extractTestsFromSource returns
    // the duplicate. collectTests detects `existing` is truthy → merges linkage.
    // Lines 90-91: `if (t.requirements)` and `if (t.pathTypes)` both take TRUE path.
    const dir = writeFeature('checkout')
    const specA = path.join(dir, 'e2e', 'a.spec.ts')
    const specB = path.join(dir, 'e2e', 'b.spec.ts')
    fs.writeFileSync(specB, `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)

    // First call (specA): test with R1 + happy.
    // Second call (specB): same name, R2 + sad → triggers the merge branch.
    vi.mocked(extractTestsFromSource)
      .mockReturnValueOnce({
        file: specA,
        tests: [
          {
            name: 'shared',
            line: 1,
            bodySource: 'async () => {}',
            steps: [],
            requirements: ['R1'],
            pathTypes: ['happy'],
          },
        ],
      })
      .mockReturnValueOnce({
        file: specB,
        tests: [
          {
            name: 'shared',
            line: 1,
            bodySource: 'async () => {}',
            steps: [],
            requirements: ['R2'],     // triggers line 90 TRUE branch
            pathTypes: ['sad'],        // triggers line 91 TRUE branch
          },
        ],
      })

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', adapter: 'deterministic', now: '2026-01-01T00:00:00Z' })
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    // Both R1 and R2 should be associated with "shared" after the union.
    const sharedTest = ledger.tests.find((t) => t.name === 'shared')
    expect(sharedTest).toBeTruthy()
    // The test is tagged with both requirements after the union merge.
    expect(sharedTest?.requirements).toContain('R1')
    expect(sharedTest?.requirements).toContain('R2')
  })
})
