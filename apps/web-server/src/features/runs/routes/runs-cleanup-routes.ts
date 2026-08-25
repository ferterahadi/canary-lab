// Runs REST — the cleanup surface: run/worktree listings, worktree open+delete,
// and per-run artifact trimming. Split out of runs.ts; bodies unchanged.
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'
import fs from 'fs'
import path from 'path'
import type { RunStore } from '../logic/run-store'
import { removeWorktree } from '../logic/runtime/repo-worktree'
import { listWorktrees, isUnder } from '../logic/runtime/worktree-inventory'
import { launchEditorDir } from '../../../shared/editor-launch'
import { loadProjectConfig } from '../logic/runtime/launcher/project-config'
import { ExternalHealAgentRequest, featureRepoRoots } from './runs-route-support'

export { compareActiveRuns } from './runs-route-support'
export type { ExternalHealAgentRequest } from './runs-route-support'

export async function registerRunCleanupRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.get('/api/cleanup/runs', async () => {
    return deps.store.cleanupListing()
  })

  // GET /api/cleanup/worktrees — every git worktree canary-lab created under the
  // logs dir (per-run isolation, benchmark arm/staging, inspect snapshots, plus
  // stale ones left by crashed runs). `active` worktrees belong to a still-
  // running run/benchmark and must not be removed out from under it.
  app.get('/api/cleanup/worktrees', async () => {
    const sourceRoots = await featureRepoRoots(deps.featuresDir)
    const entries = await listWorktrees({ logsDir: deps.store.logsDir, sourceRoots, now: Date.now() })
    return {
      worktrees: entries.map((e) => ({
        ...e,
        active:
          (e.ownerKind === 'run' || e.ownerKind === 'benchmark') && e.ownerId
            ? !!deps.isWorktreeOwnerActive?.(e.ownerKind, e.ownerId)
            : false,
      })),
    }
  })

  // POST /api/cleanup/worktrees/open — open a worktree folder in the user's
  // editor ("visit"). Guarded to paths inside the logs dir. Best-effort launch.
  app.post<{ Body: { path?: string } }>('/api/cleanup/worktrees/open', async (req, reply) => {
    const target = req.body?.path
    if (!target || typeof target !== 'string') {
      reply.code(400)
      return { error: 'path is required' }
    }
    if (!isUnder(target, deps.store.logsDir)) {
      reply.code(400)
      return { error: 'path must be inside the logs directory' }
    }
    if (!fs.existsSync(target)) {
      reply.code(404)
      return { error: 'worktree directory not found' }
    }
    const editor = deps.projectRoot ? loadProjectConfig(deps.projectRoot).editor : 'auto'
    try {
      const usedEditor = launchEditorDir(editor, target)
      return { opened: true, path: target, editor: usedEditor }
    } catch (err) {
      reply.code(200)
      return { opened: false, path: target, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // DELETE /api/cleanup/worktrees — remove one worktree via `git worktree
  // remove` (+ prune), guarded to paths inside the logs dir and not in use.
  app.delete<{ Body: { path?: string } }>('/api/cleanup/worktrees', async (req, reply) => {
    const target = req.body?.path
    if (!target || typeof target !== 'string') {
      reply.code(400)
      return { error: 'path is required' }
    }
    if (!isUnder(target, deps.store.logsDir)) {
      reply.code(400)
      return { error: 'path must be inside the logs directory' }
    }
    const sourceRoots = await featureRepoRoots(deps.featuresDir)
    const entries = await listWorktrees({ logsDir: deps.store.logsDir, sourceRoots, now: Date.now() })
    const entry = entries.find((e) => e.path === target)
    if (!entry) {
      reply.code(404)
      return { error: 'worktree not found' }
    }
    const active =
      (entry.ownerKind === 'run' || entry.ownerKind === 'benchmark') && entry.ownerId
        ? !!deps.isWorktreeOwnerActive?.(entry.ownerKind, entry.ownerId)
        : false
    if (active) {
      reply.code(409)
      return { error: 'worktree belongs to an active run — abort it first' }
    }
    await removeWorktree({ sourceRoot: entry.sourceRoot, worktreeRoot: entry.path })
    return { removed: true, freedBytes: entry.bytes }
  })

  // POST /api/runs/:runId/trim — reclaim disk by deleting a terminal run's
  // Playwright artifact dirs while keeping the run in history. Same active/
  // stale policy as DELETE (enforced in `RunStore.trimArtifacts`), mapped to
  // HTTP codes here.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/trim', async (req, reply) => {
    const result = deps.store.trimArtifacts(req.params.runId)
    if (!result.ok) {
      if (result.reason === 'not-found') {
        reply.code(404)
        return { error: 'run not found' }
      }
      reply.code(409)
      return {
        error: result.reason === 'active'
          ? 'run is still active; abort it first'
          : 'run is still active; reap or abort first',
      }
    }
    return { freedBytes: result.freedBytes ?? 0 }
  })
}
