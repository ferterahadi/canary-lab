import crypto from 'crypto'
import path from 'path'
import {
  runAgentProcess,
  buildClaudeAgenticArgs,
} from '../../../agent-sessions/logic/agent-process'
import { agentModelArgs, type AgentStagePlans, type ModelStageKey, type PerAgentStageChoices, type StageModelChoice } from '../../../agent-sessions/logic/agent-models'
import { recoverClaudeAssistantText } from '../../../agent-sessions/logic/agent-stream'
import { extractJsonCandidates } from '../../../agent-sessions/logic/agent-json'
import {
  claudeSessionLogPath,
  resolveWorkflowAgentRef,
  writeWorkflowAgentRef,
} from '../../../agent-sessions/logic/agent-session-log'
import { loadFeatures } from '../../../../shared/feature-loader'
import type { WorkspaceEventPublisher } from '../../../../shared/workspace-events'
import type {
  computeFeatureCoverage,
  regeneratePrdSummary,
  runCoverageEngine,
} from '../../../coverage/logic/coverage/service'

// Shared plumbing for the flight's stage adapters: the dependency bag every
// adapter factory receives, the one agent spawner (composing the consolidated
// runAgentProcess — never a copy, per cl_reuse-shared-logic), and small
// helpers (JSON extraction from an agent answer, polling).

/** Same-process HTTP reuse: adapters drive the runs / portify / evaluation
 *  subsystems through their REST routes (admission, collision, and store
 *  wiring live there) via Fastify's inject — no sockets, no drift. */
export interface FlightInjectResponse {
  statusCode: number
  json(): unknown
}
export type FlightInject = (opts: {
  method: 'GET' | 'POST' | 'DELETE'
  url: string
  payload?: unknown
}) => Promise<FlightInjectResponse>

export interface FlightAgentSpawnOpts {
  prompt: string
  cwd: string
  /** Where the agent-session ref is parked so AgentSessionView can stream it. */
  stageDir: string
  onChunk?: (text: string) => void
  /** Aborted when the user pauses/aborts the flight — the spawn SIGTERMs the
   *  agent and throws StageCancelledError instead of a generic exit error. */
  signal?: AbortSignal
  /** R79: which CLI to spawn (the flight's sticky opts.agent). Absent → claude. */
  agent?: 'claude' | 'codex'
  /** The stage's model+effort, resolved and persisted on the flight at launch
   *  (2.2.0). Absent → agent default, no flags. */
  models?: StageModelChoice
  /** Fired as soon as the CLI session is pinned, before the process starts
   *  producing output. Multi-session stages use it to preserve an immutable
   *  history ref while `stageDir` remains the mutable live/stop scope. */
  onAgentSession?: (session: { agent: 'claude' | 'codex'; sessionId: string; spawnedAt: string }) => void
  /** Identifies the flight + stage this spawn belongs to, so the runner can write
   *  it a durable record. Absent → no record (the same forward-only rule as
   *  `signal` and `spawnScope`). */
  job?: { flightId: string; feature: string; stage: string; logsDir: string }
}

/** Thrown when in-flight stage work was cancelled by a user pause/abort — the
 *  drive loop's re-read rule swallows it (the stage is already `pending`);
 *  it must never be recorded as a stage failure. */
export class StageCancelledError extends Error {
  constructor(what: string) {
    super(`${what} cancelled by flight pause/abort`)
    this.name = 'StageCancelledError'
  }
}

export type FlightAgentSpawner = (opts: FlightAgentSpawnOpts) => Promise<{ text: string }>

/** Deterministic dry-run over a feature's specs (playwright --list + tsc) —
 *  errors feed the next specs-coverage iteration's prompt. */
export type FlightSpecsValidator = (args: {
  featureDir: string
  projectRoot: string
}) => Promise<{ ok: true } | { ok: false; errors: string }>

