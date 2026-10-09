// The read model behind a run's Results & Fixes view: which recorded attempt
// belongs to which test case, Playwright execution and repair cycle.
//
// A projection, never a store. Everything here is derived from the RunDetail
// the runs WebSocket already delivers (playback events, their identity and the
// lifecycle records), so every open view recomputes it from the same pushed
// data and there is nothing to keep in sync. Runner evidence owns verdicts: a
// cycle is verified only by an attempt the reporter observed after it.
import type { PlaywrightPlaybackEvent } from './playback'
import { buildPlaybackIdentity, latestPlaybackAttempt, reconcilePlaybackCases, playbackCaseKey, type PlaybackCaseEntry, type PlaybackIdentity } from './playback-identity'
import type { JournalSection, PlaywrightArtifact, PlaywrightArtifactGroup } from './run-detail'
import type { RunLifecycleEvent } from './run-state'

/** Recorded with an explicit stamp, or inferred for a run recorded before
 *  stamps existed. A reader must be able to tell which. */
export type EvidenceSource = 'stamped' | 'derived'

export interface PlaybackAttemptStep { title: string; category: string; ended: boolean }

/** One begin…end span of one case, exactly as the reporter recorded it. */
export interface PlaybackAttempt {
  attemptKey: string
  caseKey: string
  name: string
  title: string
  location?: string
  startedAt?: string
  endedAt?: string
  status?: string
  passed?: boolean
  durationMs?: number
  retry?: number
  error?: { message: string; snippet?: string }
  /** The reporter's execution stamp. Absent on unstamped (legacy) events. */
  execution?: number
  /** Raw recorded steps, uncompacted. */
  steps: PlaybackAttemptStep[]
}

/** Every attempt in stream order, with the ids and locations each case was
 *  recorded under. `identity` is reused when it aligns with `events`. */
export function playbackAttempts(
  events: readonly PlaywrightPlaybackEvent[], identity?: PlaybackIdentity, known: readonly PlaybackCaseEntry[] = [],
): { attempts: PlaybackAttempt[]; caseEvidence: Map<string, { ids: Set<string>; locations: Set<string> }> } {
  const projection = identity?.eventKeys.length === events.length ? identity : buildPlaybackIdentity(events, known)
  const attempts = new Map<string, PlaybackAttempt>()
  const caseEvidence = new Map<string, { ids: Set<string>; locations: Set<string> }>()
  for (const [index, event] of events.entries()) {
    const keys = projection.eventKeys[index]
    if (!keys) continue
    const evidence = caseEvidence.get(keys.caseKey) ?? { ids: new Set<string>(), locations: new Set<string>() }
    if (event.test.id) evidence.ids.add(event.test.id)
    if ('location' in event.test) evidence.locations.add(event.test.location)
    caseEvidence.set(keys.caseKey, evidence)
    const current = attempts.get(keys.attemptKey) ?? { attemptKey: keys.attemptKey, caseKey: keys.caseKey, name: event.test.name, title: event.test.title, steps: [] }
    current.title = event.test.title || current.title
    if ('location' in event.test) current.location = event.test.location
    if (event.type === 'test-begin') {
      current.startedAt = event.time
      if (event.execution !== undefined) current.execution = event.execution
    }
    if (event.type === 'step-begin') current.steps.push({ title: event.step.title, category: event.step.category, ended: false })
    if (event.type === 'step-end') {
      const open = [...current.steps].reverse().find((step) => step.title === event.step.title && !step.ended)
      if (open) open.ended = true
      else current.steps.push({ title: event.step.title, category: event.step.category, ended: true })
    }
    if (event.type === 'test-end') {
      current.status = event.status
      current.passed = event.passed
      current.durationMs = event.durationMs
      current.retry = event.retry
      current.error = event.error
      current.endedAt = event.time
      if (event.execution !== undefined) current.execution = event.execution
    }
    attempts.set(keys.attemptKey, current)
  }
  for (const entry of known) {
    const evidence = caseEvidence.get(playbackCaseKey(entry))
    if (entry.id) evidence?.ids.add(entry.id)
    if (entry.location) evidence?.locations.add(entry.location)
  }
  return { attempts: [...attempts.values()], caseEvidence }
}

