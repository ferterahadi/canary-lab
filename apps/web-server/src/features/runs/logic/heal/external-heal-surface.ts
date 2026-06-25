import fs from 'fs'
import path from 'path'
import type { RunDetail } from '../run-store'
import { buildHealPromptMap, type HealPromptMap } from '../runtime/auto-heal'
import { loadProjectConfig } from '../runtime/launcher/project-config'
import { buildRunPaths, runDirFor } from '../runtime/run-paths'
import { countConsecutiveSameFailures } from '../runtime/log-enrichment'
import { ESCALATION_THRESHOLD, buildHealEscalation, type HealEscalation } from '../runtime/heal-escalation'
import type { HealSignalKind } from '../../../../../../../shared/run-state'

export interface ExternalHealFailedTest {
  /** Stable per-failure id — equals the on-disk `failed/<failureId>/` dir name
   *  (and the failed entry `name`). Pass to `get_failure_detail` to pull just
   *  this failure's slice. */
  failureId: string
  name: string
  error?: unknown
  location?: string
  retry?: number
  logFiles?: string[]
  /** Repo-relative path to this failure's full `error.txt`, when written. */
  errorPath?: string
  /** Absolute path to `failed/<failureId>/trace-extract/`, when it exists. */
  traceDir?: string
  /** Absolute path to `failed/<failureId>/playwright-mcp/`, when non-empty. */
  playwrightMcpDir?: string
  artifacts: Array<{ name: string; kind: string; url: string }>
}

export interface CompactRunCounts {
  totalKnown: number
  passed: number
  failed: number
  skipped: number
  notRun: number
  statusLine: string
}

export interface NormalizedRunCounts {
  totalKnown: number
  passed: number
  failed: number
  skipped: number
  notRun: number
  passedNames: string[]
  passedIds: string[]
  failedNames: string[]
  failedIds: string[]
  skippedNames: string[]
  skippedIds: string[]
  notRunNames: string[]
  statusLine: string
}

export interface ExternalHealContext {
  runId: string
  feature: string
  env: string | null
  status: string
  healCycles: number
  repoBranches: RunDetail['manifest']['repoBranches']
  lifecycle: RunDetail['manifest']['lifecycle'] | null
  externalHealSession: RunDetail['manifest']['externalHealSession'] | null
  counts: CompactRunCounts
  failedTests: ExternalHealFailedTest[]
  // Slim packet: the markdown blobs are deferred to paths the agent `Read`s on
  // demand (they grow with #failures × #cycles). `get_run_snapshot` still inlines
  // them for verbose debugging.
  healIndex: { path: string } | null
  journal: { path: string } | null
  healPrompt?: HealPromptMap
  // The needs-heal procedure for external (often skill-less) clients. Carried on
  // the context so it loads on demand with the failure packet, instead of sitting
  // in the always-on MCP profile instructions where every connection pays for it.
  // Optional because repeat heal cycles (cycle >= 2) ship the slim variant —
  // see slimRepeatHealContext — which drops the procedure + map the agent
  // already received on cycle 1.
  nextSteps?: string[]
  // Present only on the slim repeat-cycle variant: a one-line breadcrumb that
  // recovers a forgetful/stateless client without re-sending the full procedure.
  guidance?: string
  // Present only when the SAME failing set has survived ESCALATION_THRESHOLD
  // heal cycles — the agent is stuck and should change tactic. The external
  // analog of the local PTY escalation block; supersedes the slim breadcrumb.
  escalation?: HealEscalation
}

export interface ExternalRunSnapshot {
  runId: string
  feature: string
  env: string | null
  status: string
  healCycles: number
  repoBranches: RunDetail['manifest']['repoBranches']
  lifecycle: RunDetail['manifest']['lifecycle'] | null
  externalHealSession: RunDetail['manifest']['externalHealSession'] | null
  summary: RunDetail['summary'] | null
  counts: NormalizedRunCounts
  failedTests: ExternalHealFailedTest[]
  healIndexMarkdown: string | null
  journalMarkdown: string | null
  artifactsBase: string
  healPrompt?: HealPromptMap
}

