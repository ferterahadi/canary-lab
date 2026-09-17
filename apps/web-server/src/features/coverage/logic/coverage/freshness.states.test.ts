import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshnessWorkspace } from './__fixtures__/freshness-workspace'
import { deriveCoverageFreshness, unreadableSourceDocs } from './freshness'
import { computeFeatureCoverage } from './service'
import { readPrdSummary } from './prd-summary'
import { readDocsCollection } from './docs-collection'
import { mappingInputs } from './coverage-engine'
import { mappingInferenceSnapshot } from './mapping-cache'
import { readCoverageRunState } from './run-state'

let fixture: Awaited<ReturnType<typeof freshnessWorkspace>>
let input: Parameters<typeof deriveCoverageFreshness>[0]
beforeEach(async () => {
  fixture = await freshnessWorkspace()
  const summary = readPrdSummary(fixture.featureDir)!
  input = { ledger: computeFeatureCoverage(fixture.args), summary, docsHash: readDocsCollection(fixture.featureDir).docsHash,
    snapshot: mappingInferenceSnapshot(fixture.featureDir, mappingInputs(fixture.featureDir), summary.requirements),
    runState: readCoverageRunState(fixture.featureDir), unreadable: [] }
})
afterEach(() => fixture.cleanup())

describe('freshness state boundaries', () => {
  it('routes absent requirements, absent mappings and legacy mappings to their earliest necessary stages', () => {
    expect(deriveCoverageFreshness({ ...input, summary: null, runState: null })).toMatchObject({ state: 'not-measured', nextAction: { stage: 'prd-summary' } })
    expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state: { ...input.ledger.state!, coverage: 'absent' } } })).toMatchObject({ state: 'not-measured', nextAction: { stage: 'specs-coverage' } })
    expect(deriveCoverageFreshness({ ...input, runState: null })).toMatchObject({ state: 'stale', reasons: [expect.stringContaining('not recorded')] })
    expect(deriveCoverageFreshness({ ...input, runState: { ...input.runState!, mappingInference: undefined } }).state).toBe('stale')
  })

  it('distinguishes changed requirement meanings, missing state, and active summary/mapping work', () => {
    expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state: { ...input.ledger.state!, coverage: 'stale' } } }).reasons[0]).toContain('Requirements changed')
    expect(deriveCoverageFreshness({ ...input, snapshot: { ...input.snapshot, requirements: { R1: 'changed' } } }).state).toBe('stale')
    expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state: undefined } }).state).toBe('current')
    for (const state of [{ ...input.ledger.state!, summary: 'generating' as const }, { ...input.ledger.state!, coverage: 'generating' as const }]) {
      expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state } }).state).toBe('updating')
    }
    const snapshot = { ...input.snapshot, tests: { ...input.snapshot.tests, second: 'another' } }
    expect(deriveCoverageFreshness({ ...input, snapshot }).reasons[0]).toContain('1 test input changed')
  })

  it('treats missing evidence and changed inputs independently of whether requirements are fully mapped', () => {
    const noBoundary = { ...input.runState!, verificationRequiredAfter: undefined }
    const uncovered = { ...input.ledger, requirements: input.ledger.requirements.map((row) => ({ ...row, gapType: 'untested' as const })) }
    expect(deriveCoverageFreshness({ ...input, ledger: uncovered, runState: noBoundary }).proofNeedsRun).toBe(false)
    const unproven = { ...input.ledger, requirements: input.ledger.requirements.map((row) => ({ ...row, enforcement: undefined })) }
    expect(deriveCoverageFreshness({ ...input, ledger: unproven, runState: noBoundary }).proofNeedsRun).toBe(true)
  })

  it('ignores generated documents and directories, but never hides unreadable source files', () => {
    expect(unreadableSourceDocs(path.join(fixture.root, 'missing'))).toEqual([])
    fs.mkdirSync(path.join(fixture.featureDir, 'docs', 'folder.md'))
    fs.writeFileSync(path.join(fixture.featureDir, 'docs', 'notes.json'), '{}')
    expect(unreadableSourceDocs(fixture.featureDir)).toEqual([])
  })
})
