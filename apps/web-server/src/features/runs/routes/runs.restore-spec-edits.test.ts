// POST /api/runs/:runId/restore-spec-edits — the human-only lever that puts the
// live specs back to what the run executed (D9). HTTP only, beside adopt: no
// MCP tool wraps it, which `mcp/repair-guardrail.test.ts` pins.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes } from './runs'
import { createRegistry, RunStore, type OrchestratorLike } from '../logic/run-store'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-restore-')))
  fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'features'), { recursive: true })
})

async function build() {
  const registry = createRegistry()
  const store = new RunStore(path.join(tmpDir, 'logs'), registry)
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir: path.join(tmpDir, 'features'),
    store,
    startRun: async () => { throw new Error('not configured') },
  })
  return { app, registry }
}

function stub(restore: OrchestratorLike['restoreSpecEdits']): OrchestratorLike {
  return {
    runId: 'r1',
    stop: async () => {},
    pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
    cancelHeal: async () => ({ ok: true }),
    restoreSpecEdits: restore,
  }
}

describe('POST /api/runs/:runId/restore-spec-edits', () => {
  it('404s for a run that is not active — there is no copy to restore from', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/restore-spec-edits' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/not active/)
  })

  it('200s with the restored files', async () => {
    const { app, registry } = await build()
    registry.set('r1', stub(() => ({ ok: true, restored: ['e2e/a.spec.ts'] })))
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/restore-spec-edits' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'restored', restored: ['e2e/a.spec.ts'] })
  })

  it.each(['tests-running', 'nothing-to-restore', 'restore-failed'] as const)('409s with reason=%s', async (reason) => {
    const { app, registry } = await build()
    registry.set('r1', stub(() => ({ ok: false, reason })))
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/restore-spec-edits' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })
})
