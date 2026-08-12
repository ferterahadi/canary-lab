// Everything one run knows about itself: what was fixed at construction, what
// was injected, and the state that changes as the run proceeds.
//
// This exists because `RunOrchestrator` could not be split without it. Measured
// against the class, only 13 of its 60 fields were used by a single concern —
// `status`, `stopped`, `paths`, `stateSink`, `healAgentPty` and their kind are
// each read or written by three to six of them. So the domain modules
// (service boot, the heal agent, the heal loop, Playwright, fix capture, the
// manifest) are not independent objects with private state; they are separate
// files operating on ONE run's state. Making that state an explicit object —
// rather than 60 private fields reachable only from inside the class — is what
// lets each concern live in its own file without widening the class's surface.
//
// Mutability is deliberate and mirrors the class it replaces: `readonly` marks
// what the constructor fixed, everything else is written as the run moves.
import path from 'path'
import { buildRunPaths, type RunPaths } from './run-paths'
import { overlayExists } from '../../../portify/logic/runtime/overlay'
import { HealSignalGate, type RunBootFailure } from '../../../../../../../shared/run-state'
import { AgentSessionRefStore } from './agent-session-refs'
import { FileRunStateSink, type RunStateSink } from './run-state-sink'
import { isHealthy } from '../../../../shared/launcher-startup'
import { defaultPlaywrightSpawner } from './run-spawn'
import { buildServiceSpecs, type ServiceSpec, type OrchestratorOptions, type OrchestratorEventMap, type AutoHealConfig, type DirtySpecHooks } from './orchestrator'
import type { PtyFactory, PtyHandle } from './pty-spawner'
import type { RunnerLog } from './runner-log'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import type { WorktreeHandle } from './repo-worktree'
import type {
  RunManifest,
  RunLifecyclePhase,
  RunLifecycleAbortReason,
  RepoBranchSnapshot,
  StoppedEarlyReason,
  ExternalHealSession,
} from './manifest'
import type { VerificationRunMetadata, ExecutionType as ExecutionType } from '../../../../../../../shared/verification'
import type { PlaywrightSpawner } from './run-spawn'

/** The orchestrator's own `emit`, handed to the modules so they can report
 *  progress without holding a reference back to the class. */
export type EmitRunEvent = <K extends keyof OrchestratorEventMap>(
  event: K,
  payload: OrchestratorEventMap[K],
) => boolean

export interface RunContext {
  // ── identity + layout, fixed at construction ──────────────────────────────
  readonly runId: string
  readonly runDir: string
  readonly feature: FeatureConfig
  readonly env?: string
  readonly paths: RunPaths
  readonly services: ServiceSpec[]
  readonly logsRoot: string
  /** The workspace root, when the caller knows it — the only way teardown can
   *  read `canary-lab.config.json` (the auto-PR setting lives there). Absent in
   *  unit tests and the CLI shim, which have no project config to consult. */
  readonly projectRoot?: string
  readonly portMap?: Map<string, number>
  readonly worktreeHandles: WorktreeHandle[]
  readonly repoPathOverrides: Record<string, string>
  /** Ephemeral port overlay: when the feature has a saved overlay, its captured
   *  patch is `git apply`-ed into each per-run worktree before boot and
   *  reverse-applied at teardown — the target repo is never permanently changed. */
  readonly portified: boolean

  // ── injected collaborators ────────────────────────────────────────────────
  readonly ptyFactory: PtyFactory
  readonly healthCheck: (url: string, timeoutMs?: number) => Promise<boolean>
  readonly delay: (ms: number) => Promise<void>
  readonly playwrightSpawner: PlaywrightSpawner
  readonly runnerLog?: RunnerLog
  readonly stateSink: RunStateSink
  readonly dirtySpecHooks?: DirtySpecHooks
  readonly signalGate: HealSignalGate
  readonly agentSessionRefs: AgentSessionRefStore
  readonly emit: EmitRunEvent

