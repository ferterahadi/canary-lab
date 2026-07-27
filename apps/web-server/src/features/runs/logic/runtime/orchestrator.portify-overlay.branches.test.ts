import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
import { runGit, diffContentSinceSnapshot } from '../../../../shared/git-repo'
import { addWorktree, type WorktreeHandle } from './repo-worktree'
import { writeOverlay, captureTouchedFiles } from '../../../portify/logic/runtime/overlay'

// Phase C: the run-time apply-before-boot / reverse-at-teardown hook. These
// drive a REAL git repo + worktree + saved overlay through the orchestrator's
// start()/stop() and assert the worktree source is patched at boot, reverted at
// teardown, and the worktree itself survives (it holds heal edits).

function makeFakeFactory(): { factory: PtyFactory; spawned: PtySpawnOptions[] } {
  const spawned: PtySpawnOptions[] = []
  let nextPid = 100
  const factory: PtyFactory = (options): PtyHandle => {
    spawned.push(options)
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const pid = nextPid++
    return {
      get pid() { return pid },
      onData: (cb) => { data.on('data', cb); return { dispose: () => data.off('data', cb) } },
      onExit: (cb) => { exit.on('exit', cb); return { dispose: () => exit.off('exit', cb) } },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }
  return { factory, spawned }
}

const BASE = 'const PORT = 3007\nmodule.exports = { PORT }\n'

const PORTED = 'const PORT = Number(process.env.PORT)\nmodule.exports = { PORT }\n'

let tmpDir: string

let repoRoot: string

let featureDir: string

let runDir: string

const cleanup: string[] = []

const RUN_ID = '2026-06-14T1015-port'

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-port-')))
  cleanup.push(tmpDir)
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
  featureDir = path.join(tmpDir, 'features', 'demo')
  fs.mkdirSync(featureDir, { recursive: true })
  // A real git repo with the service source committed at BASE.
  repoRoot = path.join(tmpDir, 'repo')
  fs.mkdirSync(repoRoot, { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'app.js'), BASE)
  await runGit(repoRoot, ['init', '-q'])
  await runGit(repoRoot, ['config', 'user.email', 't@t'])
  await runGit(repoRoot, ['config', 'user.name', 'test'])
  await runGit(repoRoot, ['add', '-A'])
  await runGit(repoRoot, ['commit', '-q', '-m', 'init', '--no-verify'])
})

afterEach(() => {
  for (const c of cleanup) { try { fs.rmSync(c, { recursive: true, force: true }) } catch { /* ignore */ } }
  cleanup.length = 0
})

function makeFeature(): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir,
    repos: [
      {
        name: 'api',
        localPath: repoRoot,
        startCommands: [{ command: 'serve', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
  }
}

/** Capture a BASE→PORTED patch for app.js (with `index` lines), repo left at BASE. */
async function capturePortPatch(): Promise<string> {
  const file = path.join(repoRoot, 'app.js')
  fs.writeFileSync(file, PORTED)
  const diff = await diffContentSinceSnapshot(repoRoot, 'HEAD')
  fs.writeFileSync(file, BASE)
  return diff
}

async function saveOverlay(): Promise<void> {
  const patch = await capturePortPatch()
  const base = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()
  const touchedFiles = await captureTouchedFiles(repoRoot, base, ['app.js'])
  writeOverlay(featureDir, {
    featureName: 'demo',
    agent: 'claude',
    capturedAt: '2026-06-14T00:00:00.000Z',
    repos: [{ name: 'api', baseSha: base, patch, touchedFiles }],
  })
}

async function makeWorktree(): Promise<WorktreeHandle> {
  const handle = await addWorktree({ repoName: 'api', localPath: repoRoot, worktreesDir: path.join(runDir, 'worktrees') })
  cleanup.push(handle.worktreeRoot)
  return handle
}

const wtApp = (h: WorktreeHandle) => fs.readFileSync(path.join(h.worktreeRoot, 'app.js'), 'utf-8')

describe('worktree envset hydration at boot', () => {
  const CHECKED_IN = 'db=jdbc:mysql://db:3306/x\n'

  /** Commit a checked-in config file + write a captured envset targeting it. */
  async function writeEnvset(slotContent: string): Promise<void> {
    fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'config', 'app-local.properties'), CHECKED_IN)
    await runGit(repoRoot, ['add', '-A'])
    await runGit(repoRoot, ['commit', '-q', '-m', 'config', '--no-verify'])
    const setDir = path.join(featureDir, 'envsets', 'local')
    fs.mkdirSync(setDir, { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'envsets', 'envsets.config.json'),
      JSON.stringify({
        appRoots: {},
        slots: {
          'app-local.properties': {
            description: 'captured',
            target: path.join(repoRoot, 'config', 'app-local.properties'),
          },
        },
        feature: { slots: ['app-local.properties'], testCommand: 'true', testCwd: featureDir },
      }),
    )
    fs.writeFileSync(path.join(setDir, 'app-local.properties'), slotContent)
  }

  const wtEnvFile = (h: WorktreeHandle) =>
    fs.readFileSync(path.join(h.worktreeRoot, 'config', 'app-local.properties'), 'utf-8')

  it('a portified run boots the worktree with the captured envset, ${port.*} resolved to the run map', async () => {
    await writeEnvset('url=http://localhost:${port.api}/\n')
    await saveOverlay()
    const handle = await makeWorktree()
    expect(wtEnvFile(handle)).toBe(CHECKED_IN) // worktree starts at committed HEAD

    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      env: 'local',
      portMap: new Map([['api', 61234]]),
      ptyFactory: factory,
      worktrees: [handle],
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    await orch.start()
    expect(wtEnvFile(handle)).toBe('url=http://localhost:61234/\n')
    await orch.stop('passed')
  })

  it('a collision-isolated (non-portified) run hydrates its worktree too', async () => {
    await writeEnvset('db=jdbc:mysql://localhost:3306/x\n')
    // No overlay saved → not portified; the worktree exists via isolation.
    const handle = await makeWorktree()

    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      env: 'local',
      ptyFactory: factory,
      worktrees: [handle],
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    await orch.start()
    expect(wtEnvFile(handle)).toBe('db=jdbc:mysql://localhost:3306/x\n')
    await orch.stop('passed')
  })

  it('a run without an env skips hydration', async () => {
    await writeEnvset('db=jdbc:mysql://localhost:3306/x\n')
    const handle = await makeWorktree()

    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      worktrees: [handle],
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    await orch.start()
    expect(wtEnvFile(handle)).toBe(CHECKED_IN)
    await orch.stop('passed')
  })
})

describe('non-portified run is unaffected', () => {
  it('does not apply or reverse anything and tears down the worktree as before', async () => {
    // No overlay saved → orchestrator.portified is false.
    const handle = await makeWorktree()
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      worktrees: [handle],
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    expect(wtApp(handle)).toBe(BASE) // untouched
    await orch.stop('passed')
    // Non-portified worktree runs tear the worktree down (legacy behavior).
    expect(fs.existsSync(handle.worktreeRoot)).toBe(false)
  })
})
