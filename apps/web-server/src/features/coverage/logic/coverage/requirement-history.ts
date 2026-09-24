import fs from 'fs'
import path from 'path'
import type { RequirementTestChange } from '../../../../../../../shared/coverage/types'
import type { StrengthVerdict } from '../../../../../../../shared/verification-strength/types'
import type { DirtySpec } from '../../../runs/logic/dirty-specs/detect'
import { DirtySpecStore } from '../../../runs/logic/dirty-specs/store'
import { readManifest, readRunsIndex } from '../../../runs/logic/runtime/manifest'
import { runDirFor } from '../../../runs/logic/runtime/run-paths'
import { slugify } from '../../../runs/logic/runtime/summary-reporter'
import type { RequirementHistory } from './enforcement'
import { isAuxiliaryExecution } from '../../../../../../../shared/verification'

// Run evidence for the ledger's time axis (D11), read — never stored. The
// stored ledger is a cache; the run records are the truth, so `provenAt` and
// `testsChangedAt` are derived at read time from what the run loop already
// writes: runs/index.json + each run's e2e-summary.json (which tests passed in
// which run), each run's manifest (spec edits the run saw, with the strength
// differential's verdict), and the feature's live dirty-specs record (an edit
// made between runs). No new sidecar, nothing an agent can assert.
//
// A test is joined by NAME, the same join the `proven` axis uses: the summary
// records `test-case-<slugified title>`. A file-level event (an adopted edit
// names files, not tests) resolves against the tests CURRENTLY in that file.
//
// Integrity hints (`manifest.integrity.hints`) are deliberately not read: they
// are derived from the same `specEdits.pending` this module reads, so reading
// both would count one edit twice.

interface RunPasses {
  runId: string
  /** `endedAt` when the run finished, else `startedAt`. */
  at: string
  passed: Set<string>
}

interface TestChangeEvent {
  at: string
  verdict: RequirementTestChange['verdict']
  runId?: string
  tests: string[]
  /** Spec paths (relative to the suite dir) the event names instead of tests. */
  files: string[]
}

export interface FeatureRunHistory {
  /** Newest first. */
  runs: RunPasses[]
  changes: TestChangeEvent[]
}

export interface ReadFeatureRunHistoryOptions {
  /** How many of the newest runs to read. Bounds the walk on a long-lived
   *  feature; a proof older than this reads as "never proven". */
  maxRuns?: number
}

const DEFAULT_MAX_RUNS = 200

function toVerdict(v: StrengthVerdict | undefined): RequirementTestChange['verdict'] {
  if (v === 'weaker') return 'weaker'
  if (v === 'unclassifiable') return 'cannot-classify'
  return 'changed'
}

// One dirty spec → one event per verdict, over the tests it affected. A test
// the differential lists gets its own verdict; the rest inherit the file's
// (`unclassifiable` when a side did not parse, `changed` for a hash-only edit).
function specEvents(spec: DirtySpec, at: string, runId?: string): TestChangeEvent[] {
  const byVerdict = new Map<RequirementTestChange['verdict'], string[]>()
  for (const test of spec.affectedTests) {
    const own = spec.strength?.tests.find((t) => t.name === test)
    const verdict = toVerdict(own ? own.verdict : spec.strength?.verdict)
    byVerdict.set(verdict, [...(byVerdict.get(verdict) ?? []), test])
  }
  return [...byVerdict].map(([verdict, tests]) => ({ at, verdict, tests, files: [], ...(runId ? { runId } : {}) }))
}

function readPasses(logsDir: string, runId: string): Set<string> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runDirFor(logsDir, runId), 'e2e-summary.json'), 'utf-8')) as { passedNames?: unknown }
    return new Set((Array.isArray(parsed.passedNames) ? parsed.passedNames : []).filter((n): n is string => typeof n === 'string'))
  } catch {
    return null
  }
}

export function readFeatureRunHistory(logsDir: string, feature: string, opts: ReadFeatureRunHistoryOptions = {}): FeatureRunHistory {
  const entries = readRunsIndex(logsDir)
    .filter((e) => e.feature === feature && !isAuxiliaryExecution(e.executionType))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, opts.maxRuns ?? DEFAULT_MAX_RUNS)

  const runs: RunPasses[] = []
  const changes: TestChangeEvent[] = []
  for (const entry of entries) {
    const passed = readPasses(logsDir, entry.runId)
    if (passed) runs.push({ runId: entry.runId, at: entry.endedAt ?? entry.startedAt, passed })
    const manifest = readManifest(path.join(runDirFor(logsDir, entry.runId), 'manifest.json'))
    const specEdits = manifest?.specEdits
    if (!specEdits) continue
    for (const pending of specEdits.pending) changes.push(...specEvents(pending, specEdits.checkedAt, entry.runId))
    for (const adopted of specEdits.adopted) {
      changes.push({ at: adopted.at, verdict: 'changed', runId: entry.runId, tests: [], files: adopted.files })
    }
  }

  const dirty = new DirtySpecStore(logsDir).get(feature)
  if (dirty?.status === 'dirty') {
    for (const spec of dirty.dirtySpecs) changes.push(...specEvents(spec, dirty.since))
  }
  return { runs, changes }
}

/** The history of one requirement: its mapped tests (`names`) against the run
 *  evidence, with `tests` supplying each test's file for file-level events. */
export function historyForTests(
  history: FeatureRunHistory,
  tests: Array<{ name: string; file?: string }>,
  names: string[],
): RequirementHistory {
  const wanted = new Set(names)
  const fileOf = new Map(tests.map((t) => [t.name, t.file]))

  let provenAt: RequirementHistory['provenAt']
  if (names.length > 0) {
    const slugs = names.map((n) => `test-case-${slugify(n)}`)
    const run = history.runs.find((r) => slugs.every((s) => r.passed.has(s)))
    if (run) provenAt = { runId: run.runId, at: run.at }
  }

  const testChanges: RequirementTestChange[] = []
  for (const event of history.changes) {
    const matched = event.files.length > 0
      ? names.filter((n) => event.files.includes(fileOf.get(n) ?? ''))
      : event.tests.filter((t) => wanted.has(t))
    if (matched.length === 0) continue
    testChanges.push({ at: event.at, tests: matched, verdict: event.verdict, ...(event.runId ? { runId: event.runId } : {}) })
  }
  return { ...(provenAt ? { provenAt } : {}), testChanges }
}