export interface FlightStageDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
  workspaceEvents?: WorkspaceEventPublisher
  inject: FlightInject
  /** Injected in tests; defaults to a claude spawn via runAgentProcess. */
  spawnAgent?: FlightAgentSpawner
  /** Injected in tests; defaults to playwright --list + tsc --noEmit. */
  validateSpecs?: FlightSpecsValidator
  /** Test seams over the coverage engines (production uses the real ones —
   *  same injection shape as the coverage job runner's deps). */
  coverage?: {
    regenerate?: typeof regeneratePrdSummary
    runEngine?: typeof runCoverageEngine
    compute?: typeof computeFeatureCoverage
  }
  now?: () => string
}

export const FLIGHT_AGENT_IDLE_MS = 5 * 60 * 1000

/** Read the last successfully completed Claude pass in this flight. The chain
 * ref is separate from Activity sidecars because those are written at spawn
 * time and can therefore point at a failed or cancelled partial session. */
function latestFlightClaudeSession(stageDir: string): string | undefined {
  const ref = resolveWorkflowAgentRef(path.join(path.dirname(stageDir), '.agent-context'))
  return ref?.agent === 'claude' && ref.sessionId ? ref.sessionId : undefined
}

/** The one way a flight spawns judgment agents, via the shared runner.
 *  claude: session pinned so the JSONL both feeds the idle backstop and lets
 *  the UI attach an AgentSessionView to the stage. codex (R79, the flight's
 *  sticky opts.agent): `exec` reads the prompt from stdin and the final
 *  message is the captured stdout; the session ref is located by cwd+start. */
