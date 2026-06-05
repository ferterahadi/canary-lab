import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { BenchmarkStore } from '../lib/runtime/benchmark/store'
import type { SabotageSkill } from '../lib/runtime/benchmark/skills'
import type {
  BenchmarkManifest,
  SabotageLevel,
  StartBenchmarkInput,
  StartBenchmarkResult,
} from '../lib/runtime/benchmark/types'
import { benchmarkDir } from '../lib/runtime/benchmark/paths'
import { addWorktree } from '../lib/runtime/repo-worktree'
import { launchEditorDir } from '../lib/editor-launch'
import { loadProjectConfig, type EditorChoice } from '../lib/runtime/launcher/project-config'

// REST surface for benchmarks, mirroring routes/runs.ts. Reads go through the
// injected BenchmarkStore; the start path delegates to the injected
// `startBenchmark` factory (wired in createServer alongside the runner). The
// live race UI gets its updates from /ws/benchmark, not by polling here.

export interface BenchmarkRouteDeps {
  store: BenchmarkStore
  /** Logs root — used to resolve a benchmark's worktree dir for inspection. */
  logsDir: string
  /** Project root — used to read the configured editor for "open worktree". */
  projectRoot?: string
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
  agent?: string
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

  // Open one of a benchmark's worktrees in the user's editor:
  //   • 'frozen' → a pristine, never-heal-edited checkout at the sabotage SHA,
  //     created lazily on first use (and re-creatable any time after the run,
  //     since the SHA is a real commit). Removed via the cleanup worktree list.
  //   • 'A' / 'B' → the live arm worktree (heal-edited), available only WHILE
  //     the benchmark runs; auto-cleaned when it finishes.
  app.post<{ Params: { benchmarkId: string }; Body: { target?: string } }>(
    '/api/benchmarks/:benchmarkId/open-worktree',
    async (req, reply) => {
      const manifest = deps.store.get(req.params.benchmarkId)
      if (!manifest) {
        reply.code(404)
        return { error: 'benchmark not found' }
      }
      const target = req.body?.target
      if (target !== 'frozen' && target !== 'A' && target !== 'B') {
        reply.code(400)
        return { error: 'target must be "frozen", "A", or "B"' }
      }

      let dir: string
      if (target === 'frozen') {
        if (!manifest.sabotageSha) {
          reply.code(409)
          return { error: 'the bug is not frozen yet' }
        }
        if (!manifest.featureDir) {
          reply.code(409)
          return { error: 'benchmark has no feature directory to inspect' }
        }
        try {
          dir = await ensureInspectWorktree(deps.logsDir, manifest)
        } catch (err) {
          reply.code(500)
          return { error: err instanceof Error ? err.message : String(err) }
        }
      } else {
        const arm = manifest.arms.find((a) => a.arm === target)
        const armPath = arm?.worktreePath
        if (!armPath || !fs.existsSync(armPath)) {
          reply.code(409)
          return { error: 'arm worktree is no longer available — it is removed when the benchmark finishes' }
        }
        dir = armPath
      }

      const editor: EditorChoice = deps.projectRoot ? loadProjectConfig(deps.projectRoot).editor : 'auto'
      try {
        const usedEditor = launchEditorDir(editor, dir)
        return { opened: true, path: dir, editor: usedEditor }
      } catch (err) {
        // Best-effort: report the path so the UI can offer a copy-path fallback.
        reply.code(200)
        return { opened: false, path: dir, error: err instanceof Error ? err.message : String(err) }
      }
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
    const agent = body.agent === 'codex' ? 'codex' : body.agent === 'claude' ? 'claude' : undefined
    try {
      return await deps.startBenchmark({ feature, skill, level: normalizeLevel(body.level), iterations, agent })
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500
      reply.code(statusCode)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}

// Lazily ensure a pristine checkout at the sabotage SHA under the benchmark's
// `worktrees/inspect/` dir, returning the worktree root. Idempotent: reuses an
// existing checkout if one is already there (a second click, or after the run).
async function ensureInspectWorktree(logsDir: string, manifest: BenchmarkManifest): Promise<string> {
  const inspectParent = path.join(benchmarkDir(logsDir, manifest.benchmarkId), 'worktrees', 'inspect')
  if (fs.existsSync(inspectParent)) {
    const existing = fs.readdirSync(inspectParent, { withFileTypes: true }).find((e) => e.isDirectory())
    if (existing) return path.join(inspectParent, existing.name)
  }
  const handle = await addWorktree({
    repoName: manifest.feature,
    localPath: manifest.featureDir as string,
    worktreesDir: inspectParent,
    branch: manifest.sabotageSha,
  })
  return handle.worktreeRoot
}
