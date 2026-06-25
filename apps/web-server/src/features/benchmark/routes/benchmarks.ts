import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { BenchmarkStore } from '../../benchmark/logic/runtime/store'
import type { SabotageSkill } from '../../benchmark/logic/runtime/skills'
import type {
  BenchmarkManifest,
  SabotageLevel,
  StartBenchmarkInput,
  StartBenchmarkResult,
} from '../../benchmark/logic/runtime/types'
import { benchmarkDir } from '../../benchmark/logic/runtime/paths'
import { addWorktree, removeWorktree } from '../../runs/logic/runtime/repo-worktree'
import { listWorktrees } from '../../runs/logic/runtime/worktree-inventory'
import { loadFeatures } from '../../config/logic/feature-loader'
import { computePortPreflight } from '../../runs/logic/runtime/port-preflight'
import { getGitRoot, resolveRepoPath } from '../../../shared/git-repo'
import { launchEditorDir } from '../../../shared/editor-launch'
import { loadProjectConfig, type EditorChoice } from '../../runs/logic/runtime/launcher/project-config'

// REST surface for benchmarks, mirroring routes/runs.ts. Reads go through the
// injected BenchmarkStore; the start path delegates to the injected
// `startBenchmark` factory (wired in createServer alongside the runner). The
// live race UI gets its updates from /ws/benchmark, not by polling here.

export interface BenchmarkRouteDeps {
  store: BenchmarkStore
  /** Logs root — used to resolve a benchmark's worktree dir for inspection. */
  logsDir: string
  /** Features root — used to resolve source repos when clearing worktrees. */
  featuresDir: string
  /** Project root — used to read the configured editor for "open worktree". */
  projectRoot?: string
  /** Kick off a benchmark; resolves once the run is registered (not on finish). */
  startBenchmark(input: StartBenchmarkInput): Promise<StartBenchmarkResult>
  /** Sabotage skills available for a feature (for the picker). */
  listSkills(feature: string): SabotageSkill[]
  /** Stop a running benchmark (kills its sabotage child + arm runs). */
  abortBenchmark(benchmarkId: string): void
  /** The sabotage agent's structured session (parsed native log) for the shared
   *  AgentSessionView timeline. Null when no session is locatable yet. */
  loadAgentSession(benchmarkId: string): { agent: string; sessionId: string; model?: string; effort?: string; events: unknown[] } | null
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

  // Dynamic-ports preflight: does the selected feature declare port slots, so
  // benchmark arms (which boot the same feature concurrently) won't clash on a
  // hardcoded port? `portsConfigured: false` tells the UI to offer the
  // port-ification workflow before starting. Static path — registered before
  // `/:benchmarkId` so Fastify's router never treats "preflight" as an id.
  app.get<{ Querystring: { feature?: string; env?: string } }>(
    '/api/benchmarks/preflight',
    async (req, reply) => {
      const featureName = (req.query.feature ?? '').trim()
      if (!featureName) {
        reply.code(400)
        return { error: 'feature is required' }
      }
      const feature = loadFeatures(deps.featuresDir).find((f) => f.name === featureName)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const env = typeof req.query.env === 'string' && req.query.env.trim() ? req.query.env.trim() : undefined
      return computePortPreflight(feature, env)
    },
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
  //     since the SHA stays reachable through the retained arm worktrees).
  //   • 'A' / 'B' → the arm worktree (heal-edited), available during AND after
  //     the run for inspection.
  // Both are gone once the user clears this benchmark's worktrees.
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
      if (manifest.worktreesCleared) {
        reply.code(409)
        return { error: 'worktrees have been cleared for this benchmark' }
      }

      let dir: string
      if (target === 'frozen') {
        if (!manifest.sabotageSha) {
          reply.code(409)
          return { error: 'the bug is not frozen yet' }
        }
        // The sabotage commit lives in the sabotaged repo (repoPath). Older
        // manifests predate that field — fall back to featureDir (correct only
        // when the feature dir lives inside the sabotaged repo).
        if (!manifest.repoPath && !manifest.featureDir) {
          reply.code(409)
          return { error: 'benchmark has no repo to inspect' }
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
          return { error: 'arm worktree is not available (it may have been cleared)' }
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

  // Reclaim a finished benchmark's worktrees (staging, arm-A, arm-B, and any
  // lazily-created inspect checkout). Two-phase, gated on `confirm` (the codebase
  // convention for destructive ops): the UI first POSTs without `confirm` to get
  // the disk it would free (for the confirm dialog), then POSTs `confirm: true`
  // to actually remove them. After clearing, "Open frozen bug" + arm inspection
  // are no longer available (the sabotage SHA becomes unreachable).
  app.post<{ Params: { benchmarkId: string }; Body: { confirm?: boolean } }>(
    '/api/benchmarks/:benchmarkId/clear-worktrees',
    async (req, reply) => {
      const manifest = deps.store.get(req.params.benchmarkId)
      if (!manifest) {
        reply.code(404)
        return { error: 'benchmark not found' }
      }
      const done = manifest.status === 'done' || manifest.status === 'aborted' || manifest.status === 'error'
      if (!done) {
        reply.code(409)
        return { error: 'cannot clear worktrees while the benchmark is still running' }
      }
      if (manifest.worktreesCleared) {
        return { confirmed: false, willClear: 0, cleared: 0, freedBytes: manifest.worktreesClearedBytes ?? 0, alreadyCleared: true }
      }

      const sourceRoots = await featureRepoRoots(deps.featuresDir)
      const owned = (await listWorktrees({ logsDir: deps.logsDir, sourceRoots, now: Date.now() })).filter(
        (e) => e.ownerKind === 'benchmark' && e.ownerId === manifest.benchmarkId,
      )
      const freedBytes = owned.reduce((sum, e) => sum + e.bytes, 0)

      // Dry run: report what would be freed so the UI can show it in the confirm.
      if (req.body?.confirm !== true) {
        return { confirmed: false, willClear: owned.length, cleared: 0, freedBytes }
      }

      for (const e of owned) {
        await removeWorktree({ sourceRoot: e.sourceRoot, worktreeRoot: e.path }).catch(() => {})
      }
      deps.store.save({ ...manifest, worktreesCleared: true, worktreesClearedBytes: freedBytes })
      return { confirmed: true, willClear: owned.length, cleared: owned.length, freedBytes }
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

// Git toplevels of every configured feature repo — the source roots that
// `git worktree remove` / `listWorktrees` operate against. Mirrors the helper
// in routes/runs.ts (kept local to avoid a route→route import).
async function featureRepoRoots(featuresDir: string): Promise<string[]> {
  const roots = new Set<string>()
  for (const feature of loadFeatures(featuresDir)) {
    for (const repo of feature.repos ?? []) {
      try {
        const root = await getGitRoot(resolveRepoPath(repo.localPath))
        if (root) roots.add(root)
      } catch { /* skip repos that aren't resolvable */ }
    }
  }
  return [...roots]
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
  // Worktree the SABOTAGED repo at the sabotage SHA — not featureDir, which for
  // external feature dirs is a different git repo that lacks the commit (the
  // cause of "git worktree add … invalid reference"). Fall back to featureDir
  // for manifests written before repoPath existed.
  const handle = await addWorktree({
    repoName: manifest.feature,
    localPath: (manifest.repoPath ?? manifest.featureDir) as string,
    worktreesDir: inspectParent,
    branch: manifest.sabotageSha,
  })
  return handle.worktreeRoot
}