export const defaultSpawnAgent: FlightAgentSpawner = async (opts) => {
  if (opts.signal?.aborted) throw new StageCancelledError('agent spawn')
  const agent = opts.agent ?? 'claude'
  const sessionId = agent === 'claude' ? crypto.randomUUID() : undefined
  const forkFromSessionId = agent === 'claude' ? latestFlightClaudeSession(opts.stageDir) : undefined
  const spawnedAt = new Date().toISOString()
  writeWorkflowAgentRef(opts.stageDir, {
    agent,
    cwd: opts.cwd,
    spawnedAt,
    sessionId: sessionId ?? '',
  })
  opts.onAgentSession?.({ agent, sessionId: sessionId ?? '', spawnedAt })
  const handle = runAgentProcess({
    command: agent,
    ...(opts.job
      ? {
          agentJobLogsDir: opts.job.logsDir,
          record: {
            // The stage owns at most one live spawn at a time, and its sidecar dir
            // is already the unique name for it — so the scope doubles as the job
            // id and a re-spawn overwrites rather than piling up rows per attempt.
            jobId: `${opts.job.flightId}:${opts.job.stage}`,
            flightId: opts.job.flightId,
            feature: opts.job.feature,
            stage: opts.job.stage,
            agent,
            ...(sessionId ? { sessionId } : {}),
            cwd: opts.cwd,
          },
        }
      : {}),
    args:
      agent === 'claude'
        ? buildClaudeAgenticArgs(opts.prompt, {
            sessionId,
            forkFromSessionId,
            model: opts.models?.model ?? null,
            effort: opts.models?.effort ?? null,
          })
        : [
            'exec',
            '--full-auto',
            '--skip-git-repo-check',
            // Model/effort ride as exec options, before the stdin marker.
            ...agentModelArgs('codex', opts.models ?? { model: null, effort: null }),
            '-',
          ],
    cwd: opts.cwd,
    stdin: agent === 'codex' ? opts.prompt : undefined,
    captureStdout: true,
    // The stage sidecar dir doubles as the stop scope: it is already unique per
    // flight+stage, and it is what a paused stage's teardown looks the child up
    // by (see stopAgentProcesses). Aborting `signal` below asks the child to go;
    // the scope is how the pause can WAIT for it to be gone.
    spawnScope: opts.stageDir,
    onChunk: (text, stream) => {
      if (stream === 'stderr') opts.onChunk?.(text)
    },
    idleMs: FLIGHT_AGENT_IDLE_MS,
    // codex pins no session id — liveness falls back to output chunks.
    activityPath: sessionId ? claudeSessionLogPath(opts.cwd, sessionId) : undefined,
  })
  const onAbort = () => handle.stop('SIGTERM')
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await handle.done
    if (opts.signal?.aborted) throw new StageCancelledError('agent spawn')
    // Flight agents are parsed for structured output (extractJson), never shown.
    // claude: recover EVERY assistant turn, not just the final message — a scout
    // that emits the config JSON then signs off with prose in a later turn must
    // not lose the JSON to that trailing turn (the display view tails the JSONL).
    // codex: `exec` prints the final message to stdout — use it as-is.
    // Stopped rather than finished. Its partial output must NOT be handed back as
    // an answer: the stage would then fail on whatever the fragment failed to
    // parse as, and blame the agent for "not returning parseable JSON" when the
    // truth is that someone stopped it. Caught live, twice — the second time
    // because the first fix checked `signal`, and the real claude CLI HANDLES
    // SIGTERM and exits cleanly, so only the request itself is reliable.
    // (A flight-level pause never reaches here: ctx.signal makes it a
    // StageCancelledError, which the drive swallows.)
    if (result.stopped) {
      throw new Error(`agent was stopped (by ${result.stopped}) before it finished — no answer to read`)
    }
    if (result.signal) {
      throw new Error(`agent was stopped (${result.signal}) before it finished — no answer to read`)
    }
    const text = agent === 'claude' ? recoverClaudeAssistantText(result.stdout) : result.stdout
    if (result.code !== 0 && !text.trim()) {
      // `code` is a number here: a null code means the child was signalled, and
      // that is thrown above as a stop. The old `?? 'null'` fallback became
      // unreachable with it.
      throw new Error(`agent exited with code ${result.code}${result.stderr ? `: ${result.stderr.slice(-400)}` : ''}`)
    }
    if (agent === 'claude' && sessionId) {
      writeWorkflowAgentRef(path.join(path.dirname(opts.stageDir), '.agent-context'), {
        agent,
        cwd: opts.cwd,
        spawnedAt,
        sessionId,
      })
    }
    return { text }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** Pull the first JSON object out of an agent's final answer — fenced
 *  (```json … ```) or bare (see agent-json.ts for the candidate order).
 *  Throws with a short excerpt when unparseable. */
export function extractJson<T>(text: string): T {
  const candidates = extractJsonCandidates(text)
  if (!candidates.length) {
    throw new Error(`agent did not return parseable JSON (got: ${text.slice(0, 200)}…)`)
  }
  return candidates[0] as T
}

/** Decode a checkpoint response's `data` before validating its shape.
 *
 *  `respond_flight_checkpoint` schemas `data` as `z.unknown()`, so a client is
 *  free to send its answer JSON-ENCODED, and interactive MCP clients routinely
 *  do. Every responder that skipped this step reacted differently to the SAME
 *  submission: prd-summary decoded it, the specs-coverage mapping rejected it
 *  outright ("expected object, received string") and re-parked forever, and
 *  scout/scaffold read `.configSource` off a string, got `undefined`, and
 *  silently settled as though no edit had been supplied. One home so the three
 *  cannot disagree again.
 *
 *  Returns the value untouched when it is not a string: a caller that legitimately
 *  wants free text (docs feedback, the export rewrite) is unaffected. The `ok:false`
 *  arm exists so a caller can tell "not JSON at all" from "JSON of the wrong
 *  shape" — the two need different messages on the re-park. */
export function decodeSubmission(
  data: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  if (typeof data !== 'string') return { ok: true, data }
  try {
    return { ok: true, data: extractJson(data) }
  } catch {
    return { ok: false, error: 'the submission was not parseable JSON' }
  }
}

export class PollTimeoutError extends Error {
  constructor(what: string, timeoutMs: number, opts: { idle?: boolean } = {}) {
    super(
      opts.idle
        ? `${what} made no progress within ${Math.round(timeoutMs / 1000)}s`
        : `${what} did not settle within ${Math.round(timeoutMs / 1000)}s`,
    )
    this.name = 'PollTimeoutError'
  }
}

export async function pollUntil<T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  opts: {
    what: string
    intervalMs?: number
    timeoutMs: number
    signal?: AbortSignal
    /** Liveness escape: when given, every CHANGE in the key extends the
     *  deadline — `timeoutMs` then bounds IDLE time (no key change), not total
     *  wall-clock. A long job stays alive as long as it demonstrably
     *  progresses (portify's multi-attempt double-boot legitimately outruns
     *  any fixed wall-clock; a hung one still freezes its key and dies). */
    progressKey?: (value: T) => string
  },
): Promise<T> {
  const interval = opts.intervalMs ?? 2000
  let deadline = Date.now() + opts.timeoutMs
  let lastKey: string | undefined
  for (;;) {
    if (opts.signal?.aborted) throw new StageCancelledError(opts.what)
    const value = await read()
    if (settled(value)) return value
    if (opts.progressKey) {
      const key = opts.progressKey(value)
      if (key !== lastKey) {
        lastKey = key
        deadline = Date.now() + opts.timeoutMs
      }
    }
    if (Date.now() >= deadline) throw new PollTimeoutError(opts.what, opts.timeoutMs, { idle: opts.progressKey !== undefined })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        opts.signal?.removeEventListener('abort', onAbort)
        resolve()
      }, interval)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** The record descriptor for a stage's spawn. One builder so every stage names its
 *  job the same way, and a reader of the agent-jobs index can always tell which
 *  flight+stage a row belongs to. */
