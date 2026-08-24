import fs from 'fs'
import path from 'path'
import { isActiveRunStatus, isQueuedRunStatus } from '../../../../../../shared/run-state'

/** One key per Getting Started card — the two starters plus the five "More
 *  workflows". Each demo claims under its own key so every card can show its
 *  own attempted/running/completed state. */
export type GettingStartedWorkflow =
  | 'run'
  | 'flight'
  | 'coverage'
  | 'author'
  | 'portify'
  | 'verify'
  | 'export'
export type GettingStartedOwner = 'internal' | 'external'
/** What a claim is linked to. `run`/`flight` predate the widening and stay
 *  featureless (persisted session.json records exist in that shape); the newer
 *  kinds carry `feature` because their open-target navigation is feature-first
 *  (the coverage ledger, the suite's flight page pinned to a stage). A `verify`
 *  demo's target is its verification run, so it reuses kind 'run'. */
export type GettingStartedTarget =
  | { kind: 'run'; id: string }
  | { kind: 'flight'; id: string }
  | { kind: 'draft'; id: string; feature: string }
  | { kind: 'coverage-job'; id: string; feature: string }
  | { kind: 'portify'; id: string; feature: string }
  | { kind: 'export'; id: string; feature: string }

export interface GettingStartedActiveSession {
  sessionId: string
  workflow: GettingStartedWorkflow
  owner: GettingStartedOwner
  target: GettingStartedTarget | null
  startedAt: string
  updatedAt: string
}

export interface GettingStartedCompletion {
  workflow: GettingStartedWorkflow
  owner: GettingStartedOwner
  target: GettingStartedTarget
  status: string
  startedAt: string
  endedAt: string
}

export interface GettingStartedSessionState {
  active: GettingStartedActiveSession | null
  completed: Partial<Record<GettingStartedWorkflow, GettingStartedCompletion>>
}

/** Resolves a claim's linked record to its live status. One method pair over
 *  the target union (rather than one pair per kind) so adding a target kind is
 *  a compile error here and one `case` in server.ts, not six new methods. */
export interface GettingStartedStatusResolver {
  status(target: GettingStartedTarget): string | null
  isActive(target: GettingStartedTarget, status: string): boolean
}

/** The run-side liveness predicate for the resolver. `isActiveRunStatus` alone
 *  (running || healing) is NOT enough here: the resource budget can queue a
 *  start the caller never asked to park, and a queued demo run is still the
 *  demo — settling it would record a nonsense "completed: queued" and drop the
 *  one-demo-at-a-time lock while the run is still on its way. */
export function isGettingStartedRunActive(status: string): boolean {
  return isActiveRunStatus(status) || isQueuedRunStatus(status)
}

export class GettingStartedBusyError extends Error {
  readonly type = 'getting_started_busy'

  constructor(public readonly active: GettingStartedActiveSession) {
    super(`Getting Started is already running ${active.workflow} from ${active.owner}.`)
  }
}

const EMPTY_STATE: GettingStartedSessionState = { active: null, completed: {} }
const FAILED_RUN_SETTLE_GRACE_MS = 500

function defaultSetTimer(fn: () => void, ms: number): void {
  setTimeout(fn, ms).unref()
}

function readState(file: string): GettingStartedSessionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as GettingStartedSessionState
    return {
      active: parsed.active ?? null,
      completed: parsed.completed ?? {},
    }
  } catch {
    return { ...EMPTY_STATE, completed: {} }
  }
}

function writeState(file: string, state: GettingStartedSessionState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Workspace-level guard for the Getting Started demos — one claim at a time
 * across all seven workflows. The claim is made before the demo's work record
 * (run, flight, draft, coverage job, portify workflow, export task) is created,
 * linked to that record immediately after, and settled only from the record's
 * real status.
 */
export class GettingStartedSessionStore {
  private readonly file: string
  private readonly pendingFailedRuns = new Set<string>()

  constructor(
    logsDir: string,
    private readonly resolver: GettingStartedStatusResolver,
    private readonly onChanged: () => void,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly setTimer: (fn: () => void, ms: number) => void = defaultSetTimer,
  ) {
    this.file = path.join(logsDir, 'getting-started', 'session.json')
  }

  read(): GettingStartedSessionState {
    this.reconcile()
    return readState(this.file)
  }

  /** A target-less claim only exists during one synchronous start request. If
   *  it survived process boot, that request died before creating any work. */
  reconcileInterrupted(): void {
    const state = readState(this.file)
    if (state.active && !state.active.target) {
      writeState(this.file, { ...state, active: null })
      this.changed()
      return
    }
    this.reconcile()
  }

  claim(workflow: GettingStartedWorkflow, owner: GettingStartedOwner): GettingStartedActiveSession {
    this.reconcile()
    const state = readState(this.file)
    if (state.active) throw new GettingStartedBusyError(state.active)
    const timestamp = this.now()
    const active: GettingStartedActiveSession = {
      sessionId: `gs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      workflow,
      owner,
      target: null,
      startedAt: timestamp,
      updatedAt: timestamp,
    }
    writeState(this.file, { ...state, active })
    this.changed()
    return active
  }

  attach(sessionId: string, target: GettingStartedTarget): void {
    const state = readState(this.file)
    if (state.active?.sessionId !== sessionId) return
    writeState(this.file, {
      ...state,
      active: { ...state.active, target, updatedAt: this.now() },
    })
    this.changed()
  }

  abandon(sessionId: string): void {
    const state = readState(this.file)
    if (state.active?.sessionId !== sessionId || state.active.target) return
    writeState(this.file, { ...state, active: null })
    this.changed()
  }

  reconcile(allowFailedSessionId?: string): void {
    const state = readState(this.file)
    const active = state.active
    if (!active?.target) return
    // A linked target that disappeared out-of-band (logs cleanup) cannot still
    // own an agent. Settle it as missing instead of leaving a permanent lock.
    const status = this.resolver.status(active.target) ?? 'missing'
    if (this.resolver.isActive(active.target, status)) return
    // A repair run writes `failed` for a few milliseconds before auto-heal
    // claims it and changes the same record to `healing`. Do not release the
    // demo owner in that gap. A genuinely terminal failure stays failed and is
    // settled by the delayed recheck.
    if (active.target.kind === 'run' && status === 'failed' && allowFailedSessionId !== active.sessionId) {
      this.scheduleFailedRunRecheck(active.sessionId)
      return
    }
    const endedAt = this.now()
    writeState(this.file, {
      active: null,
      completed: {
        ...state.completed,
        [active.workflow]: {
          workflow: active.workflow,
          owner: active.owner,
          target: active.target,
          status,
          startedAt: active.startedAt,
          endedAt,
        },
      },
    })
    this.changed()
  }

  private scheduleFailedRunRecheck(sessionId: string): void {
    if (this.pendingFailedRuns.has(sessionId)) return
    this.pendingFailedRuns.add(sessionId)
    this.setTimer(() => {
      this.pendingFailedRuns.delete(sessionId)
      this.reconcile(sessionId)
    }, FAILED_RUN_SETTLE_GRACE_MS)
  }

  private changed(): void {
    this.onChanged()
  }
}
