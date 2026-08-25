import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'

interface FakeProcess {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  killed: string | null
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  emitData(chunk: string): void
  emitExit(code: number, signal?: number): void
}

function makeFakeFactory(): { factory: PtyFactory; spawned: FakeProcess[] } {
  const spawned: FakeProcess[] = []
  let nextPid = 100
  const factory: PtyFactory = (options): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const proc: FakeProcess = {
      pid: nextPid++,
      options,
      data,
      exit,
      killed: null,
      writes: [],
      resizes: [],
      emitData(chunk) { data.emit('data', chunk) },
      emitExit(code, signal) { exit.emit('exit', { exitCode: code, signal }) },
    }
    spawned.push(proc)
    return {
      get pid() { return proc.pid },
      onData: (cb) => {
        data.on('data', cb)
        return { dispose: () => data.off('data', cb) }
      },
      onExit: (cb) => {
        exit.on('exit', cb)
        return { dispose: () => exit.off('exit', cb) }
      },
      write: vi.fn((data: string) => { proc.writes.push(data) }),
      resize: vi.fn((cols: number, rows: number) => {
        proc.resizes.push({ cols, rows })
      }),
      kill: (signal) => { proc.killed = signal ?? 'SIGTERM' },
    }
  }
  return { factory, spawned }
}

let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: tmpDir,
        startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
    ...over,
  }
}

describe('RunOrchestrator.runHealAgent', () => {
  it('throws when auto-heal is not configured', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      delay: async () => undefined,
    })
    await expect(orch.runHealAgent({ cycle: 1, failedSlugs: [] })).rejects.toThrow(/autoHeal/)
  })

  it('submits a real prompt message to the live REPL on cycle 2+', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1, repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      autoHeal: {
        agent: 'claude',
        buildSpawnCommand: ({ promptFile }) => `claude -- ${JSON.stringify(`@${promptFile}`)}`,
        buildCyclePrompt: () => 'cycle prompt',
      },
    })
    await orch.start()

    const first = orch.runHealAgent({ cycle: 1, failedSlugs: ['a'] })
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '{}')
    expect(await first).toMatchObject({ reason: 'signal', signal: { kind: 'rerun' } })

    const agent = f.spawned[0]
    const beforeWrites = agent.writes.length
    const second = orch.runHealAgent({ cycle: 2, failedSlugs: ['a'] })
    while (agent.writes.length === beforeWrites) await new Promise((r) => setTimeout(r, 5))

    const cyclePromptWrite = agent.writes.slice(beforeWrites).join('')
    const promptPath = path.join(runDir, 'heal-prompt.md')
    expect(cyclePromptWrite).toContain('\x1b[200~')
    expect(cyclePromptWrite).toContain(`Read ${promptPath} and continue the auto-heal cycle now.`)
    expect(cyclePromptWrite).toContain('\x1b[201~\r')
    expect(cyclePromptWrite).not.toContain(`@${promptPath}`)

    fs.writeFileSync(orch.paths.rerunSignal, '{}')
    expect(await second).toMatchObject({ reason: 'signal', signal: { kind: 'rerun' } })
    await orch.stop('failed')
  })

  it('passes the project root to the Codex spawn builder for scoped trust', async () => {
    const f = makeFakeFactory()
    let workspaceRoot: string | undefined
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1, repos: [] }),
      projectRoot: tmpDir,
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      autoHeal: {
        agent: 'codex',
        buildSpawnCommand: (args) => {
          workspaceRoot = args.workspaceRoot
          return 'codex'
        },
        buildCyclePrompt: () => 'cycle prompt',
      },
    })
    await orch.start()

    const heal = orch.runHealAgent({ cycle: 1, failedSlugs: ['a'] })
    while (f.spawned.length < 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(workspaceRoot).toBe(tmpDir)

    fs.writeFileSync(orch.paths.rerunSignal, '{}')
    expect(await heal).toMatchObject({ reason: 'signal', signal: { kind: 'rerun' } })
    await orch.stop('failed')
  })
})

describe('readSummary / extractFailedSlugs / defaultPlaywrightSpawner / defaultSpawnCommand / defaultHealPrompt', () => {
  it('readSummary tolerates missing file', async () => {
    const { defaultPlaywrightSpawner, defaultSpawnCommand } = await import('./run-spawn')
    const { defaultHealPrompt } = await import('./heal-agent-text')
    const { readSummary, extractFailedSlugs, extractFailedLocations } = await import('./run-verdict')
    expect(readSummary(path.join(tmpDir, 'nope.json'))).toEqual({})
    expect(extractFailedSlugs({ failed: [{ name: 'a' }, { name: '' }, {}] })).toEqual(['a'])
    expect(extractFailedSlugs({})).toEqual([])
    expect(extractFailedLocations({
      failed: [
        { name: 'a', location: 'e2e/a.spec.ts:10' },
        { name: 'b', location: 'e2e/a.spec.ts:10' },
        { name: 'c', location: 'not-a-playwright-location' },
      ],
    })).toEqual(['e2e/a.spec.ts:10'])
    const f = makeFeature()
    const inv = defaultPlaywrightSpawner({ feature: f, paths: buildRunPaths(runDir) })
    expect(inv.command).toContain('playwright test')
    expect(inv.command).toContain(`--output=${JSON.stringify(path.join(runDir, 'playwright-artifacts'))}`)
    expect(inv.cwd).toBe(f.featureDir)
    const targeted = defaultPlaywrightSpawner({
      feature: f,
      paths: buildRunPaths(runDir),
      rerunTargets: ['e2e/a.spec.ts:10', 'e2e/b spec.ts:20'],
    })
    expect(targeted.command).toContain(`${JSON.stringify('e2e/a.spec.ts:10')} ${JSON.stringify('e2e/b spec.ts:20')}`)
    // The default spawn keeps the pty alive (via `cat`) so tests can write
    // prompts to its stdin without the REPL exiting underneath them.
    expect(defaultSpawnCommand({})).toBe('cat')
    expect(defaultHealPrompt({ cycle: 2, outputDir: '/x' })).toContain('cycle=2')
  })
})

