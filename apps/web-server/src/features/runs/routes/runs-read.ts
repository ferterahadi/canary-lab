// Runs REST — reads: index, detail, verification report, agent session, and the
// Playwright artifact stream. Split out of runs.ts; handler bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'
import fs from 'fs'
import path from 'path'
import { updateManifest, type RunProposedPr } from '../logic/runtime/manifest'
import { applyFixCapture } from '../logic/apply-fixes'
import { buildPrPreflight } from '../logic/pr/pr-preflight'
import { proposeFixesForRun } from '../logic/pr/propose-fixes'
import { detectGhStatus } from '../../../shared/gh-cli'
import { buildRunPaths, runDirFor } from '../logic/runtime/run-paths'
import {
  buildAgentSessionResponse,
  locateMostRecentAgentSessionRef,
  parseAgentSessionRefFile,
  selectAgentSessionRef,
} from '../../agent-sessions/logic/agent-session-log'
import { ExternalHealAgentRequest, contentTypeFor } from './runs-route-support'

export { compareActiveRuns } from './runs-route-support'
export type { ExternalHealAgentRequest } from './runs-route-support'

export async function registerRunReadRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.get<{ Querystring: { feature?: string } }>('/api/runs', async (req) => {
    return deps.store.list({ feature: req.query.feature })
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    return detail
  })

  // Apply a run's captured heal fixes (R80) INTO the real product repos on
  // demand — the only path a run's edits reach the user's source tree. 404 when
  // the run is unknown, 409 when it captured no fixes, otherwise 200 with a
  // per-repo result (a 3-way conflict is `ok:false` with a reason, not a throw).
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/apply-fixes', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    const fixCapture = detail.manifest.fixCapture
    if (!fixCapture || fixCapture.repos.length === 0) {
      reply.code(409)
      return { error: 'this run captured no fixes to apply' }
    }
    const outcome = await applyFixCapture(fixCapture)
    reply.code(200)
    return outcome
  })

  // gh (GitHub CLI) connection status — detect-and-instruct only (never runs
  // login, never handles the token). Feeds the Settings "GitHub" section and the
  // PR dialog's preflight. App-level, not run-scoped.
  app.get('/api/gh/status', async () => {
    return detectGhStatus()
  })

  // The captured patch as text, for the Changes tab's inline diff. The repo
  // name is looked up in the run's OWN capture rather than joined into a path,
  // so this can only ever read a patch this run wrote.
  app.get<{ Params: { runId: string; repoName: string } }>('/api/runs/:runId/fixes/:repoName/patch', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    const repo = detail.manifest.fixCapture?.repos.find((r) => r.repoName === req.params.repoName)
    if (!repo) {
      reply.code(404)
      return { error: 'no captured patch for this repo' }
    }
    try {
      return { repoName: repo.repoName, patchPath: repo.patchPath, files: repo.files, diff: fs.readFileSync(repo.patchPath, 'utf-8') }
    } catch {
      // The run dir can be trimmed or deleted from the Cleanup page while the
      // manifest still names the patch — that's a gone file, not a bad request.
      reply.code(410)
      return { error: 'the patch file is no longer on disk' }
    }
  })

  // Can we open a PR from this run's captured fix? Per-repo origin + default
  // branch + push rights (side-effect-free). The PR dialog re-runs this on open
  // (auth changes outside the app). 404/409 mirror apply-fixes.
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/pr-preflight', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    const fixCapture = detail.manifest.fixCapture
    if (!fixCapture || fixCapture.repos.length === 0) {
      reply.code(409)
      return { error: 'this run captured no fixes' }
    }
    return buildPrPreflight(fixCapture)
  })

  // Open a PR from the captured fix, per pushable repo (on demand). The product
  // repo is never touched — a throwaway worktree from the run's baseSha is
  // committed, force-pushed to a deterministic branch, and turned into a PR.
  // Idempotent; persists manifest.proposedPrs so a refresh shows the link.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/propose-pr', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    const fixCapture = detail.manifest.fixCapture
    if (!fixCapture || fixCapture.repos.length === 0) {
      reply.code(409)
      return { error: 'this run captured no fixes' }
    }
    const preflight = await buildPrPreflight(fixCapture)
    if (!preflight.anyPushable) {
      reply.code(409)
      return { error: 'no repo is pushable — connect GitHub (Settings) or check push access', preflight }
    }
    const results = await proposeFixesForRun({ runId: detail.runId, feature: detail.manifest.feature, fixCapture, preflight })
    // Merge the freshly-opened PRs into the manifest by repo name (idempotent),
    // and record the attempt either way — the Changes tab reads the same
    // per-repo reasons whether the run proposed on its own or the user did.
    const opened = results.filter((r): r is typeof r & { pr: RunProposedPr } => r.ok && !!r.pr).map((r) => r.pr)
    const prAttempt = {
      at: new Date().toISOString(),
      auto: false,
      results: results.map((r) => ({
        repoName: r.repoName,
        ok: r.ok,
        ...(r.pr ? { url: r.pr.url } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      })),
    }
    // Written through the store, not straight to the file: the store's emitter
    // is what pushes the change over the runs WebSocket, so an open Changes tab
    // shows the new PR link without a refetch.
    if (opened.length > 0) {
      const prev = detail.manifest.proposedPrs ?? []
      const byRepo = new Map<string, RunProposedPr>(prev.map((p) => [p.repoName, p]))
      for (const pr of opened) byRepo.set(pr.repoName, pr)
      deps.store.patchManifest(detail.runId, { proposedPrs: [...byRepo.values()], prAttempt })
    } else {
      deps.store.patchManifest(detail.runId, { prAttempt })
    }
    reply.code(200)
    return { results }
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/verification-report', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    if ((detail.manifest.executionType ?? 'run') !== 'verify') {
      reply.code(409)
      return { error: 'run is not a verification execution' }
    }
    return {
      runId: detail.runId,
      executionType: 'verify',
      status: detail.manifest.status,
      verification: detail.manifest.verification ?? null,
    }
  })

  // Structured heal-agent session view. Reads the per-run pointer file
  // (`agent-session.json`) the orchestrator writes after a heal cycle ends,
  // then parses + normalizes the agent CLI's own JSONL log into a uniform
  // event stream for both claude and codex. 404 with a `reason` field in
  // every failure mode — the UI falls back to the raw transcript replay.
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/agent-session', async (req, reply) => {
    const detail = deps.store.get(req.params.runId)
    if (!detail) {
      reply.code(404)
      return { reason: 'run-not-found' }
    }
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    // Prefer the most-recently-modified agent JSONL on disk over the
    // orchestrator-written ref file. The ref file is only updated when the
    // heal loop's cleanup runs cleanly — a SIGKILL'd server or a one-off
    // locator miss leaves it pointing at a stale agent (e.g. claude) even
    // when codex has since produced newer cycles for the same runDir. Fall
    // back to the ref file when no on-disk logs are locatable.
    const refPath = buildRunPaths(runDir).agentSessionRefPath
    let raw: string | null = null
    try { raw = fs.readFileSync(refPath, 'utf-8') } catch { /* missing or unreadable */ }
    const parsed = raw ? parseAgentSessionRefFile(raw) : null
    const ref = locateMostRecentAgentSessionRef(runDir)
      ?? (parsed ? selectAgentSessionRef(parsed) : null)
    if (!ref) {
      reply.code(404)
      return { reason: 'no-session-ref' }
    }
    if (!fs.existsSync(ref.logPath)) {
      reply.code(404)
      return { reason: 'session-log-missing' }
    }
    return buildAgentSessionResponse(ref)
  })

  app.get<{ Params: { runId: string; '*': string } }>('/api/runs/:runId/artifacts/*', async (req, reply) => {
    const runDir = runDirFor(deps.store.logsDir, req.params.runId)
    const runPaths = buildRunPaths(runDir)
    // Try the live `playwright-artifacts/` first, then fall back to the
    // durable `playwright-artifacts-keep/` snapshot. Heal-cycle reruns wipe
    // the live dir at the start of every Playwright invocation, so the keep
    // dir is what carries the videos/traces for tests not in the latest
    // rerun selection.
    const bases = [runPaths.playwrightArtifactsDir, runPaths.playwrightArtifactsKeepDir]
    let validRel: string | null = null
    for (const base of bases) {
      const requested = path.resolve(base, req.params['*'])
      const rel = path.relative(base, requested)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      validRel = rel
      try {
        const stat = fs.statSync(requested)
        if (stat.isFile()) {
          reply.type(contentTypeFor(requested))
          return reply.send(fs.createReadStream(requested))
        }
      } catch { /* try next base */ }
    }
    if (validRel === null) {
      reply.code(400)
      return { error: 'invalid artifact path' }
    }
    reply.code(404)
    return { error: 'artifact not found' }
  })
}
