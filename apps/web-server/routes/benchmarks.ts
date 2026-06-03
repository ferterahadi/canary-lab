import type { FastifyInstance } from 'fastify'
import type { BenchmarkStore } from '../lib/runtime/benchmark/store'
import type { SabotageSkill } from '../lib/runtime/benchmark/skills'
import type {
  SabotageLevel,
  StartBenchmarkInput,
  StartBenchmarkResult,
} from '../lib/runtime/benchmark/types'

// REST surface for benchmarks, mirroring routes/runs.ts. Reads go through the
// injected BenchmarkStore; the start path delegates to the injected
// `startBenchmark` factory (wired in createServer alongside the runner). The
// live race UI gets its updates from /ws/benchmark, not by polling here.

export interface BenchmarkRouteDeps {
  store: BenchmarkStore
  /** Kick off a benchmark; resolves once the run is registered (not on finish). */
  startBenchmark(input: StartBenchmarkInput): Promise<StartBenchmarkResult>
  /** Sabotage skills available for a feature (for the picker). */
  listSkills(feature: string): SabotageSkill[]
  /** Stop a running benchmark (kills its sabotage child + arm runs). */
  abortBenchmark(benchmarkId: string): void
  /** The sabotage agent's captured output (for live visibility during setup). */
  readSabotageLog(benchmarkId: string): string
  /** The sabotage agent's structured session (parsed native log) for the shared
   *  AgentSessionView timeline. Null when no session is locatable yet. */
  loadAgentSession(benchmarkId: string): { agent: string; sessionId: string; events: unknown[] } | null
}

interface StartBody {
  feature?: string
  skill?: string
  level?: string
  iterations?: number
}

const LEVELS: ReadonlySet<SabotageLevel> = new Set<SabotageLevel>(['min', 'med', 'max'])

function normalizeLevel(value: unknown): SabotageLevel {
  return typeof value === 'string' && LEVELS.has(value as SabotageLevel)
    ? (value as SabotageLevel)
    : 'med'
}

export async function benchmarkRoutes(
  app: FastifyInstance,
  deps: BenchmarkRouteDeps,
): Promise<void> {
  app.get('/api/benchmarks', async () => deps.store.list())

  app.get<{ Querystring: { feature?: string } }>('/api/benchmark-skills', async (req) =>
    deps.listSkills(req.query.feature ?? '').map((s) => ({
      name: s.name,
      title: s.title,
      level: s.level,
      summary: s.summary,
      description: s.description,
      recipe: s.recipe,
    })),
  )

  app.get<{ Params: { benchmarkId: string } }>(
    '/api/benchmarks/:benchmarkId',
    async (req, reply) => {
      const manifest = deps.store.get(req.params.benchmarkId)
      if (!manifest) {
        reply.code(404)
        return { error: 'benchmark not found' }
      }
      return manifest
    },
  )

  app.get<{ Params: { benchmarkId: string } }>(
    '/api/benchmarks/:benchmarkId/sabotage-log',
    async (req) => ({ log: deps.readSabotageLog(req.params.benchmarkId) }),
  )

  // Structured sabotage-agent session for the shared AgentSessionView timeline.
  app.get<{ Params: { benchmarkId: string } }>(
    '/api/benchmarks/:benchmarkId/agent-session',
    async (req, reply) => {
      const session = deps.loadAgentSession(req.params.benchmarkId)
      if (!session) {
        reply.code(404)
        return { reason: 'no-session' }
      }
      return session
    },
  )

  app.post<{ Params: { benchmarkId: string } }>(
    '/api/benchmarks/:benchmarkId/abort',
    async (req) => {
      deps.abortBenchmark(req.params.benchmarkId)
      return { ok: true }
    },
  )

  app.post<{ Body: StartBody }>('/api/benchmarks', async (req, reply) => {
    const body = req.body ?? {}
    const feature = typeof body.feature === 'string' ? body.feature.trim() : ''
    if (!feature) {
      reply.code(400)
      return { error: 'feature is required' }
    }
    const iterations =
      Number.isInteger(body.iterations) && (body.iterations as number) > 0
        ? (body.iterations as number)
        : 1
    const skill =
      typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : 'default'
    try {
      return await deps.startBenchmark({ feature, skill, level: normalizeLevel(body.level), iterations })
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500
      reply.code(statusCode)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
