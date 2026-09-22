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
    expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state: { ...input.ledger.state!, coverage: 'stale' } } }).reasons[0]).toBe('Requirements changed since coverage was mapped.')
    expect(deriveCoverageFreshness({ ...input, docsHash: 'source-docs-changed' }).reasons[0]).toBe('Requirements changed after this coverage was generated.')
    expect(deriveCoverageFreshness({ ...input, snapshot: { ...input.snapshot, requirements: { R1: 'changed' } } }).state).toBe('stale')
    expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state: undefined } }).state).toBe('current')
    for (const state of [{ ...input.ledger.state!, summary: 'generating' as const }, { ...input.ledger.state!, coverage: 'generating' as const }]) {
      expect(deriveCoverageFreshness({ ...input, ledger: { ...input.ledger, state } }).state).toBe('updating')
    }
    const snapshot = { ...input.snapshot, tests: { ...input.snapshot.tests, second: 'another' } }
    expect(deriveCoverageFreshness({ ...input, snapshot }).reasons[0]).toContain('1 test input changed')
  })

  it('migrates broad legacy fingerprints once without turning missing proof into stale mapping', () => {
    const legacy = { ...input.runState!, mappingInference: { version: 1, tests: input.runState!.mappingInference!.tests } }
    expect(deriveCoverageFreshness({ ...input, runState: legacy as never })).toMatchObject({
      state: 'stale', changedTests: [], reasons: ['Coverage mapping fingerprint format changed; update mappings once.'],
      nextAction: { stage: 'specs-coverage' },
    })
    const unproven = { ...input.ledger, requirements: input.ledger.requirements.map((row) => ({ ...row, enforcement: undefined })) }
    const current = deriveCoverageFreshness({ ...input, ledger: unproven })
    expect(current.state).toBe('current')
    expect(current.nextAction).toBeUndefined()
  })

  it('ignores generated documents and directories, but never hides unreadable source files', () => {
    expect(unreadableSourceDocs(path.join(fixture.root, 'missing'))).toEqual([])
    fs.mkdirSync(path.join(fixture.featureDir, 'docs', 'folder.md'))
    fs.writeFileSync(path.join(fixture.featureDir, 'docs', 'notes.json'), '{}')
    expect(unreadableSourceDocs(fixture.featureDir)).toEqual([])
  })
})