export interface ExternalFailureDetail extends ExternalHealFailedTest {
  runId: string
  /** Curated `trace-extract/failure-summary.md` content, inlined in full. */
  traceSummaryMarkdown?: string | null
  /** Set instead of `traceSummaryMarkdown` only when the summary exceeded the
   *  inline budget — `Read` this path (in chunks) for the full content. */
  traceSummaryPath?: string
  /** Full `error.txt` content, inlined in full. */
  errorText?: string | null
  /** Set instead of `errorText` only when `error.txt` exceeded the inline
   *  budget — `Read` this path (in chunks) for the full content. */
  errorTextPath?: string
}

export interface BuildExternalHealContextInput {
  detail: RunDetail
  logsDir: string
  projectRoot?: string
}

export interface BuildExternalFailureDetailInput {
  detail: RunDetail
  logsDir: string
  failureId: string
}

// get_failure_detail never truncates. This is the inline BUDGET: content within
// it is inlined whole (~2K tokens — covers the typical error.txt / trace
// summary); past it we POINT to the on-disk file instead of inlining, because
// the agent's `Read` tool pages a large file in digestible chunks (offset/limit)
// whereas inlining 10s–100s of KB would eat a big slice of context in one tool
// result. Text is never cut either way — over-budget just defers to Read.
const FAILURE_DETAIL_INLINE_MAX_BYTES = 8 * 1024

// The needs-heal procedure, surfaced on the context (wait_for_heal_task →
// needs_heal and get_heal_context) so skill-less clients read it exactly when a
// heal is needed — keeping it OUT of the always-on MCP profile instructions.
// Must stay in sync with the run-loop steps in the shipped SKILL.md files.
const EXTERNAL_HEAL_NEXT_STEPS: readonly string[] = [
  'Read context.healPrompt.startHere first. The packet is slim: context.healIndex / context.journal are PATHS (Read them when needed), and each context.failedTests[] entry carries a failureId plus pointer dirs (errorPath, traceDir, playwrightMcpDir).',
  'When SEVERAL tests fail, fan out: spawn one read-only sub-agent per failure, hand it the failureId, and have it call get_failure_detail(runId, failureId) to investigate just that slice in parallel and report back a hypothesis + proposed fix. The sub-agents must NOT edit code or call signal_run.',
  'Apply all the fixes YOURSELF, then signal_run ONCE per cycle: kind:"rerun" for test-only/app-code fixes, "restart" when services or env must restart, with hypothesis + fixDescription. One accountable signal per cycle.',
  'Then call wait_for_heal_task again on the same runId + session_id (loop on still_waiting). Repeat until passed or terminal failure.',
  'To re-execute, reuse the run rather than tearing it down: signal_run re-runs the failed tests in place for an active healing run; for a failed/aborted run pass its run_ref to start_run (reruns failed → skipped → pending/not-run only). Do not abort_run then start a fresh run — a fresh start re-runs the whole suite and is only worth it when prior passes are invalidated.',
]

// The breadcrumb shipped on repeat heal cycles in place of the full nextSteps +
// healPrompt map. The procedure and resource map are STATIC across cycles, so
// they go out once on cycle 1 (and on any explicit get_heal_context re-fetch);
// later cycles only carry the changing failure packet plus this pointer.
const REPEAT_HEAL_GUIDANCE =
  'Repeat heal cycle — the heal procedure and resource map were sent on cycle 1. Investigate the failures below, apply the fixes yourself, then signal_run ONCE (rerun for test/app-code fixes, restart when services must restart) with hypothesis + fixDescription, and wait_for_heal_task again. Call get_heal_context if you need the full healPrompt resource map back.'

