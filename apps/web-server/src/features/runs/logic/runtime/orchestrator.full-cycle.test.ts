import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory } from './pty-spawner'
import { runDirFor } from './run-paths'
import { readManifest } from './manifest'
import { makeFakePtyFactory } from '../../../../../../../tools/test-helpers/fake-pty'
import { demoFeature } from '../../../../../../../tools/test-helpers/feature-fixture'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-orc-')
let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = tempDir()
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RunOrchestrator.runFullCycle', () => {
  function bootForFullCycle(opts: {
    spawned: { factory: PtyFactory; spawned: ReturnType<typeof makeFakePtyFactory>['spawned'] }
    pwExitCodes: number[]
    autoHeal?: boolean
    manualHeal?: boolean
    externalHeal?: boolean
  }) {
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: opts.spawned.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: ({ rerunTargets }) => {
        return {
          command: `pw-${pwIdx++}${rerunTargets?.length ? ` ${rerunTargets.join(' ')}` : ''}`,
          cwd: tmpDir,
        }
      },
      autoHeal: opts.autoHeal
        ? {
            agent: 'claude',
            maxCycles: 2,
            buildSpawnCommand: () => `heal-${healIdx++}`,
          }
        : undefined,
      manualHeal: opts.manualHeal,
      externalHeal: opts.externalHeal,
    })
    return orch
  }

  it('returns passed when Playwright exits 0 on first try', async () => {
    const f = makeFakePtyFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [0] })
    const promise = orch.runFullCycle()
    // service pty is f.spawned[0]; playwright is next.
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    await orch.stop('passed')
  })

  it('declares failed (no heal) when a service never boots — Playwright never runs', async () => {
    const f = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => false,
      delay: async () => undefined,
      healthDeadlineMs: 5,
      healthPollIntervalMs: 1,
      playwrightSpawner: () => {
        throw new Error('Playwright must not run when a service fails to boot')
      },
    })
    const status = await orch.runFullCycle()
    expect(status).toBe('failed')
    // Only the service pty — no Playwright pty was ever spawned.
    expect(f.spawned).toHaveLength(1)
    expect(readManifest(orch.paths.manifestPath)?.bootFailure).toMatchObject({
      service: 'api',
      reason: 'health-timeout',
    })
    await orch.stop('failed')
  })

  it('fails a passing partial suite when a ready service exits during Playwright', async () => {
    const f = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      playwrightSpawner: () => ({ command: 'playwright test', cwd: tmpDir }),
    })
    const running = orch.runFullCycle()
    while (f.spawned.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      total: 1,
      passed: 1,
      passedNames: ['passes'],
      knownTests: [{ name: 'passes', title: 'passes', location: 'tests/demo.spec.ts:1' }],
    }))

    f.spawned[0].emitExit(0)
    expect(f.spawned[1].killed).toBe('SIGTERM')
    f.spawned[1].emitExit(0)

    expect(await running).toBe('failed')
    expect(readManifest(orch.paths.manifestPath)?.serviceFailure).toMatchObject({
      service: 'api', kind: 'process-exited', exitCode: 0,
    })
    await orch.stop('failed')
  })

  it('stops instead of re-running forever when only skipped tests remain (auto-heal)', async () => {
    // Regression: a run that ends 6-passed / 1-skipped / 0-failed is treated as
    // 'failed' (a skipped test is not verified), so auto-heal enters the
    // failedSlugs===0 "pending" branch. That branch re-runs the not-yet-passed
    // tests with NO heal agent — but a `test.skip(cond)` re-runs to the same
    // skipped result every time, so the branch used to loop forever (the
    // symptom the user saw: "Targeted rerun selected → exit 0 → Run failed",
    // repeating every ~1s). The no-progress guard must terminate the run after
    // a rerun that doesn't change the not-yet-passed set.
    const f = makeFakePtyFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passed: 1,
      passedNames: ['test-case-passes'],
      skipped: 1,
      skippedNames: ['test-case-skipped'],
      total: 2,
      knownTests: [
        { name: 'test-case-passes', title: 'passes', location: 'tests/demo.spec.ts:3' },
        { name: 'test-case-skipped', title: 'skipped', location: 'tests/demo.spec.ts:7' },
      ],
    }))

    const promise = orch.runFullCycle()
    // [0]=service, [1]=initial playwright run.
    while (f.spawned.length < 2) await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(0)
    // The pending branch performs exactly ONE rerun ([2]) before detecting that
    // the not-yet-passed set is unchanged and stopping.
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0)

    const status = await promise
    expect(status).toBe('failed')
    // No third rerun ([3]) — the loop terminated rather than spinning.
    expect(f.spawned).toHaveLength(3)
    await orch.stop('failed')
  })
})
