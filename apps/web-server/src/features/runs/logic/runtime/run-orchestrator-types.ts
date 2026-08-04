import path from 'path'
import type { FeatureConfig, HealthProbe } from '../../../../../../../shared/launcher/types'
import type { ExecutionType, VerificationRunMetadata } from '../../../../../../../shared/verification'
import { type ExternalHealSession, type RunLifecycleAbortReason, type RunLifecycleEvent, type RunLifecycleRestartPlan, type RunLifecycleSeverity, type RunLifecycleTargetedRerun, type RepoBranchSnapshot, type RunManifest } from './manifest'
import { type RunStateSink } from './run-state-sink'
import type { PtyFactory } from './pty-spawner'
import { AUTO_HEAL_MAX_CYCLES } from './heal-cycle'
import type { BuildHealCyclePrompt } from './auto-heal'
import type { RunnerLog } from './runner-log'
import { type WorktreeHandle } from './repo-worktree'
import type { PlaywrightSpawner } from './run-spawn'

export interface ServiceSpec {
  repoName: string
  name: string
  safeName: string
  command: string
  cwd: string
  /** Resolved per-env readiness probe (single transport). */
  healthProbe?: HealthProbe
  /** Extra env injected at spawn — e.g. the allocated `PORT` for each declared
   *  port slot whose `env` is set. */
  env?: Record<string, string>
  /** Per-run allocated ports keyed by declared slot name (for the manifest). */
  allocatedPorts?: Record<string, number>
}

// Test-file integrity side-channel. The orchestrator captures the pre-heal spec
// baseline at run start and asks for promotion when a run passes; the store does
// the hashing/diffing. Structural so `DirtySpecStore` satisfies it and tests can
// omit it. Absent in unit tests; wired to the singleton store in server.ts.
export interface DirtySpecHooks {
  captureRunStart(featureId: string, featureDir: string): Promise<unknown>
  finalizeRun(featureId: string, featureDir: string, passed: boolean): Promise<unknown>
}

