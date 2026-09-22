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
  it('keeps historical decision records distinct from the accepted receipt they do not carry', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const manifestPath = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(manifestPath)!

    writeManifest(manifestPath, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{ at: 'now', revision: seeded.revision, decision: 'approved-for-new-run' }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({
      reason: 'review-already-settled',
    })

    writeManifest(manifestPath, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{
        at: 'now', revision: seeded.revision, decision: 'restored', receipt: {
          decision: 'restored', review_revision: seeded.revision, files: [], at: 'now',
          git: { status: 'not-requested' }, execution: { status: 'none' },
        },
      }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({
      reason: 'review-decision-conflict',
    })
  })

  it('commits an active review only when its orchestrator accepts the copied bytes', async () => {
    const { app, registry } = await build()
    const rejected = terminalReview('passed')
    registry.set('terminal', stub(async () => ({ ok: false, reason: 'review-changed' })))

    const rejectedResponse = await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: rejected.revision } })
    expect(rejectedResponse.statusCode).toBe(409)
    expect(rejectedResponse.json()).toMatchObject({ reason: 'review-changed', git: { status: 'committed' } })

    fs.rmSync(rejected.runDir, { recursive: true, force: true })
    const accepted = terminalReview('passed')
    registry.set('terminal', stub(async () => ({ ok: true, adopted: ['e2e/a.spec.ts'], rerun: 'signalled' })))
    const acceptedResponse = await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: accepted.revision } })
    expect(acceptedResponse.statusCode).toBe(202)
    expect(acceptedResponse.json()).toMatchObject({ decision: 'accepted', execution: { status: 'rerun-requested' } })
  })

  it('writes a terminal approval even when an older run never recorded dirty-spec state', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const manifestPath = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(manifestPath)!
    writeManifest(manifestPath, { ...manifest, specEdits: undefined })

    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: seeded.revision } })).statusCode).toBe(202)
    expect(readManifest(manifestPath)?.specEdits).toMatchObject({ pending: [], adopted: [] })
  })

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

  it('requires a live terminal snapshot, the exact current revision, and remaining reviewed files', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const pathToManifest = path.join(seeded.runDir, 'manifest.json')

    expect((await app.inject({ method: 'POST', url: '/api/runs/ghost/accept-test-review', payload: { expectedRevision: seeded.revision } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: 'invalid' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: 'b'.repeat(64) } })).json()).toMatchObject({ reason: 'review-changed' })

    fs.writeFileSync(path.join(seeded.featureDir, 'e2e/a.spec.ts'), 'recorded\n')
    const empty = suiteReviewRevision(seeded.snapshot, seeded.featureDir)
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: empty } })).json()).toMatchObject({ reason: 'nothing-to-accept' })

    fs.writeFileSync(path.join(seeded.featureDir, 'e2e/a.spec.ts'), 'candidate\n')
    const current = suiteReviewRevision(seeded.snapshot, seeded.featureDir)
    const manifest = readManifest(pathToManifest)!
    writeManifest(pathToManifest, { ...manifest, status: 'healing' })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: current } })).json()).toMatchObject({ error: expect.stringContaining('not ready') })

    writeManifest(pathToManifest, {
      ...manifest,
      suiteSnapshot: { kind: 'unavailable', at: 'now', reason: 'copy failed' },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: current } })).json()).toMatchObject({ error: 'Run snapshot unavailable' })
  })

  it('surfaces a Git commit rejection and refuses a source change made during commit', async () => {
    const { app } = await build()
    const rejected = terminalReview('passed')
    const hook = path.join(rejected.featureDir, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const failed = await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: rejected.revision } })
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toMatchObject({ error: expect.stringContaining('Git could not commit') })

    fs.rmSync(rejected.runDir, { recursive: true, force: true })
    const changed = terminalReview('passed')
    fs.writeFileSync(path.join(changed.featureDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf "// late edit\\n" >> e2e/a.spec.ts\n', { mode: 0o755 })
    const result = await app.inject({ method: 'POST', url: '/api/runs/terminal/accept-test-review', payload: { expectedRevision: changed.revision } })
    expect(result.statusCode).toBe(409)
    expect(result.json()).toMatchObject({ reason: 'review-changed', git: { status: 'committed' } })
  })
})

