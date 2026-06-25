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
import { writeOverlay, captureTouchedFiles, overlayDir } from '../../../portify/logic/runtime/overlay'

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

describe('portified run: apply before boot, reverse at teardown', () => {
  it('applies the overlay into the worktree at start and reverses it at stop, keeping the worktree', async () => {
    await saveOverlay()
    const handle = await makeWorktree()
    expect(wtApp(handle)).toBe(BASE) // worktree starts at committed HEAD

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
    // Overlay applied: the worktree's source now reads the injected port.
    expect(wtApp(handle)).toContain('Number(process.env.PORT)')

    // Simulate a heal edit landing in the worktree during the run.
    fs.appendFileSync(path.join(handle.worktreeRoot, 'healed.js'), 'export const healed = true\n')

    await orch.stop('passed')
    // Overlay reversed: app.js is back to base...
    expect(wtApp(handle)).toBe(BASE)
    // ...but the worktree survives WITH the heal edit intact.
    expect(fs.existsSync(handle.worktreeRoot)).toBe(true)
    expect(fs.existsSync(path.join(handle.worktreeRoot, 'healed.js'))).toBe(true)
  })

  it('preserves a heal edit that overlaps the patched line (reverse conflict) and keeps the worktree', async () => {
    await saveOverlay()
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
    expect(wtApp(handle)).toContain('Number(process.env.PORT)')

    // Heal edits the exact line the overlay touched.
    const healed = PORTED.replace('Number(process.env.PORT)', 'Number(process.env.PORT) || 3007')
    fs.writeFileSync(path.join(handle.worktreeRoot, 'app.js'), healed)

    await orch.stop('passed')
    // Reverse conflicts on the overlapping line → file left intact (heal edit survives), worktree kept.
    expect(wtApp(handle)).toBe(healed)
    expect(fs.existsSync(handle.worktreeRoot)).toBe(true)
  })
})

describe('portified run: fail loud, never boot un-portified', () => {
  it('aborts with an actionable error when the overlay is stale', async () => {
    await saveOverlay()
    // The user advances the repo under the captured patch.
    fs.writeFileSync(path.join(repoRoot, 'app.js'), BASE + '// later\n')
    await runGit(repoRoot, ['commit', '-aqm', 'drift', '--no-verify'])
    const handle = await makeWorktree()

    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      worktrees: [handle],
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    await expect(orch.start()).rejects.toThrow(/no longer applies.*re-run Portify/i)
    // No service was spawned — we never booted.
    expect(spawned).toHaveLength(0)
    await orch.stop('aborted')
  })

  it('aborts when a portified repo has no per-run worktree', async () => {
    await saveOverlay()
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      worktrees: [], // no worktree for the portified repo
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    await expect(orch.start()).rejects.toThrow(/requires a per-run worktree/i)
    expect(spawned).toHaveLength(0)
    await orch.stop('aborted')
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
