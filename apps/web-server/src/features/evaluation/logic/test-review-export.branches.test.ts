import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ts from 'typescript'
import { __testReviewExportInternals, buildTestReviewPacket, createEvaluationHtml } from './test-review-export'
import type { RunDetail } from '../../runs/logic/run-store'
import type { CoverageLedger } from '../../../../../../shared/coverage/types'
import { detail, lineOf, testEndEvent } from './__fixtures__/test-review-fixtures'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('test review export — additional branch coverage', () => {
  it('grades an unrecognized matcher as unknown with the last-resort rationale', () => {
    const featureDir = path.join(tmpDir, 'unknown-matcher')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'unknown.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('unrecognized matcher', async ({ page }) => {
  await expect(page.locator('.thing')).toBeWibble()
})
`
    fs.writeFileSync(spec, specSource)
    const packet = buildTestReviewPacket(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('unrecognized")}`,
      title: 'unrecognized matcher',
    }))

    expect(packet.tests[0].assertions).toContainEqual(expect.objectContaining({
      kind: 'direct',
      label: 'toBeWibble',
      quality: 'unknown',
      rationale: 'Static analysis could not confidently classify this assertion.',
    }))
  })

  it('renders coverage strength with the shallow default and unmapped requirements', async () => {
    const featureDir = path.join(tmpDir, 'cov-defaults')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    const spec = path.join(featureDir, 'e2e', 'cov.spec.ts')
    const specSource = `import { test, expect } from '@playwright/test'

test('covered scenario', async ({ page }) => {
  await expect(page.getByText('Done')).toBeVisible()
})
`
    fs.writeFileSync(spec, specSource)
    // A test-coverage entry with no strength and no mapped requirements exercises
    // the `strength ?? 'shallow'` default and the empty-requirements branch.
    const ledger: CoverageLedger = {
      feature: 'checkout',
      requirements: [],
      tests: [{ name: 'covered scenario', requirements: [], pathTypes: [] }],
      totals: { total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0 },
      coveragePct: 0,
      mappedPct: 0,
      orphanRequirementIds: [],
      orphanTestNames: [],
    }
    const html = await createEvaluationHtml(detail({
      featureDir,
      eventLocation: `${spec}:${lineOf(specSource, "test('covered scenario'")}`,
      title: 'covered scenario',
    }), { coverage: ledger })

    expect(html).toContain('Coverage strength')
    expect(html).toContain('Shallow')
    expect(html).toContain('unmapped')
  })

  it('ignores non-test-end playback events when building the packet', async () => {
    const base = detail({ featureDir: tmpDir })
    const endEvent = testEndEvent(base)
    const withBegin: RunDetail = {
      ...base,
      playbackEvents: [
        { type: 'test-begin', time: '2026-01-01T00:00:00.000Z', test: { name: endEvent.test.name, title: endEvent.test.title, location: endEvent.test.location } },
        endEvent,
      ],
    }
    const html = await createEvaluationHtml(withBegin)

    expect(html).toContain('<span class="case-index">01</span>')
    // The test-begin event must not create a second test case.
    expect(html).not.toContain('<span class="case-index">02</span>')
  })

  it('covers remaining internal helper branches', () => {
    const packet = buildTestReviewPacket(detail({ featureDir: tmpDir }))
    const internals = __testReviewExportInternals

    // parseEvaluationTextSlotRewrite: braces present but invalid JSON → catch → undefined.
    expect(internals.parseEvaluationTextSlotRewrite('{ not valid json }')).toBeUndefined()

    // readableAction reaches the keyword fallbacks only when no call identifier
    // is present in the statement text.
    expect(internals.readableAction('please click the primary button', packet.tests[0])).toBe('Click the relevant control')
    expect(internals.readableAction('fill the email field', packet.tests[0])).toBe('Enter the required value')
    expect(internals.readableAction('waitForURL after submit', packet.tests[0])).toBe('Wait for the expected page')

    // readableActionName: empty identifier → generic step wording.
    expect(internals.readableActionName('', 'plain statement')).toBe('Run the next step')

    // displayWord singular/plural id normalization via a non-create verb.
    expect(internals.actionFromIdentifier('toggleIds')).toBe('toggle identifiers')
    expect(internals.actionFromIdentifier('toggleId')).toBe('toggle identifier')

    // renderAssertionHtml: helperSnippet present but helperName absent → empty code.
    expect(internals.renderAssertionHtml({
      kind: 'helper',
      label: 'anon',
      quality: 'strict',
      rationale: 'Uses toHaveText matcher.',
      snippet: 'anon(page)',
      helperSnippet: 'function anon() {}',
    })).toContain('helper: <code></code>')

    // functionLikeBody: VariableDeclaration (function + non-function) and a node
    // that is none of the handled kinds.
    const src = ts.createSourceFile('h.ts', 'const arrow = () => 1\nconst num = 5\nplainCall()', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const [arrowStmt, numStmt, exprStmt] = src.statements
    const arrowDecl = (arrowStmt as ts.VariableStatement).declarationList.declarations[0]
    const numDecl = (numStmt as ts.VariableStatement).declarationList.declarations[0]
    expect(internals.functionLikeBody(arrowDecl)).toBeDefined()
    expect(internals.functionLikeBody(numDecl)).toBeUndefined()
    expect(internals.functionLikeBody(exprStmt)).toBeUndefined()
  })

  it('grades a bare boolean toBe as moderate rather than strict', () => {
    // `tobe` sits in the exact-matcher table, but `toBe(true)` pins almost
    // nothing — so the demotion has to happen before that table is consulted.
    expect(__testReviewExportInternals.classifyAssertion('await expect(ok).toBe(true)', 'toBe')).toBe('moderate')
    expect(__testReviewExportInternals.classifyAssertion('await expect(v).toBe(null)', 'toBe')).toBe('moderate')
    // The complement: a concrete expected value keeps the strict grade.
    expect(__testReviewExportInternals.classifyAssertion('await expect(total).toBe(42)', 'toBe')).toBe('strict')
  })

  it('suffixes repeated section ids and falls back for a value that sanitises to nothing', () => {
    // Both arms belong to the helper's contract (anchor ids must be unique and
    // non-empty); the production caller index-prefixes every value, so neither
    // is reachable through it.
    expect(__testReviewExportInternals.uniqueSectionIds(['Checkout flow', 'Checkout flow', 'checkout   flow']))
      .toEqual(['checkout-flow', 'checkout-flow-2', 'checkout-flow-3'])
    expect(__testReviewExportInternals.safeFilename('!!!')).toBe('section')
    expect(__testReviewExportInternals.safeFilename('Checkout Flow')).toBe('checkout-flow')
  })

  it('reconstructs cases from the summary when a run detail has no playback events', () => {
    // `playbackEvents` is optional on RunDetail. Rather than reporting zero
    // tests, the packet falls back to summary.passedNames and says plainly that
    // no playback evidence was available — the count stays honest either way.
    const base = detail({ featureDir: tmpDir })
    const packet = buildTestReviewPacket({ ...base, playbackEvents: undefined })

    expect(packet.runId).toBe('run-1')
    expect(packet.tests).toHaveLength(1)
    expect(packet.tests[0].name).toBe('test-case-passes-checkout')
    expect(packet.tests[0].assertions).toEqual([expect.objectContaining({
      quality: 'unknown',
      rationale: 'No playback event or source match was available for this passed test.',
    })])
  })

  it('omits the Ended row when the run has no end timestamp', async () => {
    // A run still in flight has no manifest.endedAt, so the header drops the row
    // instead of rendering an empty definition.
    const base = detail({ featureDir: tmpDir })
    const running: RunDetail = { ...base, manifest: { ...base.manifest, endedAt: undefined } }
    const html = await createEvaluationHtml(running)

    expect(html).not.toContain('<dt>Ended</dt>')
    // The sibling rows that don't depend on endedAt are still there.
    expect(html).toContain('<dt>Started</dt>')
  })
})