describe('computeNonPassedTargets', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('returns failed + pending tests, skipping the ones already passed', async () => {
    const { computeNonPassedTargets } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a happy path', async () => {})\n" +
      "test('b sad path', async () => {})\n",
    )
    const specB = writeSpec(featureDir, 'b.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('c never ran', async () => {})\n",
    )

    const result = computeNonPassedTargets(featureDir, {
      passedNames: ['test-case-a-happy-path'],
      failed: [{ name: 'test-case-b-sad-path', location: `${specA}:3` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.total).toBe(3)
    // Failed (b) at line 3 of spec A + pending (c) at line 2 of spec B; the
    // already-passed (a) at line 2 of spec A must NOT appear.
    expect(result.locations.sort()).toEqual([`${specA}:3`, `${specB}:2`].sort())
    expect(result.locations).not.toContain(`${specA}:2`)
  })

  it('returns no-passed-yet on a fresh run with no passedNames', async () => {
    const { computeNonPassedTargets } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a', async () => {})\n",
    )
    const result = computeNonPassedTargets(featureDir, {})
    expect(result.kind).toBe('no-passed-yet')
  })

  it('returns all-passed when every test is in passedNames', async () => {
    const { computeNonPassedTargets } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('only one', async () => {})\n",
    )
    const result = computeNonPassedTargets(featureDir, {
      passedNames: ['test-case-only-one'],
    })
    expect(result.kind).toBe('all-passed')
  })

  it('returns extraction-failed when no spec files exist', async () => {
    const { computeNonPassedTargets } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'empty')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeNonPassedTargets(featureDir, { passedNames: ['x'] })
    expect(result.kind).toBe('extraction-failed')
  })
})

describe('computeRerunTargetsOrdered', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  it('orders previously-failed tests first, then pending in source order', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-ordered')
    fs.mkdirSync(featureDir, { recursive: true })
    // Spec layout: pending at line 2, failed at line 3 (failure comes AFTER
    // pending in source order — proves failed-first ordering isn't just
    // accidental source order).
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a pending one', async () => {})\n" +
      "test('a failing one', async () => {})\n",
    )
    const specB = writeSpec(featureDir, 'b.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('b another pending', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-something-already-passed'],
      failed: [{ name: 'test-case-a-failing-one', location: `${specA}:3` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${specA}:3`])
    expect(result.pending).toEqual([`${specA}:2`, `${specB}:2`])
    expect(result.locations).toEqual([`${specA}:3`, `${specA}:2`, `${specB}:2`])
    expect(result.droppedFailedSlugs).toEqual([])
    expect(result.total).toBe(3)
  })

  it('drops failed slugs that no longer exist in the AST and reports them', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-dropped')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('renamed test', async () => {})\n" +
      "test('still here', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-still-here'],
      failed: [
        { name: 'test-case-old-name-that-was-renamed', location: `${specA}:3` },
        { name: 'test-case-deleted-entirely', location: `${specA}:99` },
      ],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([])
    expect(result.pending).toEqual([`${specA}:2`])
    expect(result.droppedFailedSlugs.sort()).toEqual([
      'test-case-deleted-entirely',
      'test-case-old-name-that-was-renamed',
    ])
  })

  it('returns pending-only when every prior-failed slug has since passed', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-recovered')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('was failing now passing', async () => {})\n" +
      "test('pending one', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-was-failing-now-passing'],
      // The same slug is still listed in summary.failed (stale) — the helper
      // should ignore it because the slug is also in passedNames.
      failed: [{ name: 'test-case-was-failing-now-passing', location: `${specA}:2` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([])
    expect(result.pending).toEqual([`${specA}:3`])
    expect(result.locations).toEqual([`${specA}:3`])
  })

  it('handles empty passedNames by listing failed-first then everything else', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-no-passed')
    fs.mkdirSync(featureDir, { recursive: true })
    const specA = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n" +
      "test('third', async () => {})\n",
    )

    const result = computeRerunTargetsOrdered(featureDir, {
      failed: [{ name: 'test-case-third', location: `${specA}:4` }],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst).toEqual([`${specA}:4`])
    expect(result.pending).toEqual([`${specA}:2`, `${specA}:3`])
    expect(result.locations).toEqual([`${specA}:4`, `${specA}:2`, `${specA}:3`])
  })

  it('returns all-passed when every AST test is in passedNames', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-all-passed')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('only one', async () => {})\n",
    )
    const result = computeRerunTargetsOrdered(featureDir, {
      passedNames: ['test-case-only-one'],
    })
    expect(result.kind).toBe('all-passed')
  })

  it('returns extraction-failed when there are no spec files', async () => {
    const { computeRerunTargetsOrdered } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-empty')
    fs.mkdirSync(featureDir, { recursive: true })
    const result = computeRerunTargetsOrdered(featureDir, { passedNames: ['x'] })
    expect(result.kind).toBe('extraction-failed')
  })
})
