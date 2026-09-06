// POST /api/runs/:runId/adopt-spec-edits — the human-only lever that lets a
// mid-run spec edit into a run (D9/D13). HTTP only, beside /approve-dirty: no
// MCP tool wraps it, which `mcp/repair-guardrail.test.ts` pins.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes } from './runs'
import { createRegistry, RunStore, type OrchestratorLike } from '../logic/run-store'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

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
  return { app, registry }
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

  it.each(['tests-running', 'nothing-to-adopt', 'snapshot-failed'] as const)('409s with reason=%s', async (reason) => {
    const { app, registry } = await build()
    registry.set('r1', stub(async () => ({ ok: false, reason })))
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/adopt-spec-edits' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })
})