// Strip the static guidance (nextSteps + healPrompt map) from a context for a
// repeat heal cycle, leaving the per-cycle failure packet plus a one-line
// breadcrumb. get_heal_context still returns the full context on demand. When the
// run is stuck, the escalation block (already on the context) is the louder, more
// specific steer — it supersedes the generic breadcrumb.
export function slimRepeatHealContext(context: ExternalHealContext): ExternalHealContext {
  const { healPrompt: _healPrompt, nextSteps: _nextSteps, ...rest } = context
  if (rest.escalation) return rest
  return { ...rest, guidance: REPEAT_HEAL_GUIDANCE }
}

export function buildExternalHealContext(input: BuildExternalHealContextInput): ExternalHealContext {
  const snapshot = buildExternalRunSnapshot(input)
  const runDir = runDirFor(input.logsDir, snapshot.runId)
  const paths = buildRunPaths(runDir)

  const failingSlugs = snapshot.counts.failedNames
  const consecutiveSameFailures = countConsecutiveSameFailures(paths.diagnosisJournalPath, failingSlugs)
  const escalation = consecutiveSameFailures >= ESCALATION_THRESHOLD && failingSlugs.length > 0
    ? buildHealEscalation({
      consecutiveSameFailures,
      slugs: failingSlugs,
      journalPath: paths.diagnosisJournalPath,
      failedDir: paths.failedDir,
    })
    : undefined

  return {
    runId: snapshot.runId,
    feature: snapshot.feature,
    env: snapshot.env,
    status: snapshot.status,
    healCycles: snapshot.healCycles,
    repoBranches: snapshot.repoBranches,
    lifecycle: snapshot.lifecycle,
    externalHealSession: snapshot.externalHealSession,
    counts: compactCounts(snapshot.counts),
    failedTests: snapshot.failedTests,
    // Path only — the agent `Read`s the file when it needs the content. Presence
    // mirrors whether the markdown file exists on disk.
    healIndex: snapshot.healIndexMarkdown === null ? null : { path: paths.healIndexPath },
    journal: snapshot.journalMarkdown === null ? null : { path: paths.diagnosisJournalPath },
    ...(snapshot.healPrompt ? { healPrompt: snapshot.healPrompt } : {}),
    nextSteps: [...EXTERNAL_HEAL_NEXT_STEPS],
    ...(escalation ? { escalation } : {}),
  }
}

export interface ExternalRunSnapshotSlim
  extends Omit<ExternalRunSnapshot, 'healIndexMarkdown' | 'journalMarkdown'> {
  // Same verbose snapshot, but the heal-index/journal markdown is replaced by
  // on-disk PATHS (mirrors get_heal_context). Lets get_run_snapshot stay the
  // "verbose debug" surface without ever inlining unbounded markdown — the agent
  // `Read`s the path when it needs the full content. The REST /run-snapshot
  // fallback keeps the inline-markdown shape via buildExternalRunSnapshot.
  healIndex: { path: string } | null
  journal: { path: string } | null
}

export function buildExternalRunSnapshotSlim(
  input: BuildExternalHealContextInput,
): ExternalRunSnapshotSlim {
  const full = buildExternalRunSnapshot(input)
  const paths = buildRunPaths(runDirFor(input.logsDir, full.runId))
  const { healIndexMarkdown, journalMarkdown, ...rest } = full
  return {
    ...rest,
    healIndex: healIndexMarkdown === null ? null : { path: paths.healIndexPath },
    journal: journalMarkdown === null ? null : { path: paths.diagnosisJournalPath },
  }
}

export function buildExternalRunSnapshot(input: BuildExternalHealContextInput): ExternalRunSnapshot {
  const { detail, logsDir, projectRoot } = input
  const runId = detail.manifest.runId
  const runDir = runDirFor(logsDir, runId)
  const paths = buildRunPaths(runDir)
  const summary = detail.summary
  const context: ExternalRunSnapshot = {
    runId,
    feature: detail.manifest.feature,
    env: detail.manifest.env ?? null,
    status: detail.manifest.status,
    healCycles: detail.manifest.healCycles,
    repoBranches: detail.manifest.repoBranches ?? [],
    lifecycle: detail.manifest.lifecycle ?? null,
    externalHealSession: detail.manifest.externalHealSession ?? null,
    summary: summary ?? null,
    counts: normalizeRunCounts(summary ?? null),
    failedTests: buildFailedTests(detail, paths.failedDir),
    healIndexMarkdown: safeRead(paths.healIndexPath),
    journalMarkdown: safeRead(paths.diagnosisJournalPath),
    artifactsBase: `/api/runs/${encodeURIComponent(runId)}/artifacts/`,
  }
  if (projectRoot) {
    const projectConfig = loadProjectConfig(projectRoot)
    context.healPrompt = buildHealPromptMap({
      projectRoot,
      runDir,
      personalWikiPath: projectConfig.personalWikiPath,
    })
  }
  return context
}