describe('terminal review idempotency and validation', () => {
  it('handles historical terminal manifests with absent review fields and every unavailable review state', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const manifestPath = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(manifestPath)!

    writeManifest(manifestPath, { ...manifest, specEdits: undefined })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: seeded.revision } })).statusCode).toBe(202)

    fs.rmSync(seeded.runDir, { recursive: true, force: true })
    const empty = terminalReview('passed')
    fs.writeFileSync(path.join(empty.featureDir, 'e2e/a.spec.ts'), 'recorded\n')
    const emptyRevision = suiteReviewRevision(empty.snapshot, empty.featureDir)
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: emptyRevision } })).json()).toMatchObject({ reason: 'nothing-to-adopt' })

    const emptyManifest = readManifest(path.join(empty.runDir, 'manifest.json'))!
    writeManifest(path.join(empty.runDir, 'manifest.json'), { ...emptyManifest, featureDir: undefined })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: emptyRevision } })).json()).toMatchObject({ error: 'Run snapshot unavailable' })
  })

  it('restores historical terminal records and rejects terminal states that cannot be reviewed', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const manifestPath = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(manifestPath)!
    writeManifest(manifestPath, { ...manifest, specEdits: undefined })

    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: seeded.revision } })).statusCode).toBe(200)
    expect(readManifest(manifestPath)?.specEdits).toMatchObject({ adopted: [] })

    fs.rmSync(seeded.runDir, { recursive: true, force: true })
    const healing = terminalReview('passed')
    const healingManifest = readManifest(path.join(healing.runDir, 'manifest.json'))!
    writeManifest(path.join(healing.runDir, 'manifest.json'), { ...healingManifest, status: 'healing' })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: healing.revision } })).json()).toMatchObject({ error: expect.stringContaining('not available') })
    writeManifest(path.join(healing.runDir, 'manifest.json'), { ...healingManifest, featureDir: undefined })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: healing.revision } })).json()).toMatchObject({ error: 'Run snapshot unavailable' })

    writeManifest(path.join(healing.runDir, 'manifest.json'), { ...healingManifest })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: 'invalid' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: 'b'.repeat(64) } })).json()).toMatchObject({ reason: 'review-changed' })
  })

  it('returns a persisted restored receipt and refuses a different settled receipt', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const manifestPath = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(manifestPath)!
    const restored = {
      decision: 'restored' as const, review_revision: seeded.revision, files: [], at: 'now',
      git: { status: 'not-requested' as const }, execution: { status: 'none' as const },
    }
    writeManifest(manifestPath, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{ at: 'now', revision: seeded.revision, decision: 'restored', receipt: restored }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: seeded.revision } })).json()).toEqual(restored)

    writeManifest(manifestPath, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{ at: 'now', revision: seeded.revision, decision: 'approved-for-new-run', receipt: { ...restored, decision: 'accepted' } }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({ reason: 'review-decision-conflict' })
  })

  it('keeps incompatible pre-existing terminal decisions distinct from the matching decision', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const pathToManifest = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(pathToManifest)!

    writeManifest(pathToManifest, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{ at: 'now', revision: seeded.revision, decision: 'restored' }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({ reason: 'review-decision-conflict' })

    writeManifest(pathToManifest, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{ at: 'now', revision: seeded.revision, decision: 'adopted' }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({ reason: 'review-decision-conflict' })

    writeManifest(pathToManifest, {
      ...manifest,
      specEdits: { ...manifest.specEdits!, reviewDecisions: [{ at: 'now', revision: seeded.revision, decision: 'restored' }] },
    })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/restore-spec-edits', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({
      status: 'restored', restored: [], review_revision: seeded.revision, idempotent: true,
    })
  })

  it('does not permit terminal adoption while still running or without exact approval input', async () => {
    const { app } = await build()
    const seeded = terminalReview('passed')
    const manifestPath = path.join(seeded.runDir, 'manifest.json')
    const manifest = readManifest(manifestPath)!

    writeManifest(manifestPath, { ...manifest, status: 'healing' })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: seeded.revision } })).json()).toMatchObject({ error: expect.stringContaining('not available') })
    writeManifest(manifestPath, { ...manifest })
    expect((await app.inject({ method: 'POST', url: '/api/runs/terminal/adopt-spec-edits', payload: { expectedRevision: 'invalid' } })).statusCode).toBe(400)
  })
})