export function stageJobRef(
  deps: FlightStageDeps,
  m: { flightId: string; feature: string },
  stage: string,
): { flightId: string; feature: string; stage: string; logsDir: string } {
  return { flightId: m.flightId, feature: m.feature, stage, logsDir: deps.logsDir }
}

export function featureDirFor(deps: FlightStageDeps, feature: string): string {
  // A suite rename changes config.name but deliberately leaves its directory in
  // place because persisted run/coverage/portify records hold absolute paths.
  // Once a config exists, its featureDir is therefore the authority. The join
  // remains the pre-scaffold fallback, where there is no config to resolve yet.
  return loadFeatures(deps.featuresDir).find((candidate) => candidate.name === feature)?.featureDir
    ?? path.join(deps.featuresDir, feature)
}

/** The flight's persisted model+effort choice for one spawn (2.2.0). Undefined
 *  when the plan has no entry — the spawn then runs on the agent default. */
export function stageModels(
  m: { opts: { models?: AgentStagePlans } },
  key: ModelStageKey,
): StageModelChoice | undefined {
  return m.opts.models?.[key]
}

/** The same choice as a per-agent map, keyed by the CONDUCTING agent — for the
 *  coverage engines, whose CLI fallback chain takes each agent's own entry.
 *  The flight's plan was resolved for its conductor, so only that key is set;
 *  a fallback CLI (the conductor's CLI died mid-flight) runs on its default
 *  rather than on efforts from the wrong vocabulary. */
export function stageModelPlan(
  m: { opts: { agent?: 'claude' | 'codex'; models?: AgentStagePlans } },
  key: ModelStageKey,
): PerAgentStageChoices | undefined {
  const choice = stageModels(m, key)
  return choice ? { [m.opts.agent ?? 'claude']: choice } : undefined
}

/** The user's re-entry feedback ("what went wrong last time"), if it targets
 *  this stage (R74) — agent-spawning stages append it to their prompt. */
export function stageFeedback(
  m: { feedback?: { stage: string; note: string } },
  key: string,
): string | undefined {
  return m.feedback?.stage === key ? m.feedback.note : undefined
}