/** One Playwright invocation. `endedAt` is absent while it runs. */
export interface EvidenceExecution {
  index: number
  afterCycle: number
  startedAt: string
  endedAt?: string
  targeted: boolean
  source: EvidenceSource
}

/** One repair cycle, numbered run-wide. */
export interface EvidenceCycle {
  cycle: number
  startedAt: string
  /** The execution whose failures the repair started from. */
  inputExecution?: number
  /** The first execution that ran after this repair. Absent = not verified yet. */
  verifyingExecution?: number
  source: EvidenceSource
}

export type EvidenceAttempt = PlaybackAttempt & {
  /** Resolved execution: the stamp, or a lifecycle bracket on legacy runs.
   *  Absent when the attempt falls outside every known execution. */
  executionIndex?: number
}

export type CycleVerification =
  /** The reporter observed this case in the verifying execution. */
  | { kind: 'observed'; attempt: EvidenceAttempt }
  /** The verifying execution finished without this case: its last result
   *  stands with its original execution identity, and nothing was re-observed. */
  | { kind: 'not-rerun'; execution: number }
  /** No execution has run since the repair, or the verifying one (`execution`)
   *  is still running and has not reached this case. */
  | { kind: 'pending'; execution?: number }

export interface CaseCycle {
  cycle: number
  /** The failed attempt this repair started from. */
  input: EvidenceAttempt
  verification: CycleVerification
}

export interface CaseEvidence {
  caseKey: string
  name: string
  title: string
  location?: string
  declared: boolean
  /** Chronological. */
  attempts: EvidenceAttempt[]
  /** The case's last attempt in the first execution it ran in. */
  initial?: EvidenceAttempt
  /** The runner's latest recorded result for this case. */
  latest?: EvidenceAttempt
  /** Only cycles whose input included a failure of this case, oldest first. */
  cycles: CaseCycle[]
}

export interface RunEvidence {
  executions: EvidenceExecution[]
  cycles: EvidenceCycle[]
  /** Roster order, then any recorded case the roster lacks. */
  cases: CaseEvidence[]
  /** Attempts no execution brackets — shown, never attached to a cycle. */
  unplacedAttempts: EvidenceAttempt[]
}

export interface RunEvidenceInput {
  events?: readonly PlaywrightPlaybackEvent[]
  identity?: PlaybackIdentity
  known?: readonly PlaybackCaseEntry[]
  lifecycle?: readonly RunLifecycleEvent[]
}

const isStart = (e: RunLifecycleEvent) => e.phase === 'running-tests' || e.phase === 'rerunning-tests'
const isExit = (e: RunLifecycleEvent) => e.phase === 'completed' || e.phase === 'failed'
const isCycleStart = (e: RunLifecycleEvent) => e.phase === 'agent-healing' && e.activeCycle !== undefined

/** Executions from stamped lifecycle records when any exist. A run recorded
 *  before stamps falls back to start/exit brackets: the first start record
 *  opens one (the targeted-rerun plan record and the spawn record both say
 *  `rerunning-tests`), the next exit record closes it. */
function executionsFrom(lifecycle: readonly RunLifecycleEvent[], cycles: readonly EvidenceCycle[]): EvidenceExecution[] {
  if (lifecycle.some((e) => e.execution)) {
    const byIndex = new Map<number, EvidenceExecution>()
    for (const e of lifecycle) {
      if (!e.execution) continue
      const existing = byIndex.get(e.execution.index)
      if (!existing && isStart(e)) {
        byIndex.set(e.execution.index, {
          index: e.execution.index, afterCycle: e.execution.afterCycle, startedAt: e.updatedAt,
          targeted: e.phase === 'rerunning-tests', source: 'stamped',
        })
      } else if (existing && isExit(e)) existing.endedAt = e.updatedAt
    }
    return [...byIndex.values()].sort((a, b) => a.index - b.index)
  }
  const out: EvidenceExecution[] = []
  let open: EvidenceExecution | undefined
  for (const e of lifecycle) {
    if (!open && isStart(e)) {
      const afterCycle = cycles.filter((c) => c.startedAt <= e.updatedAt).reduce((max, c) => Math.max(max, c.cycle), 0)
      open = { index: out.length + 1, afterCycle, startedAt: e.updatedAt, targeted: e.phase === 'rerunning-tests', source: 'derived' }
      out.push(open)
    } else if (open && isExit(e)) {
      open.endedAt = e.updatedAt
      open = undefined
    }
  }
  return out
}

