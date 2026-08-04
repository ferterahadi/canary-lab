import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
import { readManifest, type RunLifecycleEvent } from './manifest'

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

describe('RunOrchestrator.runFullCycle', () => {
  function bootForFullCycle(opts: {
    spawned: { factory: PtyFactory; spawned: ReturnType<typeof makeFakeFactory>['spawned'] }
    pwExitCodes: number[]
    autoHeal?: boolean
    manualHeal?: boolean
    externalHeal?: boolean
  }) {
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: opts.spawned.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: ({ rerunTargets }) => ({
        command: `pw-${pwIdx++}${rerunTargets?.length ? ` ${rerunTargets.join(' ')}` : ''}`,
        cwd: tmpDir,
      }),
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

  function readLifecycleEvents(orch: RunOrchestrator): RunLifecycleEvent[] {
    return fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunLifecycleEvent)
  }

  // The edited file lives under the service's cwd, so the inference is a
  // RESTART: rerunning without one would re-test the still-running pre-fix
  // process and report a working repair as a failure.
  it('infers a restart and writes a journal entry when the agent edits service files but exits without a signal', async () => {
    // tmpDir is the feature's repo localPath — make it a git repo so the
    // orchestrator's snapshot/diff sees the agent's edits.
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'svc.ts'), '// initial\n')
    execFileSync('git', ['add', 'svc.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })

    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → enter heal loop
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent edits a tracked file then exits without writing a signal file.
    fs.writeFileSync(path.join(tmpDir, 'svc.ts'), '// patched by agent\n')
    f.spawned[2].emitExit(0)
    // Inferred .restart: the service respawns (idx 3) so the rerun (idx 4)
    // tests the patched code rather than the process that predates the fix.
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1) // still failing; cap=1 → loop exits

    const status = await promise
    expect(status).toBe('failed')

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('Heal agent exited without writing a signal.')
    expect(journal).toContain('Runner inferred a restart from git diff.')
    expect(journal).toContain(path.join(tmpDir, 'svc.ts'))
    // Without the fallback the loop would have bailed before the restart and
    // rerun ptys existed at all.
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    await orch.stop('failed')
  }, 15000)

  it('agent exit unwedges the loop within one poll tick (no waiting for the heal-agent timeout)', async () => {
    // Regression: when claude's REPL exits unexpectedly mid-cycle (user
    // typed `/exit`, crash, etc.), the orchestrator used to keep polling
    // for a `.heal`/`.rerun`/`.restart` signal until the full
    // `healAgentTimeoutMs` elapsed (10 min in production). Now
    // `waitForHealSignal` also exits when `healAgentPty` is null, so the
    // loop bails out via the "agent exited unexpectedly" branch.
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 5,
      // Long timeout — the test should resolve via the new pty-null exit,
      // NOT by waiting for this number to elapse.
      healAgentTimeoutMs: 60_000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'cat',
        buildCyclePrompt: () => 'cycle prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    const start = Date.now()
    f.spawned[2].emitExit(0) // agent dies cleanly without any signal
    const status = await promise
    const elapsed = Date.now() - start

    expect(status).toBe('failed')
    // Without the fix, this would be ~60_000ms. With the fix, well under 1s.
    expect(elapsed).toBeLessThan(2000)
    await orch.stop('failed')
  }, 10000)

  it('breaks when no failed slugs are present (signature empty)', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    // No summary written → empty failed array → empty signature → no heal.
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    const status = await promise
    expect(status).toBe('failed')
    await orch.stop('failed')
  })

  it('emits agent-output chunks for the live broker', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'x' }] }))
    const chunks: string[] = []
    orch.on('agent-output', (e) => chunks.push(e.chunk))
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitData('agent says hi\n')
    f.spawned[2].emitExit(0) // no signal → give-up
    await promise
    // The broker pushes these chunks to live xterm subscribers; historical
    // replay reads the agent CLI's own JSONL session log instead (no disk
    // transcript is written here).
    expect(chunks.join('')).toContain('agent says hi')
    await orch.stop('failed')
  })

  it('runner-observed git diff drives the journal fix.file and the restart plan', async () => {
    // tmpDir is the feature's repo localPath; turn it into a git repo with
    // a baseline commit so the runner's snapshot-then-diff path picks up
    // files the agent edits between snapshot and signal.
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// initial a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// initial b\n')
    execFileSync('git', ['add', 'a.ts', 'b.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })

    const f = makeFakeFactory()
    // maxCycles=1 so the loop exits after one heal cycle when pw still fails.
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent's turn: modify the tracked files (the snapshot was taken right
    // before the agent pty was spawned, so these edits are inside the
    // iteration's diff window).
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// edited a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// edited b\n')
    // New signal body shape: hypothesis + fixDescription only. The runner
    // detects files via git, not from this body.
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix the thing',
      fixDescription: 'patched the handler',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1) // pw still fails; heal cap=1 → loop exits
    const status = await promise
    expect(status).toBe('failed')
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    // healCycleHistory should record the restart, matched against the diff'd files.
    const m = readManifest(orch.paths.manifestPath)!
    expect((m as { healCycleHistory?: unknown[] }).healCycleHistory).toBeTruthy()
    const history = (m as { healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }> }).healCycleHistory
    expect(history[0].cycle).toBe(1)
    expect(history[0].restarted).toEqual(['api'])
    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('- hypothesis: fix the thing')
    expect(journal).toContain('- fix.description: patched the handler')
    expect(journal).toContain(`- fix.file: ${path.join(tmpDir, 'a.ts')}, ${path.join(tmpDir, 'b.ts')}`)
    expect(fs.existsSync(path.join(tmpDir, 'logs', 'diagnosis-journal.md'))).toBe(false)
    await orch.stop('failed')
  }, 15000)

  it('isolates the agent edit window from pre-existing dirty state', async () => {
    // Workspace is dirty BEFORE heal runs (user WIP). The journal must record
    // only what the agent edited during its turn — pre-existing dirty files
    // must not leak in.
    execFileSync('git', ['init', '-q'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// initial a\n')
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// initial b\n')
    execFileSync('git', ['add', 'a.ts', 'b.ts'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir })
    // Pre-existing WIP — dirty BEFORE the orchestrator starts. The agent
    // never touches this file; the diff must not include it.
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// pre-existing dirty\n')

    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent edits only b.ts, leaves the pre-existing dirty a.ts alone.
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// edited b by agent\n')
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fixed b',
      fixDescription: 'only touched b',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    // fix.file records only the agent's edit, not the pre-existing dirty file.
    expect(journal).toContain(`- fix.file: ${path.join(tmpDir, 'b.ts')}`)
    expect(journal).not.toContain(`- fix.file: ${path.join(tmpDir, 'a.ts')}`)
    expect(journal).not.toMatch(new RegExp(`fix\\.file:.*${path.basename(tmpDir)}/a\\.ts`))
    await orch.stop('failed')
  }, 15000)

  it('aggregates fix.file across multiple feature repos when the agent edits in each', async () => {
    // Two git-tracked feature repos. Each gets its own service. Agent edits
    // one file in each repo during a single heal iteration. The journal's
    // fix.file should list both absolute paths, and both services should
    // restart based on the diff matching their service cwds.
    const repo2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-r2-')))
    for (const dir of [tmpDir, repo2]) {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
      fs.writeFileSync(path.join(dir, 'main.ts'), '// initial\n')
      execFileSync('git', ['add', 'main.ts'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    }

    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({
        repos: [
          {
            name: 'api',
            localPath: tmpDir,
            startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
          },
          {
            name: 'worker',
            localPath: repo2,
            startCommands: [{ command: 'echo hi', name: 'worker', healthCheck: { url: 'http://y' } }],
          },
        ],
      }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    // Two services start in parallel → spawned[0], spawned[1]; spawned[2] = pw.
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(1)
    // spawned[3] = heal agent.
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    // Agent edits files in BOTH repos during its turn.
    fs.writeFileSync(path.join(tmpDir, 'main.ts'), '// edited 1\n')
    fs.writeFileSync(path.join(repo2, 'main.ts'), '// edited 2\n')
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix both',
      fixDescription: 'edited both repos',
    }))
    f.spawned[3].emitExit(0)
    // After the signal: both services restart (spawned[4], spawned[5]), then pw reruns (spawned[6]).
    while (f.spawned.length < 7) await new Promise((r) => setTimeout(r, 5))
    f.spawned[6].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    // fix.file aggregates absolute paths from both repos.
    expect(journal).toMatch(/- fix\.file: .+main\.ts, .+main\.ts/)
    expect(journal).toContain(path.join(tmpDir, 'main.ts'))
    expect(journal).toContain(path.join(repo2, 'main.ts'))
    // The ### Diff subsection records the actual content change from both
    // repos. Multi-repo features get a `# repo:` header per repo so a human
    // (and the heal agent on cycle 2) can tell hunks apart.
    expect(journal).toContain('### Diff')
    expect(journal).toContain('```diff')
    expect(journal).toContain(`# repo: ${tmpDir}`)
    expect(journal).toContain(`# repo: ${repo2}`)
    expect(journal).toMatch(/^-\/\/ initial$/m)
    expect(journal).toMatch(/^\+\/\/ edited 1$/m)
    expect(journal).toMatch(/^\+\/\/ edited 2$/m)
    // Both services were restarted because the diff matched both service cwds.
    const m = readManifest(orch.paths.manifestPath)!
    const history = (m as { healCycleHistory: Array<{ cycle: number; restarted: string[]; kept: string[] }> }).healCycleHistory
    expect(history[0].restarted.sort()).toEqual(['api', 'worker'])
    await orch.stop('failed')
  }, 15000)
})
