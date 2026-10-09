import fs from 'fs'
import path from 'path'
import { FLIGHT_STAGE_KEYS, type FlightManifest, type FlightStage, type FlightStageKey } from '../../../../../../../../shared/flights/types'
import type { StageContext } from '../../flight-stages'
import type { FlightStageDeps } from '../context'
import { fakeFlightInject } from './flight-inject'

// One StageContext test double for every stage suite.
//
// Seventeen stage tests each hand-rolled this object with the same six members.
// When `setAgentActivity` was added to `StageContext`, all seventeen went stale
// at once — and nothing failed, because CI typechecks only what is reachable
// from the CLI and that excludes test files. They were still *running* green:
// every stage under test that calls `ctx.setAgentActivity` was reaching a
// property that did not exist on the double.
//
// So the fix is not seventeen copies of one more no-op line. Everything inert
// lives here, and a suite supplies only the parts that carry its state. The next
// member added to `StageContext` is one edit, and a suite that needs to observe
// it overrides it.

export interface StageContextStubOptions {
  /** The manifest snapshot under test — usually a closure over mutable state. */
  manifest: () => FlightManifest
  flightDir: string
  patchFlight: StageContext['patchFlight']
  /** Override only to ASSERT on them. Default to no-ops, because a stage
   *  writing to its display log is not what most of these suites are testing. */
  appendLog?: StageContext['appendLog']
  setProgress?: StageContext['setProgress']
  setAgentActivity?: StageContext['setAgentActivity']
  addAgentSession?: StageContext['addAgentSession']
  /** Override to drive the pause/abort paths. */
  signal?: AbortSignal
}

export function stageContextStub(opts: StageContextStubOptions): StageContext {
  return {
    manifest: opts.manifest,
    flightDir: opts.flightDir,
    signal: opts.signal ?? new AbortController().signal,
    appendLog: opts.appendLog ?? ((): void => {}),
    setProgress: opts.setProgress ?? ((): void => {}),
    setAgentActivity: opts.setAgentActivity ?? ((): void => {}),
    addAgentSession: opts.addAgentSession ?? ((): void => {}),
    patchFlight: opts.patchFlight,
  }
}

export interface FlightStageCtxOptions {
  /** The flight directory defaults to `<logsDir>/flights/<flightId>`, where
   *  the conductor puts it. */
  logsDir: string
  flightDir?: string
  /** Append each `addAgentSession` to this stage's `agentSessions`, as the
   *  conductor does. Without it the call is a no-op, so a suite that does not
   *  name a stage sees the manifest unchanged by a spawned agent. */
  agentSessionStage?: FlightStageKey
}

/** A stage context over a mutable manifest: `patchFlight` and `setStage`
 *  rewrite it the way the store would (`links` merge, everything else
 *  replaces), and `current()` reads it back. `progressLog` and `logs` collect
 *  what the stage reported, for suites that assert on it. */
export function flightStageCtx(m: FlightManifest, opts: FlightStageCtxOptions): {
  ctx: StageContext
  current: () => FlightManifest
  setStage: (key: FlightStageKey, patch: Partial<FlightStage>) => void
  progressLog: unknown[]
  logs: string[]
} {
  const state = { m }
  const progressLog: unknown[] = []
  const logs: string[] = []
  const setStage = (key: FlightStageKey, patch: Partial<FlightStage>): void => {
    state.m = { ...state.m, stages: state.m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }
  }
  const sessionStage = opts.agentSessionStage
  return {
    progressLog,
    logs,
    ctx: stageContextStub({
      manifest: () => state.m,
      flightDir: opts.flightDir ?? path.join(opts.logsDir, 'flights', state.m.flightId),
      appendLog: (chunk) => { logs.push(chunk) },
      setProgress: (progress) => { progressLog.push(progress) },
      addAgentSession: sessionStage
        ? (session) => {
            const stage = state.m.stages.find((candidate) => candidate.key === sessionStage)
            setStage(sessionStage, { agentSessions: [...(stage?.agentSessions ?? []), session] })
          }
        : undefined,
      patchFlight: (patch) => {
        state.m = {
          ...state.m,
          ...patch,
          links: patch.links ? { ...state.m.links, ...patch.links } : state.m.links,
        }
      },
    }),
    current: () => state.m,
    setStage,
  }
}

export interface StageDirs {
  tmpDir: string
  featuresDir: string
  logsDir: string
  repoDir: string
}

/** The workspace a stage suite runs in, laid out under one temp root: the
 *  features and logs directories, and a product repo beside them. All three
 *  exist on return. */
export function stageDirs(tmpDir: string): StageDirs {
  const featuresDir = path.join(tmpDir, 'features')
  const logsDir = path.join(tmpDir, 'logs')
  const repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
  return { tmpDir, featuresDir, logsDir, repoDir }
}

/** Stage deps over that workspace. `inject` answers nothing, so a stage that
 *  calls an endpoint its suite did not stub gets a 500 naming it. */
export function stageDeps(
  base: Pick<FlightStageDeps, 'featuresDir' | 'logsDir' | 'projectRoot'>,
  over: Partial<FlightStageDeps> = {},
): FlightStageDeps {
  return {
    ...base,
    inject: fakeFlightInject(() => undefined),
    ...over,
  }
}

/** A running flight for the `checkout` feature over `repoDir`, every stage
 *  pending, at a fixed time. */
export function stageManifest(repoDir: string, over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl-test',
    feature: 'checkout',
    repoPaths: [repoDir],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'similarity',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}