function buildFailedTests(detail: RunDetail, failedDir: string): ExternalHealFailedTest[] {
  return (detail.summary?.failed ?? []).map((entry) =>
    buildFailedTestPointer(entry, failedDir, detail.playwrightArtifacts),
  )
}

function buildFailedTestPointer(
  entry: NonNullable<RunDetail['summary']>['failed'][number],
  failedDir: string,
  playwrightArtifacts: RunDetail['playwrightArtifacts'],
): ExternalHealFailedTest {
  // The failed entry `name` is already the on-disk `failed/<slug>/` dir name.
  const traceDir = existingDir(path.join(failedDir, entry.name, 'trace-extract'))
  const playwrightMcpDir = nonEmptyDir(path.join(failedDir, entry.name, 'playwright-mcp'))
  return {
    failureId: entry.name,
    name: entry.name,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.location ? { location: entry.location } : {}),
    ...(typeof entry.retry === 'number' ? { retry: entry.retry } : {}),
    ...(entry.logFiles?.length ? { logFiles: entry.logFiles } : {}),
    ...(entry.errorFile ? { errorPath: entry.errorFile } : {}),
    ...(traceDir ? { traceDir } : {}),
    ...(playwrightMcpDir ? { playwrightMcpDir } : {}),
    artifacts:
      playwrightArtifacts
        ?.find((group) => group.testName === entry.name)
        ?.artifacts.map((artifact) => ({
          name: artifact.name,
          kind: artifact.kind,
          url: artifact.url,
        })) ?? [],
  }
}

/**
 * One failure's bounded detail — lets a sub-agent pull just its slice instead of
 * the whole heal context. Returns null when `failureId` is not a current failure.
 * Inlines the two highest-signal per-failure files (curated trace summary + full
 * error), each capped, with the rest left as pointer dirs the agent can `Read`.
 */
export function buildExternalFailureDetail(
  input: BuildExternalFailureDetailInput,
): ExternalFailureDetail | null {
  const { detail, logsDir, failureId } = input
  const entry = (detail.summary?.failed ?? []).find((e) => e.name === failureId)
  if (!entry) return null
  const paths = buildRunPaths(runDirFor(logsDir, detail.manifest.runId))
  const pointer = buildFailedTestPointer(entry, paths.failedDir, detail.playwrightArtifacts)
  const traceSummary = pointer.traceDir
    ? inlineOrPointer(path.join(pointer.traceDir, 'failure-summary.md'))
    : null
  const error = inlineOrPointer(path.join(paths.failedDir, failureId, 'error.txt'))
  return {
    runId: detail.manifest.runId,
    ...pointer,
    ...(traceSummary && 'text' in traceSummary ? { traceSummaryMarkdown: traceSummary.text } : {}),
    ...(traceSummary && 'path' in traceSummary ? { traceSummaryPath: traceSummary.path } : {}),
    ...(error && 'text' in error ? { errorText: error.text } : {}),
    ...(error && 'path' in error ? { errorTextPath: error.path } : {}),
  }
}