export interface OrchestratorOptions {
  feature: FeatureConfig
  runId: string
  runDir: string
  // Repo root where the diagnosis journal lives (independent of the run dir).
  projectRoot?: string
  // Injected pty factory — production code passes the real one; tests pass a
  // fake. Required so unit tests can run without a TTY or node-pty native.
  ptyFactory: PtyFactory
  // Health-check function — defaulted to the real HTTP poller, but injectable
  // for tests.
  healthCheck?: (url: string, timeoutMs?: number) => Promise<boolean>
  // Default polling cadence; overridable for tests to keep them fast.
  healthPollIntervalMs?: number
  // Default deadline for an entire health-check phase (per service).
  healthDeadlineMs?: number
  // Override for `setTimeout`-based delays in tests.
  delay?: (ms: number) => Promise<void>
  // Builds the Playwright invocation. The orchestrator spawns it via
  // ptyFactory so tests can inject a fake. Defaults to the standard
  // `npx playwright test` command rooted at the feature dir.
  playwrightSpawner?: PlaywrightSpawner
  // Auto-heal configuration. Omit to disable the heal loop.
  autoHeal?: AutoHealConfig
  // Manual heal mode: when true and `autoHeal` is omitted, a failing run
  // transitions to 'healing' and waits for the user to write the signal
  // file by hand (no agent process spawned). When false (default), failing
  // tests with no autoHeal short-circuit to 'failed' immediately.
  manualHeal?: boolean
  // External heal mode: identical operational behavior to `manualHeal` (no
  // agent CLI is spawned, the orchestrator parks at waiting-for-signal until
  // a signal file appears in `<runDir>/signals/`). The only difference is
  // that the manifest's `healMode` is written as `'external'` so the UI can
  // render the dedicated `ExternalHealPanel` instead of the manual-heal
  // banner, and so external clients (Claude/Codex via MCP) can recognise
  // ownership. Mutually exclusive with `autoHeal`; takes precedence over
  // `manualHeal` for the manifest tag when both are true.
  externalHeal?: boolean
  /** When `externalHeal` is true, the route layer auto-claims the broker for
   *  the request's session. Passing the resulting `ExternalHealSession` here
   *  lets the orchestrator include it in the initial manifest write so the UI
   *  sees the "Healing via Claude Desktop" badge from the very first frame
   *  instead of after a follow-up patch round-trip. */
  externalHealSession?: ExternalHealSession
  // Polling interval for the heal-cycle signal-wait loop. Defaults to
  // healthPollIntervalMs.
  healSignalPollMs?: number
  // Hard ceiling on a single heal cycle (signal-wait). Defaults to 60 min.
  // When the agent is actively producing output, this is the absolute upper
  // bound on how long one cycle can run; quieter checks live in
  // `healAgentIdleTimeoutMs` below.
  healAgentTimeoutMs?: number
  // Idle window — max time the agent can go without emitting any output
  // before the cycle is given up on. Resets every time a chunk arrives on
  // the agent pty. Defaults to 3 min, which is generous for normal claude
  // pacing but catches a wedged REPL.
  healAgentIdleTimeoutMs?: number
  // Optional runner-log sink. When present, the orchestrator subscribes to its
  // own lifecycle events on construction and tees a human-readable line for
  // each into `runner.log`. Both CLI and web entrypoints provide one.
  runnerLog?: RunnerLog
  // Selected env (e.g. 'local', 'production'). Used to filter
  // repos/startCommands whose `envs` whitelist excludes it — letting a feature
  // skip booting local services when running tests against a remote URL.
  env?: string
  // Single mutator for manifest.json + runs-index.json. Defaults to a
  // file-only sink that writes the same files directly; production wires
  // the web-server's `RunStore` here so mutations also emit events that
  // drive the WS push channel.
  runStateSink?: RunStateSink
  repoBranchSnapshots?: RepoBranchSnapshot[]
  initialHealCycles?: number
  executionType?: ExecutionType
  verification?: VerificationRunMetadata
  playwrightEnv?: Record<string, string>
  /** Per-run allocated ports keyed by slot name (allocated by the start flow
   *  before construction). Resolves `${port.<slot>}` tokens and is injected as
   *  each service's declared `env`. Released on stop. */
  portMap?: Map<string, number>
  /** Per-run git worktrees created (opt-in) after a same-repo collision. The
   *  orchestrator redirects affected services' cwd into the worktree, records
   *  them in the manifest, and removes them on stop. */
  worktrees?: WorktreeHandle[]
  /** Relocate the heal-signal directory away from `<runDir>/signals`. The
   *  benchmark baseline arm points this at the agent's own worktree so the
   *  agent can signal completion without being handed a path into the run dir
   *  (where harness-only artifacts live). Omit for the default location. */
  signalsDir?: string
  /** Test-file integrity hooks (run-start capture + green promotion). Absent in
   *  tests; wired to the singleton DirtySpecStore in server.ts. */
  dirtySpecHooks?: DirtySpecHooks
}

export type PauseResult =
  | { ok: true; failureCount: number }
  | { ok: false; reason: 'already-healing' | 'no-playwright-running' | 'no-failures-yet' }

export type CancelHealResult =
  | { ok: true }
  | { ok: false; reason: 'not-healing' | 'no-agent-running' }

export type InterjectResult =
  | { ok: true }
  | { ok: false; reason: 'no-agent-running' }