/** Cycles from the records that start one. `repairCycle` is the run-wide
 *  number; legacy records carry only the loop-local `activeCycle`, which
 *  restarts on a restart-heal, so they are numbered by order instead. */
function cyclesFrom(lifecycle: readonly RunLifecycleEvent[]): EvidenceCycle[] {
  return lifecycle.filter(isCycleStart).map((e, i) => ({
    cycle: e.repairCycle ?? i + 1,
    startedAt: e.updatedAt,
    source: e.repairCycle !== undefined ? 'stamped' : 'derived',
  }))
}

export function buildRunEvidence(input: RunEvidenceInput): RunEvidence {
  const events = input.events ?? []
  const known = input.known ?? []
  const lifecycle = input.lifecycle ?? []
  const cycles = cyclesFrom(lifecycle)
  const executions = executionsFrom(lifecycle, cycles)
  for (const cycle of cycles) {
    cycle.inputExecution = executions.filter((x) => x.startedAt <= cycle.startedAt).at(-1)?.index
    cycle.verifyingExecution = executions.find((x) => x.afterCycle === cycle.cycle)?.index
  }

  const bracket = (attempt: PlaybackAttempt): number | undefined => {
    if (attempt.execution !== undefined) return attempt.execution
    const time = attempt.startedAt ?? attempt.endedAt
    if (!time) return undefined
    return executions.find((x) => x.source === 'derived' && time >= x.startedAt && (x.endedAt === undefined || time <= x.endedAt))?.index
  }
  const { attempts } = playbackAttempts(events, input.identity, known)
  const resolved: EvidenceAttempt[] = attempts.map((attempt) => {
    const executionIndex = bracket(attempt)
    return executionIndex === undefined ? attempt : { ...attempt, executionIndex }
  })

  const byCase = new Map<string, EvidenceAttempt[]>()
  for (const attempt of resolved) byCase.set(attempt.caseKey, [...(byCase.get(attempt.caseKey) ?? []), attempt])
  const roster = reconcilePlaybackCases(known, resolved)

  const cases = roster.map(({ entry, declared }): CaseEvidence => {
    const caseKey = playbackCaseKey(entry)
    const own = byCase.get(caseKey) ?? []
    const placed = own.filter((a) => a.executionIndex !== undefined)
    const firstExecution = placed[0]?.executionIndex
    const lastIn = (execution: number) => latestPlaybackAttempt(placed.filter((a) => a.executionIndex === execution))
    const caseCycles: CaseCycle[] = []
    for (const cycle of cycles) {
      if (cycle.inputExecution === undefined) continue
      // The case's standing result when the repair began: its latest attempt
      // at or before the input execution. A failure carried forward from an
      // earlier execution still counts; a pass does not put it in this cycle.
      const input = latestPlaybackAttempt(placed.filter((a) => a.executionIndex! <= cycle.inputExecution!))
      if (!input || input.passed !== false) continue
      caseCycles.push({ cycle: cycle.cycle, input, verification: verificationOf(cycle, executions, lastIn) })
    }
    const latest = latestPlaybackAttempt(own)
    return {
      caseKey,
      name: entry.name,
      title: latest?.title ?? entry.title ?? entry.name,
      ...(entry.location ? { location: entry.location } : {}),
      declared,
      attempts: own,
      ...(firstExecution !== undefined ? { initial: lastIn(firstExecution) } : {}),
      ...(latest ? { latest } : {}),
      cycles: caseCycles,
    }
  })
  return { executions, cycles, cases, unplacedAttempts: resolved.filter((a) => a.executionIndex === undefined) }
}

function verificationOf(
  cycle: EvidenceCycle, executions: readonly EvidenceExecution[], lastIn: (execution: number) => EvidenceAttempt | undefined,
): CycleVerification {
  const verifying = executions.find((x) => x.index === cycle.verifyingExecution)
  if (!verifying) return { kind: 'pending' }
  const observed = lastIn(verifying.index)
  if (observed) return { kind: 'observed', attempt: observed }
  // Absence is only evidence once the execution is over: a running one may
  // not have reached this case yet.
  return verifying.endedAt === undefined ? { kind: 'pending', execution: verifying.index } : { kind: 'not-rerun', execution: verifying.index }
}

