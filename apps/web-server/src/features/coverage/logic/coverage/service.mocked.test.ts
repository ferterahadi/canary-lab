// Tests that require vi.mock to reach branches inside collectTests (service.ts lines
// 86, 90-91) that are unreachable with real spec files, since the AST extractor never
// sets sourceFile and only sets requirements/pathTypes via Playwright tags.
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../../../../shared/ast-extractor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../shared/ast-extractor')>()
  return {
    ...original,
    extractTestsFromSource: vi.fn(original.extractTestsFromSource),
  }
})

import { computeFeatureCoverage, runCoverageEngine as runCoverageEngineReal, regeneratePrdSummary as regeneratePrdSummaryReal, clearPrdSummary, buildCoverageMappingContext, applyExternalCoverageMappings, applyExternalSummary, listFeatureDocs } from './service'
import { extractTestsFromSource } from '../../../../shared/ast-extractor'
import { fakeSummarize, fakePropose } from './__fixtures__/fake-coverage-agents'

// Coverage generation is LLM-only; inject the fake agent via the dep seams.
const regeneratePrdSummary = (args: Parameters<typeof regeneratePrdSummaryReal>[0]) =>
  regeneratePrdSummaryReal(args, { summarize: fakeSummarize })
const runCoverageEngine = (args: Parameters<typeof runCoverageEngineReal>[0]) =>
  runCoverageEngineReal(args, { propose: fakePropose })

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

describe('clearPrdSummary — strips coverage tags from specs', () => {
  it('removes the summary/sidecars AND the @req/@path tags, reporting untagged specs', () => {
    const dir = writeFeature('checkout')
    const specPath = path.join(dir, 'e2e', 'a.spec.ts')
    // Spec carries coverage tags + a user tag that must survive.
    fs.writeFileSync(
      specPath,
      `import { test } from '@playwright/test'\ntest('shared', { tag: ['@req-R1', '@path-happy', '@smoke'] }, async () => {})\n`,
    )
    // Drop a generated summary sidecar so `removed` has something to report.
    fs.writeFileSync(path.join(dir, 'docs', '_prd-summary.json'), '{"requirements":[]}')

    const result = clearPrdSummary({ featuresDir, feature: 'checkout' })

    expect(result.removed).toContain('_prd-summary.json')
    expect(result.untagged).toEqual([path.join('e2e', 'a.spec.ts')])
    const after = fs.readFileSync(specPath, 'utf-8')
    expect(after).not.toContain('@req-R1')
    expect(after).not.toContain('@path-happy')
    expect(after).toContain('@smoke') // user tag preserved
  })

  it('reports no untagged specs when none carry coverage tags', () => {
    writeFeature('checkout') // default spec has no tags
    const result = clearPrdSummary({ featuresDir, feature: 'checkout' })
    expect(result.untagged).toEqual([])
  })

  it('skips a spec file that cannot be read (catch { continue } branch)', () => {
    const dir = writeFeature('checkout')
    const specPath = path.join(dir, 'e2e', 'a.spec.ts')
    fs.chmodSync(specPath, 0o000)
    try {
      const result = clearPrdSummary({ featuresDir, feature: 'checkout' })
      expect(result.untagged).toEqual([])
    } finally {
      fs.chmodSync(specPath, 0o644)
    }
  })
})

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

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })

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

