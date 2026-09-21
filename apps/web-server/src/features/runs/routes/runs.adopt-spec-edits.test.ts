// POST /api/runs/:runId/adopt-spec-edits — the human-only lever that lets a
// mid-run spec edit into a run (D9/D13). Beside /approve-dirty: no
// unrestricted MCP tool wraps it; elicited review passes an exact revision.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import Fastify from 'fastify'
import { runsRoutes } from './runs'
import { createRegistry, RunStore, type OrchestratorLike } from '../logic/run-store'
import type { WorkspaceEvent } from '../../../shared/workspace-events'
import { writeManifest, readManifest } from '../logic/runtime/manifest'
import { runDirFor } from '../logic/runtime/run-paths'
import { suiteReviewRevision } from '../logic/runtime/suite-review'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-adopt-')))
  fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'features'), { recursive: true })
})

async function build(events: WorkspaceEvent[] = []) {
  const registry = createRegistry()
  const store = new RunStore(path.join(tmpDir, 'logs'), registry)
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    store,
    startRun: async () => { throw new Error('not configured') },
    workspaceEvents: { publish: (event) => { events.push(event) } },
  })
  return { app, registry, store }
}

function terminalReview(status: 'passed' | 'failed' | 'aborted' = 'passed') {
  const featureDir = path.join(tmpDir, 'features', 'demo')
  const runDir = runDirFor(path.join(tmpDir, 'logs'), 'terminal')
  const snapshot = path.join(runDir, 'suite')
  fs.rmSync(featureDir, { recursive: true, force: true })
  for (const dir of [featureDir, snapshot]) fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(snapshot, 'e2e/a.spec.ts'), 'recorded\n')
  fs.writeFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'recorded\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: featureDir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Canary Test')
  git('add', '.')
  git('commit', '-qm', 'initial')
  fs.writeFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'candidate\n')
  const revision = suiteReviewRevision(snapshot, featureDir)
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId: 'terminal', feature: 'demo', featureDir, startedAt: 'now', status,
    services: [], healCycles: 0,
    suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: 'now', digest: 'digest' },
    specEdits: { checkedAt: 'now', pending: [{ file: 'e2e/a.spec.ts', change: 'modified', affectedTests: [] }], adopted: [] },
  })
  return { featureDir, runDir, snapshot, revision }
}

function stub(adopt: OrchestratorLike['adoptSpecEdits']): OrchestratorLike {
  return {
    runId: 'r1',
    stop: async () => {},
    pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
    cancelHeal: async () => ({ ok: true }),
    adoptSpecEdits: adopt,
  }
}

describe('POST /api/runs/:runId/adopt-spec-edits', () => {
  it('404s for a run that is not active — a new run adopts the live suite by itself', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/adopt-spec-edits' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/not active/)
  })

  it('202s with the adopted files and whether a rerun was signalled', async () => {
    const { app, registry } = await build()
    registry.set('r1', stub(async () => ({ ok: true, adopted: ['e2e/a.spec.ts'], rerun: 'signalled' })))
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/adopt-spec-edits' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'adopted', adopted: ['e2e/a.spec.ts'], rerun: 'signalled' })
  })

  it('passes the exact review revision to the orchestrator and rejects malformed revisions', async () => {
    const { app, registry } = await build()
    const adopt = vi.fn(async () => ({ ok: true as const, adopted: ['e2e/a.spec.ts'], rerun: 'signalled' as const }))
    registry.set('r1', stub(adopt))
    const expectedRevision = 'a'.repeat(64)
    expect((await app.inject({ method: 'POST', url: '/api/runs/r1/adopt-spec-edits', payload: { expectedRevision } })).statusCode).toBe(202)
    expect(adopt).toHaveBeenCalledWith(expectedRevision)
    expect((await app.inject({ method: 'POST', url: '/api/runs/r1/adopt-spec-edits', payload: { expectedRevision: 'not-a-revision' } })).statusCode).toBe(400)
    expect(adopt).toHaveBeenCalledTimes(1)
  })

  it.each(['tests-running', 'nothing-to-adopt', 'snapshot-failed', 'review-changed'] as const)('409s with reason=%s', async (reason) => {
    const { app, registry } = await build()
    registry.set('r1', stub(async () => ({ ok: false, reason })))
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/adopt-spec-edits' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })

  it('approves exact terminal-run bytes for a new run without changing the old snapshot or verdict', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const payload = { expectedRevision: seeded.revision }

    const first = await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload })
    expect(first.statusCode).toBe(202)
    expect(first.json()).toMatchObject({ status: 'approved-for-new-run', newRunRequired: true })
    expect(fs.readFileSync(path.join(seeded.snapshot, 'e2e/a.spec.ts'), 'utf8')).toBe('recorded\n')
    expect(readManifest(path.join(seeded.runDir, 'manifest.json'))).toMatchObject({
      status: 'passed',
      specEdits: { reviewDecisions: [{ revision: seeded.revision, decision: 'approved-for-new-run' }] },
    })
    const replay = await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload })
    expect(replay.statusCode).toBe(200)
    expect(readManifest(path.join(seeded.runDir, 'manifest.json'))?.specEdits?.reviewDecisions).toHaveLength(1)
  })

  it('rejects stale and competing terminal decisions, including concurrent requests', async () => {
    const { app } = await build()
    const stale = terminalReview('failed')
    fs.appendFileSync(path.join(stale.featureDir, 'e2e/a.spec.ts'), 'newer\n')
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: stale.revision } })).statusCode).toBe(409)

    fs.rmSync(stale.runDir, { recursive: true, force: true })
    const current = terminalReview('aborted')
    const [approve, restore] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: current.revision } }),
      app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: current.revision } }),
    ])
    const codes = [approve.statusCode, restore.statusCode]
    expect(codes.filter((code) => code === 409)).toHaveLength(1)
    expect(codes.some((code) => code === 200 || code === 202)).toBe(true)
    expect(readManifest(path.join(current.runDir, 'manifest.json'))?.specEdits?.reviewDecisions).toHaveLength(1)
  })
})

describe('POST /api/runs/:runId/accept-test-review', () => {
  it('commits and records a terminal review receipt without changing the old verdict', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const payload = { expectedRevision: seeded.revision }

    const first = await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload })
    expect(first.statusCode).toBe(202)
    expect(first.json()).toMatchObject({
      decision: 'accepted', review_revision: seeded.revision, files: ['e2e/a.spec.ts'],
      git: { status: 'committed', commit: expect.stringMatching(/^[a-f0-9]{40}$/) },
      execution: { status: 'new-run-required', runId: 'terminal' },
    })
    expect(readManifest(path.join(seeded.runDir, 'manifest.json'))).toMatchObject({
      status: 'passed',
      specEdits: { reviewDecisions: [{ revision: seeded.revision, decision: 'approved-for-new-run', receipt: first.json() }] },
    })
    const replay = await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload })
    expect(replay.json()).toEqual(first.json())
  })
})
