import { useMemo } from 'react'
import { flowAttempts } from '@shared/test-view/flow-execution'
import type { PlaywrightPlaybackEvent } from '@shared/playback'
import type { RunManifest } from '@shared/run-manifest'
import type { RunStatus } from '@shared/run-state'
import type { RunSummary } from '@shared/run-detail'
import { summaryEntryName } from '@shared/test-names'
import { parseLocation } from '../test-numbering'
import { sourceFileInRun } from '@/features/runs/utils/run-source-file'
import { runningTestForTest, sameSourceFile, type TestStatusIdentity } from '@/features/runs/utils/test-step-status'

export type TestRunEvidence = {
  playbackEvents?: PlaywrightPlaybackEvent[]
  manifest?: Pick<RunManifest, 'featureDir' | 'suiteSnapshot' | 'specEdits' | 'runId' | 'playwrightExecutions'>
  summary?: RunSummary
  stale?: boolean
  status?: RunStatus
}

export function summaryIdentityForWorkspaceTest(
  name: string,
  line: number,
  file: string,
  summary: RunSummary | undefined,
  recorded = false,
): TestStatusIdentity {
  const matchesName = (known: NonNullable<RunSummary['knownTests']>[number]) => {
    return known.title === name || known.name === summaryEntryName(name)
  }
  // The recorded line is a hint, not an identity: a heal edit moves a test to
  // another line between cycles, and a targeted rerun only re-lists the tests it
  // re-runs — so a test that already passed can sit ten lines below where the
  // roster last saw it. The line decides only when one file declares the same
  // title more than once.
  const sameTest = (summary?.knownTests ?? []).filter((entry) => {
    const parsed = parseLocation(entry.location)
    return Boolean(parsed && sameSourceFile(parsed.file, file) && matchesName(entry))
  })
  const candidates = sameTest.length <= 1 ? sameTest : sameTest.filter(entry => parseLocation(entry.location)?.line === line)
  const known = candidates.length === 1 ? candidates[0] : undefined
  if (known?.id) return { name, id: known.id }
  const hasExplicitLegacyResult = summary?.passedNames !== undefined
    || summary?.skippedNames?.includes(summaryEntryName(name))
    || summary?.failed.some((entry) => entry.name === summaryEntryName(name))
  return summary?.knownTests?.length || (recorded && !hasExplicitLegacyResult)
    ? { name, allowNameFallback: false }
    : { name }
}

export function useRecordedTestFlow(evidence?: TestRunEvidence) {
  const runId = evidence?.manifest?.runId
  const events = evidence?.playbackEvents
  const byTest = useMemo(() => flowAttempts(runId ?? '', events ?? []), [runId, events])
  return (test: { name: string; line: number }, file: string) => {
    const identity = summaryIdentityForWorkspaceTest(test.name, test.line, sourceFileInRun(file, evidence?.manifest), evidence?.summary, Boolean(runId))
    const runningTest = evidence?.status === 'running' && !evidence.stale && evidence.summary
      ? runningTestForTest(evidence.summary, identity) : undefined
    const attempts = identity.id ? byTest.get(identity.id) : undefined
    const execution = evidence?.manifest?.playwrightExecutions
    return { identity, runningTest, attempts, liveAttempt: Boolean(runningTest && (!execution || attempts?.at(-1)?.execution === execution)) }
  }
}
