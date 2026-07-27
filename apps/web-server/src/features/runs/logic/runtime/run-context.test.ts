import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRunContext } from './run-context'
import type { OrchestratorOptions } from './run-orchestrator-types'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'

// The defaults live here rather than in the orchestrator's constructor, which is
// what makes them testable at all: every orchestrator test injects a fake delay,
// spawner and health probe, so before the split nothing ever ran the real ones.

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ctx-')))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function opts(over: Partial<OrchestratorOptions> = {}): OrchestratorOptions {
  const feature: FeatureConfig = {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [],
  }
  return {
    feature,
    runId: '2026-01-01T0000-ctx0',
    runDir: path.join(tmpDir, 'logs', 'runs', '2026-01-01T0000-ctx0'),
    ptyFactory: () => { throw new Error('not spawned in this test') },
    ...over,
  } as OrchestratorOptions
}

describe('createRunContext', () => {
  it('defaults the delay to a real timer that resolves after the requested wait', async () => {
    const ctx = createRunContext(opts(), () => true)
    const before = Date.now()
    await ctx.delay(12)
    expect(Date.now() - before).toBeGreaterThanOrEqual(8)
  })

  it('keeps an injected delay instead of the real timer', async () => {
    const seen: number[] = []
    const ctx = createRunContext(opts({ delay: async (ms) => { seen.push(ms) } }), () => true)
    await ctx.delay(5000)
    expect(seen).toEqual([5000])
  })

  it('seeds the run state a fresh run starts from', () => {
    const ctx = createRunContext(opts(), () => true)
    expect(ctx.status).toBe('running')
    expect(ctx.healCycles).toBe(0)
    expect(ctx.stopped).toBe(false)
    expect(ctx.healAgentPty).toBeNull()
    expect(ctx.servicePtys.size).toBe(0)
    expect(ctx.appliedOverlays).toEqual([])
  })

  it('carries initialHealCycles in, so a restarted run keeps counting', () => {
    const ctx = createRunContext(opts({ initialHealCycles: 3 }), () => true)
    expect(ctx.healCycles).toBe(3)
  })

  it('derives the logs root two levels above the run dir', () => {
    const ctx = createRunContext(opts(), () => true)
    expect(ctx.logsRoot).toBe(path.join(tmpDir, 'logs'))
  })

  it('indexes worktree handles by repo name so specs resolve to the worktree path', () => {
    const ctx = createRunContext(
      opts({ worktrees: [{ repoName: 'api', localPath: '/wt/api' }] as OrchestratorOptions['worktrees'] }),
      () => true,
    )
    expect(ctx.repoPathOverrides).toEqual({ api: '/wt/api' })
    expect(ctx.worktreeHandles).toHaveLength(1)
  })

  it('falls back to the health poll interval for the signal poll when none is given', () => {
    expect(createRunContext(opts({ healthPollIntervalMs: 250 }), () => true).healSignalPollMs).toBe(250)
    expect(
      createRunContext(opts({ healthPollIntervalMs: 250, healSignalPollMs: 40 }), () => true).healSignalPollMs,
    ).toBe(40)
  })

  it('routes emit through the handle it was constructed with', () => {
    const seen: string[] = []
    const ctx = createRunContext(opts(), (event) => { seen.push(event); return true })
    ctx.emit('run-status', { status: 'running' })
    expect(seen).toEqual(['run-status'])
  })
})
