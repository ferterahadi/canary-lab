import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { CoverageFreshness, CoverageRecoveryAction } from '../../../../../../../shared/coverage/freshness'
import type { CoverageLedger, PrdSummary } from '../../../../../../../shared/coverage/types'
import { docsDirFor, isGeneratedDoc } from './docs-collection'
import type { MappingInferenceSnapshot } from './mapping-cache'
import type { CoverageRunState } from './run-state'

export function coverageRevision(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function unreadableSourceDocs(featureDir: string): string[] {
  const dir = docsDirFor(featureDir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => {
    if (!/\.(md|markdown|txt)$/i.test(name) || isGeneratedDoc(name)) return false
    try {
      const file = path.join(dir, name)
      if (fs.statSync(file).isFile()) fs.readFileSync(file)
      return false
    } catch { return true /* unreadable inputs cannot certify freshness */ }
  })
}

export function deriveCoverageFreshness(args: {
  ledger: CoverageLedger
  summary: PrdSummary | null
  docsHash: string
  snapshot: MappingInferenceSnapshot
  runState: CoverageRunState | null
  unreadable: string[]
  latestRun?: { runId: string; status: string; startedAt: string }
}): CoverageFreshness {
  const { ledger, summary, snapshot, runState } = args
  const reasons: string[] = []
  const changedTests = Object.entries(snapshot.tests).filter(([name, fingerprint]) => {
    const prior = runState?.mappingInference?.tests[name]
    return !prior || prior.fingerprint !== fingerprint || Object.entries(snapshot.requirements).some(([id, hash]) => prior.requirements[id] !== hash)
  }).map(([name]) => name)
  const removedTests = Object.keys(runState?.mappingInference?.tests ?? {}).filter((name) => !(name in snapshot.tests))
  changedTests.push(...removedTests)
  let state: CoverageFreshness['state'] = 'current'
  let nextAction: CoverageRecoveryAction | undefined
  const action = (stage: CoverageRecoveryAction['stage'], label: string, command: CoverageRecoveryAction['command']): CoverageRecoveryAction => ({ stage, label, command, arguments: { feature: ledger.feature } })
  if (args.unreadable.length) {
    state = 'unavailable'
    reasons.push(`Cannot read source inputs: ${args.unreadable.join(', ')}`)
  } else if (!summary) {
    state = 'not-measured'
    reasons.push('Requirements have not been generated.')
    nextAction = action('prd-summary', 'Generate requirements & coverage', 'start_external_summary')
  } else if (summary.docsHash !== args.docsHash) {
    state = 'stale'
    reasons.push('Requirements changed after this coverage was generated.')
    nextAction = action('prd-summary', 'Update requirements & coverage', 'start_external_summary')
  } else if (ledger.state?.coverage === 'absent') {
    state = 'not-measured'
    reasons.push('Coverage mapping has not run.')
    nextAction = action('specs-coverage', 'Map requirement coverage', 'start_external_coverage')
  } else if (!runState?.mappingInference || changedTests.length || ledger.state?.coverage === 'stale') {
    state = 'stale'
    reasons.push(!runState?.mappingInference ? 'Mapping input revisions were not recorded; recheck coverage before relying on it.'
      : ledger.state?.coverage === 'stale' ? 'Requirements changed since coverage was mapped.'
        : `${changedTests.length} test input${changedTests.length === 1 ? '' : 's'} changed since coverage was mapped.`)
    nextAction = action('specs-coverage', 'Update coverage mappings', 'start_external_coverage')
  }
  if (state !== 'unavailable' && (ledger.state?.summary === 'generating' || ledger.state?.coverage === 'generating')) {
    state = 'updating'
    reasons.push('Coverage work is in progress; previous measurements are historical.')
  }
  const latestRunFailed = args.latestRun?.status === 'failed' || ledger.tests.some((test) => test.lastRun?.passed === false)
  const inputsAheadOfRun = Boolean(runState?.verificationRequiredAfter && (!args.latestRun || args.latestRun.startedAt < runState.verificationRequiredAfter))
  const proofNeedsRun = Boolean(summary && (inputsAheadOfRun || ledger.requirements.some((req) => req.gapType === 'covered'
    && (req.enforcement?.state !== 'proven-unchanged' || ledger.tests.some((test) => test.requirements.includes(req.requirement.id) && test.lastRun?.passed !== true)))))
  if (inputsAheadOfRun) reasons.push('The latest run predates the current mapping inputs; its results are historical.')
  if (args.latestRun && !ledger.provenRunId) reasons.push(`Latest run ${args.latestRun.runId} is ${args.latestRun.status}; no readable test results for this attempt.`)
  if (state === 'current' && (proofNeedsRun || latestRunFailed)) nextAction = action('run', latestRunFailed ? 'Review failures & verify' : 'Verify current tests', 'start_run')
  return {
    revision: coverageRevision([args.docsHash, summary, snapshot, runState, ledger.state, ledger.tests.map((test) => [test.name, test.lastRun]), ledger.enforcement, args.unreadable, args.latestRun]),
    checkedAt: new Date().toISOString(), state, reasons, changedTests, latestRunFailed, proofNeedsRun,
    ...(nextAction ? { nextAction } : {}),
    ...(args.latestRun ? { latestRunId: args.latestRun.runId, latestRunStatus: args.latestRun.status } : {}),
    ...(ledger.provenRunId ? { evidenceRunId: ledger.provenRunId } : {}),
  }
}