export type OrchestratorEventMap = {
  'service-started': { service: ServiceSpec; pid: number }
  'service-output': { service: ServiceSpec; chunk: string }
  'service-exit': { service: ServiceSpec; exitCode: number; signal?: number }
  'service-restart-skipped': { service: ServiceSpec; reason: 'no-files-changed-here' }
  'restart-planned': { toRestart: string[]; toKeep: string[]; noMatch: boolean }
  'health-check': { service: ServiceSpec; healthy: boolean; transport?: 'http' | 'tcp' }
  'playwright-output': { chunk: string }
  'playwright-started': { command: string }
  'playwright-exit': { exitCode: number }
  'agent-started': { cycle: number; command: string; redirect?: boolean }
  'agent-output': { chunk: string }
  'agent-exit': { exitCode: number }
  'heal-cycle-started': { cycle: number; failureSignature: string }
  'signal-detected': {
    kind: 'restart' | 'rerun' | 'heal'
    body: Record<string, unknown>
  }
  'signal-accepted': {
    kind: 'restart' | 'rerun' | 'heal'
    body: Record<string, unknown>
  }
  'signal-ignored': {
    kind: 'restart' | 'rerun' | 'heal'
    reason: string
  }
  'run-status': { status: RunManifest['status'] }
  'run-complete': { status: RunManifest['status'] }
  'paused-by-user': { failureCount: number }
}

export interface LifecycleRecordOptions {
  detail?: string
  severity?: RunLifecycleSeverity
  activeCycle?: number
  lastSignal?: RunLifecycleEvent['lastSignal']
  restartPlan?: RunLifecycleRestartPlan
  targetedRerun?: RunLifecycleTargetedRerun
  abortReason?: RunLifecycleAbortReason
}

// One snapshot entry per edit surface tracked across a heal cycle. Service
// repos populate this with `gitRoot === resolveRepoPath(localPath)` and no
// pathspecs. The feature dir populates it with `gitRoot` = the workspace
// repo root (resolved via `git rev-parse --show-toplevel`) and pathspecs
// that scope the diff to the feature subtree while excluding any service
// repo nested inside.

// True when `child` is a descendant of `parent` (or identical). Used by the
// snapshot helper to decide whether a service repo lives inside the feature
// dir and therefore needs to be excluded from the feature-dir diff scope.

export type AutoHealAgent = 'claude' | 'codex'

export interface AutoHealConfig {
  agent: AutoHealAgent
  // Optional 1-based cap on heal cycles. Omit for the production default
  // (AUTO_HEAL_MAX_CYCLES = 10). The loop also gives up earlier when the
  // exact failing set stays identical past the no-progress limit
  // (heal-cycle.ts DEFAULT_NO_PROGRESS_LIMIT).
  maxCycles?: number
  // Returns the spawn command for the long-lived REPL — just the binary +
  // flags. Production wires `buildAgentSpawnCommand` from auto-heal.ts; tests
  // pass a no-op script that stays alive (e.g. `cat`). The orchestrator
  // either reuses the prior session id from `<runDir>/agent-session-id.txt`
  // (setting `resume: true`) or, for claude, generates a fresh UUID, computes
  // `mcpOutputDir`, and passes the path to the cycle-1 prompt file
  // (`<runDir>/heal-prompt.md`); the production builder appends
  // `"@<promptFile>"` as a positional arg so claude reads the file at
  // startup and processes its content as the first user message —
  // bypassing the REPL's input editor.
  buildSpawnCommand?: (args: {
    sessionId?: string
    resume?: boolean
    mcpOutputDir?: string
    promptFile?: string
    writableDirs?: readonly string[]
  }) => string
  // Returns the prompt text to write to the REPL's stdin for cycle N.
  // Production wires `buildOrchestratorHealPrompt`; tests pass a stub that
  // returns a deterministic string. The orchestrator pty.write()s the result
  // followed by a newline.
  buildCyclePrompt?: BuildHealCyclePrompt
}

export interface BuildServiceSpecsOptions {
  /** Per-run allocated ports keyed by slot name. Resolves `${port.<slot>}`
   *  tokens and is injected as each declared slot's `env` var. */
  portMap?: Map<string, number>
  /** Per-run repo localPath overrides keyed by repo name. Set when a repo is
   *  isolated in a worktree so the service `cwd` points at the worktree. */
  repoPathOverrides?: Record<string, string>
}
