import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startPlanFeatures, PlanFeaturesStore } from './plan-features'

// The interesting seam here is the `deps.spawnAgent ?? defaultSpawnAgent`
// fallback in runPlanAgent: every other caller injects a stub spawner, so the
// production default (a real `claude` spawn) is only reached when spawnAgent is
// omitted. We exercise it with a fake `claude` binary (CANARY_LAB_CLAUDE_BIN)
// that emits the stream-json result envelope the default spawner expects.
describe('plan-features default spawner fallback', () => {
  let tmpDir: string
  let prevBin: string | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-feat-'))
    prevBin = process.env.CANARY_LAB_CLAUDE_BIN
  })

  afterEach(() => {
    if (prevBin === undefined) delete process.env.CANARY_LAB_CLAUDE_BIN
    else process.env.CANARY_LAB_CLAUDE_BIN = prevBin
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses defaultSpawnAgent when deps.spawnAgent is not injected', async () => {
    const repo = path.join(tmpDir, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })

    // The fake binary's stream-json `result` is the plan JSON the agent would
    // return; extractJson + normalizePlanResult then turn it into features.
    const planJson = JSON.stringify({
      features: [{ name: 'checkout flow', description: 'buy some stuff' }],
    })
    const envelope = JSON.stringify({ type: 'result', result: planJson })
    const b64 = Buffer.from(envelope, 'utf-8').toString('base64')
    const script = path.join(tmpDir, 'fake-claude.sh')
    fs.writeFileSync(script, `#!/bin/sh\necho '${b64}' | base64 -d\n`)
    fs.chmodSync(script, 0o755)
    process.env.CANARY_LAB_CLAUDE_BIN = script

    const store = new PlanFeaturesStore(logsDir)
    // deps WITHOUT spawnAgent → the `?? defaultSpawnAgent` fallback runs.
    const task = startPlanFeatures(
      { repoPaths: [repo], description: 'plan the work' },
      store,
      { logsDir },
    )
    expect(task.status).toBe('running')

    // runPlanAgent is fired detached — poll the record until it settles.
    const deadline = Date.now() + 15_000
    let settled = store.get(task.taskId)
    while (settled && settled.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
      settled = store.get(task.taskId)
    }

    expect(settled?.status).toBe('done')
    expect(settled?.result?.features).toEqual([
      { name: 'checkout-flow', description: 'buy some stuff' },
    ])
  })
})

// `PlanFeaturesStore` forwards both halves of the listener API so the workspace
// bridge can attach to it (see flight-route-context). Only `onEvent` is wired in
// production today — the pre-flight list has no WebSocket stream of its own — so
// nothing exercised the unsubscribe half, and a forward that silently dropped
// the call would look identical until the first stream was added.
describe('PlanFeaturesStore listener forwarding', () => {
  let dir: string

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-feat-ev-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const task = (taskId: string) => ({
    taskId,
    repoPaths: ['/repo/shop'],
    description: 'plan the shop',
    status: 'running' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })

  it('stops delivering once a listener unsubscribes', () => {
    const store = new PlanFeaturesStore(dir)
    const seen: string[] = []
    const listener = (e: { kind: string }): void => { seen.push(e.kind) }

    store.onEvent(listener)
    store.save(task('pf-1'))
    expect(seen).toEqual(['changed'])

    store.offEvent(listener)
    store.save(task('pf-2'))
    expect(seen).toEqual(['changed'])
  })
})