function existingDir(dir: string): string | null {
  try {
    return fs.statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

function nonEmptyDir(dir: string): string | null {
  try {
    return fs.readdirSync(dir).length > 0 ? dir : null
  } catch {
    return null
  }
}

function compactCounts(counts: NormalizedRunCounts): CompactRunCounts {
  return {
    totalKnown: counts.totalKnown,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    notRun: counts.notRun,
    statusLine: counts.statusLine,
  }
}

export interface WriteHealSignalInput {
  logsDir: string
  runId: string
  kind: HealSignalKind
  body: Record<string, unknown>
}

export function writeHealSignal(input: WriteHealSignalInput): { kind: HealSignalKind; path: string } {
  const paths = buildRunPaths(runDirFor(input.logsDir, input.runId))
  const target = healSignalPath(paths, input.kind)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(input.body))
  return { kind: input.kind, path: target }
}

function healSignalPath(paths: ReturnType<typeof buildRunPaths>, kind: HealSignalKind): string {
  if (kind === 'restart') return paths.restartSignal
  if (kind === 'rerun') return paths.rerunSignal
  return paths.healSignal
}

export function normalizeRunCounts(summary: RunDetail['summary'] | null): NormalizedRunCounts {
  const summaryWithKnownTests = summary as (RunDetail['summary'] & { knownTests?: unknown }) | null
  const knownTests = Array.isArray(summaryWithKnownTests?.knownTests)
    ? summaryWithKnownTests.knownTests
    : []
  const knownEntries = knownTests.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as { id?: unknown; name?: unknown }
    const name = typeof value.name === 'string' ? value.name : ''
    if (!name) return []
    return [{
      id: typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined,
      name,
    }]
  })
  const passedNames = uniqueStrings(summary?.passedNames ?? [])
  const passedIds = uniqueStrings(((summary as { passedIds?: unknown[] } | null)?.passedIds) ?? [])
  const failedNames = uniqueStrings((summary?.failed ?? []).map((entry) => entry.name))
  const failedIds = uniqueStrings((summary?.failed ?? []).map((entry) => (entry as { id?: unknown }).id))
  const skippedNames = uniqueStrings(summary?.skippedNames ?? [])
  const skippedIds = uniqueStrings(((summary as { skippedIds?: unknown[] } | null)?.skippedIds) ?? [])
  const hasResultIds = passedIds.length > 0 || failedIds.length > 0 || skippedIds.length > 0
  const accountedIds = new Set([...passedIds, ...failedIds, ...skippedIds])
  const accountedNames = new Set([...passedNames, ...failedNames, ...skippedNames])
  const notRunNames = knownEntries
    .filter((entry) => {
      if (hasResultIds && entry.id) return !accountedIds.has(entry.id)
      return !accountedNames.has(entry.name)
    })
    .map((entry) => entry.name)
  const totalKnown = knownEntries.length > 0 ? knownEntries.length : numberOrZero(summary?.total)
  const passed = typeof summary?.passed === 'number' ? summary.passed : passedNames.length
  const failed = failedNames.length
  const skipped = typeof summary?.skipped === 'number' ? summary.skipped : skippedNames.length
  const notRun = knownEntries.length > 0
    ? notRunNames.length
    : Math.max(0, totalKnown - passed - failed - skipped)

  return {
    totalKnown,
    passed,
    failed,
    skipped,
    notRun,
    passedNames,
    passedIds,
    failedNames,
    failedIds,
    skippedNames,
    skippedIds,
    notRunNames,
    statusLine: statusLineForCounts({ totalKnown, passed, failed, skipped, notRun }),
  }
}

function statusLineForCounts(counts: Pick<NormalizedRunCounts, 'totalKnown' | 'passed' | 'failed' | 'skipped' | 'notRun'>): string {
  const parts = [`${counts.passed}/${counts.totalKnown} passed`, `${counts.failed} failed`]
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  parts.push(`${counts.notRun} not run`)
  return parts.join(', ')
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

// Inline the full file content when it fits the inline budget; otherwise return
// its path so the agent `Read`s the complete file in chunks (offset/limit).
// Never cuts the text mid-stream.
function inlineOrPointer(file: string): { text: string } | { path: string } | null {
  const content = safeRead(file)
  if (content === null) return null
  if (Buffer.byteLength(content, 'utf8') <= FAILURE_DETAIL_INLINE_MAX_BYTES) return { text: content }
  return { path: file }
}
