import crypto from 'crypto'
import path from 'path'
import {
  runAgentProcess,
  buildClaudeAgenticArgs,
} from '../../../agent-sessions/logic/agent-process'
import { recoverClaudeFinalText } from '../../../agent-sessions/logic/agent-stream'
import {
  claudeSessionLogPath,
  writeWorkflowAgentRef,
} from '../../../agent-sessions/logic/agent-session-log'
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
  method: 'GET' | 'POST'
  url: string
  payload?: unknown
}) => Promise<FlightInjectResponse>

export interface FlightAgentSpawnOpts {
  prompt: string
  cwd: string
  /** Where the agent-session ref is parked so AgentSessionView can stream it. */
  stageDir: string
  onChunk?: (text: string) => void
}

export type FlightAgentSpawner = (opts: FlightAgentSpawnOpts) => Promise<{ text: string }>

export interface FlightStageDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
  workspaceEvents?: WorkspaceEventPublisher
  inject: FlightInject
  /** Injected in tests; defaults to a claude spawn via runAgentProcess. */
  spawnAgent?: FlightAgentSpawner
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

/** The one way a flight spawns judgment agents: claude via the shared
 *  runner, session pinned so the JSONL both feeds the idle backstop and lets
 *  the UI attach an AgentSessionView to the stage. */
export const defaultSpawnAgent: FlightAgentSpawner = async (opts) => {
  const sessionId = crypto.randomUUID()
  writeWorkflowAgentRef(opts.stageDir, {
    agent: 'claude',
    cwd: opts.cwd,
    spawnedAt: new Date().toISOString(),
    sessionId,
  })
  const handle = runAgentProcess({
    command: 'claude',
    args: buildClaudeAgenticArgs(opts.prompt, { sessionId }),
    cwd: opts.cwd,
    captureStdout: true,
    onChunk: (text, stream) => {
      if (stream === 'stderr') opts.onChunk?.(text)
    },
    idleMs: FLIGHT_AGENT_IDLE_MS,
    activityPath: claudeSessionLogPath(opts.cwd, sessionId),
  })
  const result = await handle.done
  const text = recoverClaudeFinalText(result.stdout)
  if (result.code !== 0 && !text.trim()) {
    throw new Error(`agent exited with code ${result.code ?? 'null'}${result.stderr ? `: ${result.stderr.slice(-400)}` : ''}`)
  }
  return { text }
}

/** Pull the first JSON object out of an agent's final answer — fenced
 *  (```json … ```) or bare. Throws with a short excerpt when unparseable. */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue
    try {
      return JSON.parse(candidate.trim()) as T
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`agent did not return parseable JSON (got: ${text.slice(0, 200)}…)`)
}

export class PollTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} did not settle within ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'PollTimeoutError'
  }
}

export async function pollUntil<T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  opts: { what: string; intervalMs?: number; timeoutMs: number },
): Promise<T> {
  const interval = opts.intervalMs ?? 2000
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const value = await read()
    if (settled(value)) return value
    if (Date.now() >= deadline) throw new PollTimeoutError(opts.what, opts.timeoutMs)
    await new Promise((r) => setTimeout(r, interval))
  }
}

export function featureDirFor(deps: FlightStageDeps, feature: string): string {
  return path.join(deps.featuresDir, feature)
}