  // ── tuning ────────────────────────────────────────────────────────────────
  readonly healthPollIntervalMs: number
  readonly healthDeadlineMs: number
  readonly autoHeal?: AutoHealConfig
  readonly manualHeal: boolean
  readonly externalHeal: boolean
  readonly externalHealSession: ExternalHealSession | undefined
  readonly healSignalPollMs: number
  readonly healAgentTimeoutMs: number
  readonly healAgentIdleTimeoutMs: number
  readonly healAgentPromptNudgeMs: number
  readonly repoBranchSnapshots?: RepoBranchSnapshot[]
  readonly executionType: ExecutionType
  readonly verification?: VerificationRunMetadata
  readonly playwrightEnv: Record<string, string>

  // ── run state ─────────────────────────────────────────────────────────────
  status: RunManifest['status']
  healCycles: number
  startedAt: string
  stopped: boolean
  servicePtys: Map<string, PtyHandle>
  logFiles: Set<string>
  signalWatcher: NodeJS.Timeout | null
  heartbeatTimer: NodeJS.Timeout | null
  stoppedEarlyReason: StoppedEarlyReason | undefined
  pendingAbortReason: RunLifecycleAbortReason | undefined
  lastLifecycleEvent: { phase: RunLifecyclePhase; headline: string } | null
  healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }>
  /** Overlays applied this run, recorded so stop() can reverse exactly what it
   *  applied (and so a failed partial apply reverses only what landed). */
  appliedOverlays: { repoName: string; worktreeRoot: string; patchPath: string }[]
  /** Fix-capture baseline: a stash-create ref of each worktree taken AFTER
   *  overlay + envset + WIP hydration and BEFORE boot, so the diff at teardown
   *  is exactly the heal agent's edits. `untracked` is the set of non-ignored
   *  untracked files present AT baseline (hydrated WIP + generated docs) — the
   *  stash ref doesn't include them, so teardown must exclude them explicitly or
   *  they'd masquerade as agent-created files. Keyed by repo name. Empty for
   *  in-place runs (no worktree to capture from). */
  fixBaselines: Map<string, { ref: string; worktreeRoot: string; sourceRoot: string; baseSha: string; untracked: Set<string> }>
  /** Mid-Run Heal: tracked while a Playwright pty is in flight so
   *  pauseAndHeal() can SIGTERM it. Cleared on exit. */
  playwrightPty: PtyHandle | null
  playwrightExitWaiter: ((value: { exitCode: number; signal?: number }) => void) | null
  /** Set by waitForHealth (via pollUntilReady) when a service fails to come up on
   *  a normal run: the suite can't run, so runFullCycle / the heal loops treat
   *  the run as `failed` and route it into heal instead of aborting. Cleared at
   *  the top of every ensureServicesRunning so a stale failure from a prior
   *  cycle doesn't survive a successful reboot. */
  bootFailure: RunBootFailure | undefined

  // ── heal-agent state ──────────────────────────────────────────────────────
  /** Tracked while a heal-agent pty is in flight so cancelHeal() can SIGTERM it.
   *  The REPL is spawned ONCE per heal session and persists across cycles —
   *  the orchestrator drives cycle handoffs by writing to its stdin instead
   *  of respawning. Cleared on cleanup. */
  healAgentPty: PtyHandle | null
  /** MCP artifact dir for the live REPL. Pinned at spawn time from cycle-1's
   *  failed slugs and held until the heal loop exits, since claude's
   *  `--mcp-config` is set once at process boot. */
  healAgentMcpOutputDir: string | undefined
  /** Pinned at spawn time via `--session-id <uuid>` for claude (codex has no
   *  equivalent flag and leaves this null). */
  healAgentSessionId: string | null
  /** ISO timestamp captured at heal-agent spawn so the codex session-log
   *  locator can find this run's rollout JSONL. */
  healAgentStartedAt: string | null
  /** Last dimensions reported by the browser's agent pane. The pane can mount
   *  before auto-heal spawns the REPL, so keep the size and apply it at spawn. */
  healAgentTerminalSize: { cols: number; rows: number } | null
  /** Rolling tail of the heal agent's raw terminal output. When the loop gives
   *  up on a no-signal cycle this is the only evidence of WHY the agent went
   *  quiet, so it's written to `paths.healAgentTailPath`. */
  healAgentOutputTail: string
  /** Wall-clock of the most recent chunk emitted by the live heal-agent pty.
   *  Reset at the start of each `waitForHealSignal` call. Used to detect a
   *  wedged REPL while still allowing legitimate long-running cycles. */
  lastAgentDataAt: number
  /** Set by cancelHeal() so the heal loop in runFullCycle bails out instead of
   *  racing toward another Playwright rerun. */
  healCancelled: boolean
}