/** How a journal entry relates to one case's repair cycle. */
export type JournalAttribution =
  /** The entry names this case as the cycle's only failing input. */
  | { scope: 'case'; source: EvidenceSource; section: JournalSection }
  /** The entry is the cycle's, but the repair addressed several failures (or
   *  cannot name this case unambiguously): a shared, run-wide entry. */
  | { scope: 'run-wide'; source: EvidenceSource; section: JournalSection }

/** The journal entry written for `cycle`, by its `cycle` stamp. A journal
 *  with no stamps pairs entries with cycles by order only when the counts
 *  match one-for-one; anything else stays unattributed (the full run journal
 *  still shows it). */
export function journalForCycle(
  cycle: number, sections: readonly JournalSection[], evidence: RunEvidence, caseName?: string,
): JournalAttribution | undefined {
  const stamped = sections.some((s) => s.cycle !== undefined)
  let section: JournalSection | undefined
  if (stamped) section = sections.find((s) => s.cycle === cycle)
  else if (sections.length === evidence.cycles.length) {
    const position = evidence.cycles.findIndex((c) => c.cycle === cycle)
    const order = (s: JournalSection) => s.iteration ?? 0
    section = [...sections].sort((a, b) => order(a) - order(b))[position]
  }
  if (!section) return undefined
  const source: EvidenceSource = stamped ? 'stamped' : 'derived'
  // Names are title slugs: two cases that share one cannot be told apart here.
  const uniqueName = caseName !== undefined && evidence.cases.filter((c) => c.name === caseName).length === 1
  const own = uniqueName && section.failingTests?.length === 1 && section.failingTests[0] === caseName
  return { scope: own ? 'case' : 'run-wide', source, section }
}

/** Where an attempt's media came from, so the view can say so. */
export type AttemptMedia =
  /** The attempt's own retained copy. */
  | { kind: 'attempt'; artifacts: PlaywrightArtifact[] }
  /** A legacy run kept only the latest copy per test name; this attempt is the
   *  case's latest and the name is unique, so that copy is its own. */
  | { kind: 'latest-copy'; artifacts: PlaywrightArtifact[] }
  /** Nothing retained for it: the artifact policy kept none, or a legacy run
   *  overwrote it with a later attempt's copy, or a same-name case could own it.
   *  `pending`: media is preserved when its execution exits, which it has not. */
  | { kind: 'none'; reason: 'pending' | 'not-retained' | 'superseded' | 'ambiguous' }

export function mediaForAttempt(
  attempt: EvidenceAttempt,
  evidence: RunEvidence,
  detail: { attemptArtifacts?: Record<string, PlaywrightArtifact[]>; playwrightArtifacts?: PlaywrightArtifactGroup[] },
): AttemptMedia {
  const own = detail.attemptArtifacts?.[attempt.attemptKey]
  if (own?.length) return { kind: 'attempt', artifacts: own }
  if (attempt.execution !== undefined) {
    const running = evidence.executions.find((x) => x.index === attempt.execution)?.endedAt === undefined
    return { kind: 'none', reason: running ? 'pending' : 'not-retained' }
  }
  const owner = evidence.cases.find((c) => c.caseKey === attempt.caseKey)
  if (owner?.latest?.attemptKey !== attempt.attemptKey) return { kind: 'none', reason: 'superseded' }
  if (evidence.cases.filter((c) => c.name === attempt.name).length > 1) return { kind: 'none', reason: 'ambiguous' }
  const artifacts = detail.playwrightArtifacts?.find((g) => g.testName === attempt.name)?.artifacts ?? []
  return artifacts.length ? { kind: 'latest-copy', artifacts } : { kind: 'none', reason: 'not-retained' }
}

/** The `### Diff` block an entry carries inline, and whether the journal cut it
 *  to its size cap. The fallback when a cycle's patch file was never written. */
export function journalDiffBlock(body: string): { diff: string; truncated: boolean } | undefined {
  const match = /^### Diff\s*\n+```diff\n([\s\S]*?)\n```/m.exec(body)
  if (!match) return undefined
  return { diff: match[1], truncated: /\n\.\.\. \(truncated, \d+ more bytes\)$/.test(match[1]) }
}