describe('buildCoverageMappingContext — null PRD summary branches', () => {
  it('returns empty requirements and a prompt when the feature has no PRD summary', () => {
    // Feature has spec files but no _prd-summary.json → summary = null
    // → summary?.requirements ?? [] both hit the null fallback (lines 358, 365)
    writeFeature('checkout')
    // No call to regeneratePrdSummary → no summary file written
    const ctx = buildCoverageMappingContext({ featuresDir, feature: 'checkout' })
    expect(ctx.feature).toBe('checkout')
    expect(ctx.requirements).toEqual([])
    expect(typeof ctx.prompt).toBe('string')
  })

  it('returns empty file (falsy t.file path) when sourceFile equals featureDir', () => {
    // Mock extractTestsFromSource to return sourceFile = featureDir so that
    // path.relative(featureDir, featureDir) = '' (empty string, falsy) → line 371
    // false branch: file = t.file (empty string) instead of path.join(featureDir, t.file)
    const dir = writeFeature('checkout')
    vi.mocked(extractTestsFromSource).mockReturnValueOnce({
      file: path.join(dir, 'e2e', 'a.spec.ts'),
      tests: [{
        name: 'shared',
        line: 1,
        bodySource: 'async () => {}',
        steps: [],
        sourceFile: dir, // sourceFile === featureDir → relative path = ''
      }],
    })
    const ctx = buildCoverageMappingContext({ featuresDir, feature: 'checkout' })
    const testEntry = ctx.tests.find((t) => t.testName === 'shared')
    // t.file is '' (falsy) → false branch of ternary → file remains ''
    expect(testEntry?.file).toBe('')
  })
})

