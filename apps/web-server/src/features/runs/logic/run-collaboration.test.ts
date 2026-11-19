import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { initGitRepo } from '../../../../../../tools/test-helpers/git-repo'
import { demoFeature } from '../../../../../../tools/test-helpers/feature-fixture'
import { makeFakePtyFactory } from '../../../../../../tools/test-helpers/fake-pty'
import { runDirFor } from './runtime/run-paths'
import { RunStore } from './run-store'
import { createRegistry } from './run-registry'
import { createRunContext } from './runtime/run-context'
import { prepareRunForExecution } from './runtime/run-setup'
import { stopHeartbeat } from './runtime/run-manifest-writer'
import { runPlaywright } from './runtime/run-playwright'
import { acceptRunReview } from './run-review-service'
import { continueRun, validateContinuation } from './run-lifecycle-service'
import { readRunHistory } from './run-history'
import { readExecutionEvidence } from './runtime/run-execution-evidence'
import { readRunsIndex, writeRunsIndex } from './runtime/manifest'

const tempDir = trackTempDirs('cl-collaboration-')
const before = "test('example', () => expect(reply.status).toBe(201))\n"
const after = "test('example', () => expect(reply.data.status).toBe(201))\n"

async function fixture() {
  const root = tempDir()
  const feature = demoFeature(root, { repos: [] })
  fs.mkdirSync(path.join(feature.featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(feature.featureDir, 'feature.config.cjs'), "module.exports = { name: 'demo' }\n")
  fs.writeFileSync(path.join(feature.featureDir, 'e2e/example.spec.ts'), before)
  initGitRepo(feature.featureDir)
  const logsDir = path.join(root, 'logs')
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const { factory, spawned } = makeFakePtyFactory()
  const selections: unknown[] = []
  const ctx = createRunContext({ feature, runId: 'run-a', runDir: runDirFor(logsDir, 'run-a'), env: 'local',
    runStateSink: store, ptyFactory: factory,
    playwrightSpawner: (options) => { selections.push(options.rerunSelection); return { command: 'fixture', cwd: options.suiteDir } },
  }, () => true)
  await prepareRunForExecution(ctx, 'starting', false)
  stopHeartbeat(ctx)
  if (ctx.signalWatcher) { clearInterval(ctx.signalWatcher); ctx.signalWatcher = null }
  async function execute(exitCode: number, summary: object) {
    const pending = runPlaywright(ctx, ['e2e/example.spec.ts:1'])
    fs.writeFileSync(ctx.paths.summaryPath, JSON.stringify(summary))
    spawned.at(-1)!.emitData(`attempt ${exitCode}\n`)
    spawned.at(-1)!.emitExit(exitCode)
    await pending
    store.setStatus(ctx.runId, exitCode ? 'failed' : 'passed', 0)
  }
  await execute(1, { total: 1, passed: 0, failed: 1, tests: [] })
  const edit = () => fs.writeFileSync(path.join(feature.featureDir, 'e2e/example.spec.ts'), after)
  return { root, ctx, store, registry, execute, selections, edit }
}

describe('shared run collaboration', () => {
  it('accepts without executing, then continues the same run with fresh full-suite evidence', async () => {
    const { ctx, store, edit, execute, selections } = await fixture()
    const original = store.get(ctx.runId)!
    const version = original.executions![0].sourceVersion!
    edit()
    const revision = store.get(ctx.runId)!.collaboration!.review.revision!
    const receipts = await Promise.all([acceptRunReview({ store }, ctx.runId, revision), acceptRunReview({ store }, ctx.runId, revision)])
    expect(receipts[0]).toEqual(receipts[1])
    expect(receipts[0].execution.status).toBe('continuation-ready')
    const accepted = store.get(ctx.runId)!
    expect(accepted.manifest.status).toBe('failed')
    expect(accepted.summary).toEqual(original.summary)
    expect(accepted.collaboration).toMatchObject({ review: { state: 'accepted', changedFiles: 1 }, continuation: { available: true } })
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/example.spec.ts'), 'utf8')).toBe(before)
    await continueRun(store, ctx.runId, async () => {
      await prepareRunForExecution(ctx, 'starting', true)
      stopHeartbeat(ctx)
      if (ctx.signalWatcher) { clearInterval(ctx.signalWatcher); ctx.signalWatcher = null }
      expect(fs.existsSync(ctx.paths.summaryPath)).toBe(false)
      await execute(0, { total: 1, passed: 1, failed: 0, tests: [] })
      return 'continued'
    }, () => 'attached')
    expect(selections.at(-1)).toBeUndefined()
    const evidence = readExecutionEvidence(ctx.runDir)
    expect(evidence.map((e) => e.exitCode)).toEqual([1, 0])
    expect(evidence[1].sourceVersion).not.toBe(version)
    expect(fs.readFileSync(path.join(ctx.runDir, 'history/sources', version, 'e2e/example.spec.ts'), 'utf8')).toBe(before)
    expect(JSON.parse(fs.readFileSync(path.join(ctx.runDir, evidence[0].summaryPath!), 'utf8')).failed).toBe(1)
    expect(store.get(ctx.runId)!.manifest.status).toBe('passed')
    expect(readRunHistory(store, ctx.runId)[0].journal.map((e) => e.outcome)).toEqual(['accepted-awaiting-execution', 'continuation-requested'])
  })

  it('rejects later edits before launch and preserves the ended manifest on failed setup', async () => {
    const { ctx, store, edit } = await fixture()
    edit()
    await acceptRunReview({ store }, ctx.runId, store.get(ctx.runId)!.collaboration!.review.revision!)
    fs.appendFileSync(path.join(ctx.feature.featureDir, 'e2e/example.spec.ts'), '// later\n')
    const launch = vi.fn()
    await expect(continueRun(store, ctx.runId, launch, () => undefined)).rejects.toThrow('test-review-required')
    expect(launch).not.toHaveBeenCalled()
    await expect(prepareRunForExecution(ctx, 'starting', true)).rejects.toThrow('review the latest source')
    expect(store.get(ctx.runId)!.manifest.status).toBe('failed')
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/example.spec.ts'), 'utf8')).toBe(before)
  })

  it('does not execute twice when simultaneous continuations finish before the second acquires the lock', async () => {
    const { ctx, store, execute } = await fixture()
    const launch = vi.fn(async () => { await execute(1, { total: 1, failed: 1 }); return 'continued' })
    const results = await Promise.allSettled([
      continueRun(store, ctx.runId, launch, () => 'attached'),
      continueRun(store, ctx.runId, launch, () => 'attached'),
    ])
    expect(launch).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(store.get(ctx.runId)!.manifest.playwrightExecutions).toBe(2)
  })

  it('validates explicit successor links and aggregates records without copying journals', async () => {
    const { store, ctx } = await fixture()
    const first = store.get(ctx.runId)!.manifest
    store.bootstrap({ ...first, runId: 'run-b', continuationOf: ctx.runId, startedAt: 'later' })
    expect(validateContinuation(store, ctx.runId, 'demo', 'local')?.runId).toBe(ctx.runId)
    expect(() => validateContinuation(store, 'run-b', 'demo', 'local', ctx.runId)).toThrow('cycle')
    expect(() => validateContinuation(store, ctx.runId, 'demo', 'other')).toThrow('same suite and environment')
    expect(() => validateContinuation(store, '../run-a', 'demo', 'local')).toThrow('Invalid')
    expect(readRunHistory(store, 'run-b').map((r) => r.runId)).toEqual([ctx.runId, 'run-b'])
    expect(readRunHistory(store, 'run-b')[1].executions).toEqual([])
  })

  it('honors a declared spent allowance and keeps its receipt when linking a successor', async () => {
    const { ctx, store, edit } = await fixture()
    store.patchManifest(ctx.runId, { singleAttempt: { receipt: 'attempt.json' } })
    fs.writeFileSync(path.join(ctx.runDir, 'attempt.json'), '{"claimed":true}')
    edit()
    const receipt = await acceptRunReview({ store }, ctx.runId, store.get(ctx.runId)!.collaboration!.review.revision!)
    expect(receipt.execution.status).toBe('new-run-required')
    const launch = vi.fn()
    await expect(continueRun(store, ctx.runId, launch, () => undefined)).rejects.toThrow('one external-effect attempt')
    expect(launch).not.toHaveBeenCalled()
    expect(validateContinuation(store, ctx.runId, 'demo', 'local')?.runId).toBe(ctx.runId)
    expect(fs.readFileSync(path.join(ctx.runDir, 'attempt.json'), 'utf8')).toBe('{"claimed":true}')
  })

  it('checks another agent owner inside the serialization boundary before launching', async () => {
    const { ctx, store } = await fixture()
    const launch = vi.fn()
    const owner = { sessionId: 'owner', clientKind: 'claude' as const, claimedAt: 'now', lastHeartbeatAt: 'now', status: 'connected' as const, cycleCount: 0 }
    await expect(continueRun(store, ctx.runId, launch, () => undefined, undefined, { sessionId: 'competitor', current: () => owner })).rejects.toThrow('already-claimed')
    expect(launch).not.toHaveBeenCalled()
    expect(store.get(ctx.runId)!.manifest.status).toBe('failed')
  })

  it('reports the same collision block to readers and continuation even with a stale index', async () => {
    const { ctx, store } = await fixture()
    store.bootstrap({ ...store.get(ctx.runId)!.manifest, runId: 'busy-run', status: 'running' })
    writeRunsIndex(store.logsDir, readRunsIndex(store.logsDir).map((row) => ({ ...row, status: 'failed' })))
    expect(store.get(ctx.runId)!.collaboration?.continuation).toMatchObject({ available: false, reason: 'execution-context-busy' })
    const launch = vi.fn()
    await expect(continueRun(store, ctx.runId, launch, () => undefined)).rejects.toThrow('Another run owns')
    expect(launch).not.toHaveBeenCalled()
    store.setStatus('busy-run', 'passed')
    expect(store.get(ctx.runId)!.collaboration?.continuation.available).toBe(true)
  })

  it('does not treat a missing live suite config as an approvable deletion', async () => {
    const { ctx, store } = await fixture()
    fs.rmSync(path.join(ctx.feature.featureDir, 'feature.config.cjs'))
    expect(store.get(ctx.runId)!.collaboration).toMatchObject({ review: { state: 'unavailable' }, continuation: { available: false, reason: 'source-unavailable' } })
    await expect(continueRun(store, ctx.runId, vi.fn(), () => undefined)).rejects.toThrow('source-unavailable')
  })

  it('recovers accepted state from disk without treating an old receipt as an automatic start', async () => {
    const { ctx, store, edit } = await fixture()
    edit()
    const revision = store.get(ctx.runId)!.collaboration!.review.revision!
    await acceptRunReview({ store }, ctx.runId, revision)
    const restarted = new RunStore(store.logsDir, createRegistry())
    expect(restarted.get(ctx.runId)!.collaboration).toEqual(store.get(ctx.runId)!.collaboration)
    expect(restarted.get(ctx.runId)!.manifest.playwrightExecutions).toBe(1)
    expect(restarted.registry.get(ctx.runId)).toBeUndefined()
  })


  it('excludes runtime secrets from retained source and does not overwrite earlier output', async () => {
    const { ctx, execute } = await fixture()
    const first = readExecutionEvidence(ctx.runDir)[0]
    fs.writeFileSync(path.join(ctx.suiteDir, '.env'), 'TOKEN=fixture-secret')
    await execute(1, { total: 1, failed: 1 })
    const second = readExecutionEvidence(ctx.runDir)[1]
    expect(fs.existsSync(path.join(ctx.runDir, 'history/sources', second.sourceVersion!, '.env'))).toBe(false)
    expect(fs.readFileSync(path.join(ctx.runDir, first.outputPath), 'utf8')).toBe('attempt 1\n')
    expect(first.targets).toEqual(['e2e/example.spec.ts:1'])
  })

})