export function createRunContext(opts: OrchestratorOptions, emit: EmitRunEvent): RunContext {
  const paths = buildRunPaths(opts.runDir, opts.signalsDir ? { signalsDir: opts.signalsDir } : undefined)
  const worktreeHandles = opts.worktrees ?? []
  const repoPathOverrides: Record<string, string> = {}
  for (const handle of worktreeHandles) repoPathOverrides[handle.repoName] = handle.localPath
  const logsRoot = path.dirname(path.dirname(opts.runDir))
  const healthPollIntervalMs = opts.healthPollIntervalMs ?? 1000

  return {
    runId: opts.runId,
    runDir: opts.runDir,
    feature: opts.feature,
    env: opts.env,
    paths,
    logsRoot,
    ...(opts.projectRoot === undefined ? {} : { projectRoot: opts.projectRoot }),
    portMap: opts.portMap,
    worktreeHandles,
    repoPathOverrides,
    portified: overlayExists(opts.feature.featureDir),
    services: buildServiceSpecs(opts.feature, opts.runDir, opts.env, {
      portMap: opts.portMap,
      repoPathOverrides,
    }),

    ptyFactory: opts.ptyFactory,
    healthCheck: opts.healthCheck ?? isHealthy,
    delay: opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    playwrightSpawner: opts.playwrightSpawner ?? defaultPlaywrightSpawner,
    runnerLog: opts.runnerLog,
    // Default to a file-only sink so unit tests + the CLI shim don't have to
    // know about `RunStore`. Production wires RunStore in via opts.
    stateSink: opts.runStateSink ?? new FileRunStateSink(logsRoot),
    dirtySpecHooks: opts.dirtySpecHooks,
    signalGate: new HealSignalGate(),
    agentSessionRefs: new AgentSessionRefStore({
      runDir: opts.runDir,
      agentSessionRefPath: paths.agentSessionRefPath,
      agentSessionIdPath: paths.agentSessionIdPath,
    }),
    emit,

    healthPollIntervalMs,
    healthDeadlineMs: opts.healthDeadlineMs ?? 60_000,
    autoHeal: opts.autoHeal,
    manualHeal: opts.manualHeal ?? false,
    externalHeal: opts.externalHeal ?? false,
    externalHealSession: opts.externalHealSession,
    healSignalPollMs: opts.healSignalPollMs ?? healthPollIntervalMs,
    // Hard ceiling per cycle. Generous (2h) so a single heal cycle isn't cut
    // off mid-work for a hard, agent-blind reason — the idle timeout below
    // is the primary safety net.
    healAgentTimeoutMs: opts.healAgentTimeoutMs ?? 120 * 60 * 1000,
    healAgentIdleTimeoutMs: opts.healAgentIdleTimeoutMs ?? 5 * 60 * 1000,
    healAgentPromptNudgeMs: opts.healAgentPromptNudgeMs ?? 90 * 1000,
    repoBranchSnapshots: opts.repoBranchSnapshots,
    executionType: opts.executionType ?? 'run',
    verification: opts.verification,
    playwrightEnv: opts.playwrightEnv ?? {},

    status: 'running',
    healCycles: opts.initialHealCycles ?? 0,
    startedAt: '',
    stopped: false,
    servicePtys: new Map(),
    logFiles: new Set(),
    signalWatcher: null,
    heartbeatTimer: null,
    stoppedEarlyReason: undefined,
    pendingAbortReason: undefined,
    lastLifecycleEvent: null,
    healCycleHistory: [],
    appliedOverlays: [],
    fixBaselines: new Map(),
    playwrightPty: null,
    playwrightExitWaiter: null,
    bootFailure: undefined,

    healAgentPty: null,
    healAgentMcpOutputDir: undefined,
    healAgentSessionId: null,
    healAgentStartedAt: null,
    healAgentTerminalSize: null,
    healAgentOutputTail: '',
    lastAgentDataAt: 0,
    healCancelled: false,
  }
}