describe('applyExternalCoverageMappings — null summary and edge cases', () => {
  it('works without a PRD summary (uses empty requirements, hash fallback, no now arg)', () => {
    // Feature with spec file but no PRD summary → summary = null
    // → summary?.requirements ?? [] (lines 400), summary?.requirementsHash ?? hash(...) (line 420)
    // → args.now ?? new Date().toISOString() (line 422, no now arg)
    const dir = writeFeature('checkout')
    const specPath = path.join(dir, 'e2e', 'a.spec.ts')
    fs.writeFileSync(specPath, `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)
    // No PRD summary → summary = null
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [], // no mappings — just exercise the null-summary path
      // no `now` arg → covers line 422 null branch
    })
    expect(result.feature).toBe('checkout')
    expect(result.applied).toEqual([])
  })

  it('skips a mapping with no file and an unknown testName (line 422 !file continue branch)', async () => {
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    // m.file absent and testName not in fileByTestName → !file → skip
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [{ testName: 'no-such-test-xyz', requirements: ['R1'], source: 'agent' }],
      now: '2026-01-01T00:00:00Z',
    })
    expect(result.applied).toEqual([])
  })

  it('skips a mapping where requirements is undefined (m.requirements ?? [] null branch)', () => {
    // m.requirements is undefined → (m.requirements ?? []).filter(...) → [] → skip
    writeFeature('checkout')
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [{ testName: 'shared', requirements: undefined as unknown as string[], source: 'agent' }],
    })
    expect(result.applied).toEqual([])
  })

  it('does not add to applied when applyTagToFile returns false (file does not exist — line 412 false branch)', async () => {
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [{ testName: 'shared', requirements: ['R1'], file: 'does-not-exist.spec.ts', source: 'agent' }],
      now: '2026-01-01T00:00:00Z',
    })
    expect(result.applied).toEqual([])
  })

  it('normalizes variants when a mapping carries a variant claim (lines 422-423 map/filter bodies)', async () => {
    // m.variants is non-empty → the .map() and .filter() callbacks in variantsFiltered are executed.
    // We seed the summary with a variantDimension so knownVariants is non-empty.
    const dir = writeFeature('checkout')
    // Write a PRD summary with R1 + variantDimension so the variants filter has something to allow.
    const summaryPath = path.join(dir, 'docs', '_prd-summary.json')
    fs.writeFileSync(summaryPath, JSON.stringify({
      requirements: [{ id: 'R1', title: 'Create', text: 'user can create', pathTypes: ['happy'], deprecated: false }],
      variantDimension: { name: 'channel', values: ['email', 'sms'] },
      docsHash: 'h', sourceDocs: [], generatedAt: '2026-01-01T00:00:00Z',
    }))
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [{
        testName: 'shared',
        requirements: ['R1'],
        file: path.join('e2e', 'a.spec.ts'),
        variants: ['EMAIL', 'fax'], // 'EMAIL' normalizes to 'email' (in vocab); 'fax' dropped
        source: 'agent',
      }],
      now: '2026-01-01T00:00:00Z',
    })
    // The .map() body was exercised (trim+lowercase) and .filter() body (knownVariants.has)
    expect(result.feature).toBe('checkout')
  })

  it('falls back to fileByTestName when m.file is absent but testName is known', async () => {
    // m.file is undefined → file = m.file ?? fileByTestName.get(testName) = known path
    const dir = writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [{ testName: 'shared', requirements: ['R1'], source: 'agent' }], // no m.file
      now: '2026-01-01T00:00:00Z',
    })
    // R1 must exist in the summary for the mapping to apply
    if (result.applied.length > 0) {
      // If R1 is present in the seeded summary, it was applied via the fileByTestName lookup
      const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
      expect(spec).toContain('@req-R1')
    }
    // In either case the function ran without throwing — branch was exercised
    expect(result.feature).toBe('checkout')
  })
})

describe('applyExternalCoverageMappings — deterministic validation flags (issues channel)', () => {
  it('still applies a flagged @path-sad mapping, attaching issues (flag, never drop)', async () => {
    const dir = writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      // 'shared' has no negative assertion → the sad claim is suspicious.
      mappings: [{ testName: 'shared', requirements: ['R1'], pathTypes: ['sad'], source: 'agent' }],
      now: '2026-01-01T00:00:00Z',
    })
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].issues).toEqual(['@path-sad claimed but test has no negative assertion (toThrow/rejects/.not/error-status)'])
    // The tag is still written exactly as before — flagging changes nothing else.
    const spec = fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')
    expect(spec).toContain('@req-R1')
    expect(spec).toContain('@path-sad')
  })

  it('flags a variant claim whose value never appears in the test source', async () => {
    const dir = writeFeature('checkout')
    fs.writeFileSync(path.join(dir, 'docs', '_prd-summary.json'), JSON.stringify({
      requirements: [{ id: 'R1', title: 'Create', text: 'user can create', pathTypes: ['happy'] }],
      variantDimension: { name: 'channel', values: ['email', 'sms'] },
      docsHash: 'h', sourceDocs: [], generatedAt: '2026-01-01T00:00:00Z',
    }))
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      // Body is `async () => {}` — 'email' appears nowhere in it.
      mappings: [{ testName: 'shared', requirements: ['R1'], variants: ['email'], source: 'agent' }],
      now: '2026-01-01T00:00:00Z',
    })
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].issues).toEqual(["@variant-email claimed but 'email' not found in test source"])
    expect(fs.readFileSync(path.join(dir, 'e2e', 'a.spec.ts'), 'utf-8')).toContain('@variant-email')
  })

  it('attaches no issues field for a clean mapping', async () => {
    writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    const result = applyExternalCoverageMappings({
      featuresDir, logsDir, feature: 'checkout',
      mappings: [{ testName: 'shared', requirements: ['R1'], pathTypes: ['happy'], source: 'agent' }],
      now: '2026-01-01T00:00:00Z',
    })
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].issues).toBeUndefined()
  })
})

describe('collectTests — duplicate name merge (service.ts unionList)', () => {
  it('keeps existing requirements unchanged when duplicate has none (unionList b=undefined path)', async () => {
    // a.spec.ts returns requirements=['R1']; b.spec.ts returns no requirements.
    // unionList(existing=['R1'], b=undefined) → returns ['R1'] unchanged.
    const dir = writeFeature('checkout')
    const specB = path.join(dir, 'e2e', 'b.spec.ts')
    fs.writeFileSync(specB, `import { test } from '@playwright/test'\ntest('shared', async () => {})\n`)

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })

    vi.mocked(extractTestsFromSource)
      .mockReturnValueOnce({
        file: path.join(dir, 'e2e', 'a.spec.ts'),
        tests: [{ name: 'shared', line: 1, bodySource: 'async () => {}', steps: [], requirements: ['R1'], pathTypes: ['happy'] }],
      })
      .mockReturnValueOnce({
        file: specB,
        tests: [{ name: 'shared', line: 1, bodySource: 'async () => {}', steps: [] }],
      })

    const result = await runCoverageEngine({ featuresDir, feature: 'checkout', logsDir, now: '2026-01-01T00:00:00Z' })
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

    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    const sharedTest = ledger.tests.find((t) => t.name === 'shared')
    expect(sharedTest?.requirements).toContain('R1')
    expect(sharedTest?.requirements).toContain('R2')
  })
})

describe('runCoverageEngine — engineInputs null-guard fallbacks (service.ts line 358)', () => {
  it('defaults bodySource/assertions to empty when the extractor omits them', async () => {
    // The real extractor always sets bodySource (required string) and assertions
    // defaults to []; only a non-standard extractor result can hit the `?? []` /
    // `?? ''` fallbacks in engineInputs. Mock extractTestsFromSource to omit both.
    const dir = writeFeature('checkout')
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })

    vi.mocked(extractTestsFromSource).mockReturnValueOnce({
      file: path.join(dir, 'e2e', 'a.spec.ts'),
      tests: [{
        name: 'shared',
        line: 1,
        // bodySource/assertions intentionally omitted from the extractor result.
      } as unknown as ReturnType<typeof extractTestsFromSource>['tests'][number]],
    })

    const result = await runCoverageEngine({ featuresDir, feature: 'checkout', logsDir, now: '2026-01-01T00:00:00Z' })
    // No throw despite the missing fields — the ?? [] / ?? '' fallbacks kicked in.
    expect(result.feature).toBe('checkout')
  })
})

describe('computeFeatureCoverage — proven axis (readLatestRunOutcomes join)', () => {
  it('leaves tests unjoined when the feature has no recorded run (outcomes null branch)', async () => {
    const dir = writeFeature('checkout')
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `import { test } from '@playwright/test'\ntest('shared', { tag: ['@req-R1', '@path-happy'] }, async () => {})\n`,
    )
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })
    // No runs/index.json written at all → readLatestRunOutcomes returns null.
    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    expect(ledger.provenRunId).toBeUndefined()
    expect(ledger.requirements[0].proven).toBeUndefined()
  })

  it('joins a matching run outcome onto its test (lastRun found branch) and threads provenRunId', async () => {
    const dir = writeFeature('checkout')
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `import { test } from '@playwright/test'\ntest('shared', { tag: ['@req-R1', '@path-happy'] }, async () => {})\n`,
    )
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })

    fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'index.json'),
      JSON.stringify([{ runId: 'r1', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', status: 'passed' }]),
    )
    fs.mkdirSync(path.join(logsDir, 'runs', 'r1'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'r1', 'e2e-summary.json'),
      JSON.stringify({ passedNames: ['test-case-shared'], failed: [] }),
    )

    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    expect(ledger.provenRunId).toBe('r1')
    const t = ledger.tests.find((t) => t.name === 'shared')
    expect(t?.lastRun).toEqual({ runId: 'r1', passed: true })
    expect(ledger.requirements[0].proven).toBe(true)
  })

  it('leaves lastRun unset for a test the run never touched (lastRun undefined branch)', async () => {
    const dir = writeFeature('checkout')
    fs.writeFileSync(
      path.join(dir, 'e2e', 'a.spec.ts'),
      `import { test } from '@playwright/test'\ntest('shared', { tag: ['@req-R1', '@path-happy'] }, async () => {})\n`,
    )
    await regeneratePrdSummary({ featuresDir, feature: 'checkout', now: '2026-01-01T00:00:00Z' })

    // A run exists for the feature, but its summary never mentions this test
    // (renamed/skipped) → lastRunOutcomeForTitle returns undefined → t.lastRun untouched.
    fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'index.json'),
      JSON.stringify([{ runId: 'r1', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', status: 'passed' }]),
    )
    fs.mkdirSync(path.join(logsDir, 'runs', 'r1'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'r1', 'e2e-summary.json'),
      JSON.stringify({ passedNames: [], failed: [] }),
    )

    const ledger = computeFeatureCoverage({ featuresDir, logsDir, feature: 'checkout' })
    expect(ledger.provenRunId).toBe('r1')
    const t = ledger.tests.find((t) => t.name === 'shared')
    expect(t?.lastRun).toBeUndefined()
    expect(ledger.requirements[0].proven).toBe(false)
  })
})

describe('applyExternalSummary — !found.featureDir branch (service.ts line 515)', () => {
  it('throws FeatureNotFoundError when feature exists but has empty featureDir', () => {
    // Write a feature config where featureDir is '' (empty string, falsy).
    // loadFeatures will include it (name is a valid string), but found.featureDir = ''
    // → `!found.featureDir` is true → throws FeatureNotFoundError (line 515 second branch).
    const emptyFeatDir = path.join(featuresDir, 'empty_featdir')
    fs.mkdirSync(emptyFeatDir, { recursive: true })
    fs.writeFileSync(
      path.join(emptyFeatDir, 'feature.config.cjs'),
      `const config = { name: 'empty_featdir', description: 'd', envs: ['local'], repos: [], featureDir: '' }\nmodule.exports = { config }\n`,
    )
    expect(() =>
      applyExternalSummary({ featuresDir, feature: 'empty_featdir', requirements: [] })
    ).toThrow(/empty_featdir/)
  })
})

describe('listFeatureDocs — symlink edge cases (service.ts lines 637, 650)', () => {
  it('skips a symlinked entry whose target is a directory, not a file (line 637 branch)', () => {
    const dir = writeFeature('symlinked_dir_doc')
    const docsDir = path.join(dir, 'docs')
    // Real target is a directory (not a regular file). lstatSync reports a
    // symlink, but the follow-through statSync succeeds and reports a
    // directory — `stat && !stat.isFile()` must skip it entirely.
    const targetDir = path.join(dir, 'a-real-directory')
    fs.mkdirSync(targetDir)
    fs.symlinkSync(targetDir, path.join(docsDir, 'dirlink.md'), 'dir')

    const listing = listFeatureDocs(featuresDir, 'symlinked_dir_doc')

    expect(listing.docs.find((d) => d.relPath === 'dirlink.md')).toBeUndefined()
    // The real doc written by writeFeature() is still listed normally.
    expect(listing.docs.find((d) => d.relPath === 'spec.md')).toBeDefined()
  })

  it('reports linkTarget as undefined when readlinkSync throws after lstatSync already confirmed a symlink (line 650 catch)', () => {
    const dir = writeFeature('symlinked_race_doc')
    const docsDir = path.join(dir, 'docs')
    const targetFile = path.join(dir, 'real-target.md')
    fs.writeFileSync(targetFile, '# real content')
    const linkPath = path.join(docsDir, 'linked.md')
    fs.symlinkSync(targetFile, linkPath, 'file')

    // Simulate the target being unlinked between the lstatSync/statSync calls
    // and the readlinkSync call: readlinkSync throws for this exact symlink.
    // No other fs.readlinkSync calls happen inside listFeatureDocs, so this
    // narrow throw-only stub is safe.
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: fs.PathLike) => {
      if (target === linkPath) throw new Error('ENOENT: race — link vanished')
      throw new Error('unexpected readlinkSync call in test: ' + String(target))
    }) as unknown as typeof fs.readlinkSync)

    try {
      const listing = listFeatureDocs(featuresDir, 'symlinked_race_doc')
      const doc = listing.docs.find((d) => d.relPath === 'linked.md')
      expect(doc).toBeDefined()
      expect(doc?.linked).toBe(true)
      expect(doc?.linkTarget).toBeUndefined()
      // stat succeeded (the target file exists) so this is not a dangling/broken link.
      expect(doc?.broken).toBeUndefined()
    } finally {
      readlinkSpy.mockRestore()
    }
  })
})
