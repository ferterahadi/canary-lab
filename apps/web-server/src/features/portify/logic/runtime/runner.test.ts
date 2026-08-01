import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import { loadFeatures } from '../../../../shared/feature-loader'
import { PortifyRunStore } from './store'
import { buildPortifyPaths, portifyDir } from './paths'
import { reclaimOrphanedPortify } from './reclaim'
import { createPortifyRunner } from './runner'
import { runPortifyAgent } from './agent'
import { overlayExists, readOverlay, overlayDir } from './overlay'
import type { PortifyManifest } from './types'

// Mock the agent so no real claude/codex spawns: simulate a source edit at the
// worktree cwd (gives the commit something to commit). The fixture config
// already declares the port slot, so verification passes. Robust to a missing
// src dir (multi-repo roots) — best-effort.
vi.mock('./agent', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runPortifyAgent: vi.fn(async (opts: any) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const f = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const p = require('path') as typeof import('path')
    try {
      f.mkdirSync(p.join(opts.cwd, 'src'), { recursive: true })
      f.appendFileSync(p.join(opts.cwd, 'src', 'server.js'), '\n// port made injectable by agent\n')
    } catch { /* best-effort */ }
  }),
  writePortifyClaudeRef: vi.fn(),
}))

// Default mocked-agent behavior: edit a source file in the worktree so there's
// something to commit. Also register a fake child in the set the real agent
// would populate, so abort()'s child-kill loop is exercised on cancel. Tests
// can override per-case (e.g. the retry case).
async function defaultAgentEdit(opts: { cwd: string; children?: Set<unknown> }): Promise<void> {
  opts.children?.add({ kill: () => {} })
  try {
    fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true })
    fs.appendFileSync(path.join(opts.cwd, 'src', 'server.js'), '\n// port made injectable by agent\n')
  } catch { /* best-effort */ }
}

// Block the REAL process.kill: verification teardown calls process.kill(-pid),
// and a fake pid must never signal a real process group.
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') })
  // Reset the agent mock to the default each test (cases may override it).
  vi.mocked(runPortifyAgent).mockImplementation(defaultAgentEdit as typeof runPortifyAgent)
})

afterEach(() => { vi.restoreAllMocks() })

const fakePtyFactory: PtyFactory = (): PtyHandle => ({
  pid: 9_999_998,
  onData: () => ({ dispose: () => {} }),
  onExit: () => ({ dispose: () => {} }),
  write: () => {},
  resize: () => {},
  kill: () => {},
})

const roots: string[] = []

afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

async function gitInit(dir: string): Promise<void> {
  await runGit(dir, ['init', '-q'])
  await runGit(dir, ['config', 'user.email', 't@t'])
  await runGit(dir, ['config', 'user.name', 'test'])
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['commit', '-q', '-m', 'init', '--no-verify'])
}

function repoStartCommand(name: string, slot: string, env: string, withPorts: boolean): string {
  const ports = withPorts ? `      ports: [{ name: ${JSON.stringify(slot)}, env: ${JSON.stringify(env)} }],\n` : ''
  return (
    `    {\n` +
    `      command: 'node src/server.js',\n` +
    `      name: ${JSON.stringify(name)},\n` +
    ports +
    `      healthCheck: { http: { url: 'http://localhost:\${port.${slot}}/', timeoutMs: 30, deadlineMs: 250 } },\n` +
    `    }`
  )
}

function buildConfigSource(repos: { name: string; localPath: string; slot: string; env: string }[], withPorts: boolean, name = 'myfeat', envs: string[] = ['local']): string {
  const reposSrc = repos.map((r) =>
    `  {\n` +
    `    name: ${JSON.stringify(r.name)},\n` +
    `    localPath: ${JSON.stringify(r.localPath)},\n` +
    `    startCommands: [\n${repoStartCommand(r.name, r.slot, r.env, withPorts)}\n    ],\n` +
    `  }`,
  ).join(',\n')
  return (
    `const config = {\n` +
    `  name: ${JSON.stringify(name)},\n  description: 'test',\n  envs: ${JSON.stringify(envs)},\n` +
    `  repos: [\n${reposSrc}\n  ],\n  featureDir: __dirname,\n}\n` +
    `module.exports = { config }\n`
  )
}

function writeConfig(
  featureDir: string,
  repos: { name: string; localPath: string; slot: string; env: string }[],
  opts: { ext?: 'cjs' | 'js'; withPorts?: boolean; name?: string; envs?: string[] } = {},
): void {
  fs.writeFileSync(
    path.join(featureDir, `feature.config.${opts.ext ?? 'cjs'}`),
    buildConfigSource(repos, opts.withPorts ?? true, opts.name, opts.envs),
  )
}

function makeRunner(
  featuresDir: string,
  logsDir: string,
  healthy = true,
  agent: 'claude' | 'codex' = 'claude',
  loadFeaturesFn?: () => FeatureConfig[],
) {
  const store = new PortifyRunStore(logsDir)
  const runner = createPortifyRunner({
    logsDir,
    store,
    ptyFactory: fakePtyFactory,
    loadFeatures: loadFeaturesFn ?? (() => loadFeatures(featuresDir)),
    pickAgent: () => agent,
    now: () => '2026-06-07T00:00:00.000Z',
    healthCheck: async () => healthy,
    healthPollIntervalMs: 5,
    healthDeadlineMs: healthy ? 400 : 40,
  })
  return { store, runner }
}

async function waitForStatus(store: PortifyRunStore, id: string, until: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = store.get(id)
    if (m && until.includes(m.status)) return m.status
    await new Promise((r) => setTimeout(r, 25))
  }
  return store.get(id)?.status ?? 'missing'
}

const TERMINAL = ['ready-to-save', 'failed', 'aborted']

// Single-repo fixture (the common case).
async function singleFixture(): Promise<{ featuresDir: string; logsDir: string; appRepo: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-it-'))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'myfeat')
  const appRepo = path.join(root, 'app')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
  fs.mkdirSync(featureDir, { recursive: true })
  fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
  await gitInit(appRepo)
  writeConfig(featureDir, [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }])
  return { featuresDir, logsDir, appRepo }
}

describe('createPortifyRunner (integration)', () => {
  it('runs to ready-to-save with a passing double-boot verification and a captured diff', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')

    const ready = store.get(workflowId)!
    expect(ready.verification?.ok).toBe(true)
    expect(ready.verification?.instances).toHaveLength(2)
    expect(ready.diff).toContain('port made injectable by agent')
  })

  it('save() captures the verified edits as an ephemeral overlay and discards the scratch worktree', async () => {
    const { featuresDir, logsDir, appRepo } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    const featureDir = path.join(featuresDir, 'myfeat')

    const saved = await runner.save(workflowId)
    expect(saved.status).toBe('saved')

    // The overlay was written to features/<feature>/portify/ ...
    expect(overlayExists(featureDir)).toBe(true)
    const overlay = readOverlay(featureDir)!
    expect(overlay.meta.featureName).toBe('myfeat')
    expect(overlay.meta.agent).toBe('claude')
    expect(overlay.meta.repos.map((r) => r.name)).toEqual(['app'])
    expect(overlay.patches['app']).toContain('port made injectable by agent')
    expect(fs.existsSync(path.join(overlayDir(featureDir), 'app.patch'))).toBe(true)

    // ... and NOTHING landed in the product repo: no commit, no portify branch,
    // and the scratch worktree/branch are gone.
    const branches = await runGit(appRepo, ['branch', '--list', 'canary/dynamic-ports-myfeat'])
    expect(branches.stdout.trim()).toBe('')
    const log = await runGit(appRepo, ['log', '--oneline'])
    expect(log.stdout.trim().split('\n')).toHaveLength(1) // only the fixture's init commit
  })

  it('save() refuses after a revise pass whose agent mutated the worktree and then threw', async () => {
    // The defect this pins: revise() re-parks at ready-to-save (deliberately —
    // the user must be able to give more feedback), and the manifest still
    // carried the PREVIOUS pass's passing verification. save() reads that field
    // to decide the diff is safe, then captures whatever is on disk NOW — which
    // is the feedback edit below, never double-booted.
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    expect(store.get(workflowId)!.verification?.ok).toBe(true)

    // The revise pass: edit the worktree the way a real agent would, THEN die.
    // Mutating first is load-bearing — a throw before any edit would leave the
    // worktree in its verified state and prove nothing.
    vi.mocked(runPortifyAgent).mockImplementation((async (opts: { cwd: string }) => {
      fs.appendFileSync(path.join(opts.cwd, 'src', 'server.js'), '\n// UNVERIFIED feedback edit\n')
      throw new Error('agent died mid-revise')
    }) as typeof runPortifyAgent)

    await runner.revise(workflowId, 'also token-ise the health check')
    expect(await waitForStatus(store, workflowId, ['ready-to-save'])).toBe('ready-to-save')
    const reparked = store.get(workflowId)!
    expect(reparked.error).toContain('agent died mid-revise')
    expect(reparked.verification?.ok).toBe(false)

    await expect(runner.save(workflowId)).rejects.toMatchObject({ statusCode: 409 })
    // Nothing was written, so the feature is still un-portified and the user can
    // revise again rather than having silently shipped the unjudged edit.
    expect(overlayExists(path.join(featuresDir, 'myfeat'))).toBe(false)
    await runner.cancel(workflowId)
  })

  it('save() refuses a parked review that carries no verification at all', async () => {
    // Reachable through the persisted store rather than in-process: a manifest
    // restored from disk without a verdict. The old guard read "no failing
    // verification" as consent; for a call that captures the live worktree,
    // no verdict has to be as disqualifying as a failed one.
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    const m = store.get(workflowId)!
    store.save({ ...m, verification: undefined })

    await expect(runner.save(workflowId)).rejects.toMatchObject({ statusCode: 409 })
    expect(overlayExists(path.join(featuresDir, 'myfeat'))).toBe(false)
    await runner.cancel(workflowId)
  })

  it('save() works ACROSS a server restart: reclaim keeps the parked review, a fresh runner saves from the persisted capture', async () => {
    const { featuresDir, logsDir, appRepo } = await singleFixture()
    const featureDir = path.join(featuresDir, 'myfeat')
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    const paths = buildPortifyPaths(portifyDir(logsDir, workflowId))
    // The ready-to-save park persisted the restart-survival capture.
    expect(fs.existsSync(paths.pendingOverlayPath)).toBe(true)

    // "Restart": boot-time reclaim over a fresh store, then a FRESH runner
    // (empty in-memory active map — the worktree state died with the process).
    await reclaimOrphanedPortify(new PortifyRunStore(logsDir), logsDir, () => '2026-06-07T02:00:00.000Z')
    const fresh = makeRunner(featuresDir, logsDir)
    expect(fresh.store.get(workflowId)?.status).toBe('ready-to-save') // kept parked, not aborted

    const saved = await fresh.runner.save(workflowId)
    expect(saved.status).toBe('saved')
    expect(overlayExists(featureDir)).toBe(true)
    const overlay = readOverlay(featureDir)!
    expect(overlay.patches['app']).toContain('port made injectable by agent')
    expect(fs.existsSync(paths.pendingOverlayPath)).toBe(false) // consumed

    // Still nothing in the product repo.
    const branches = await runGit(appRepo, ['branch', '--list', 'canary/dynamic-ports-myfeat'])
    expect(branches.stdout.trim()).toBe('')
  })

  it('save() after a restart rejects a pending-overlay capture that is unreadable or malformed', async () => {
    // The capture is the ONLY thing standing in for the dead worktrees, so a
    // truncated or wrong-shaped file has to read as "worktree gone" (409),
    // never as an empty overlay silently saved over the feature.
    for (const body of ['{ truncated', JSON.stringify({ version: 1, repos: 'not-an-array' })]) {
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
      const paths = buildPortifyPaths(portifyDir(logsDir, workflowId))
      fs.writeFileSync(paths.pendingOverlayPath, body)

      await reclaimOrphanedPortify(new PortifyRunStore(logsDir), logsDir, () => '2026-06-07T02:00:00.000Z')
      const fresh = makeRunner(featuresDir, logsDir)

      await expect(fresh.runner.save(workflowId)).rejects.toMatchObject({ statusCode: 409 })
    }
  })

  it('verifies without envset hydration when the feature declares no envs', async () => {
    // Hydration only applies when there IS a captured envset to hydrate; a
    // feature with no envs must still reach a verified review.
    const { featuresDir, logsDir, appRepo } = await singleFixture()
    writeConfig(path.join(featuresDir, 'myfeat'), [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }], { envs: [] })
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })

    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
  })

  it('cancel() after a restart restores the pre-edit config from the on-disk snapshot', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const featureDir = path.join(featuresDir, 'myfeat')
    const configPath = path.join(featureDir, 'feature.config.cjs')
    const original = fs.readFileSync(configPath, 'utf-8')
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    // Simulate the agent's in-place config edit (the mocked agent only edits
    // worktree source, so stamp the canonical config by hand).
    fs.writeFileSync(configPath, `${original}// portified\n`)

    await reclaimOrphanedPortify(new PortifyRunStore(logsDir), logsDir, () => '2026-06-07T02:00:00.000Z')
    // Reclaim kept the parked review AND its in-place config edit.
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('// portified')

    const fresh = makeRunner(featuresDir, logsDir)
    const cancelled = await fresh.runner.cancel(workflowId)
    expect(cancelled.status).toBe('aborted')
    // Declining undid the config edit from the persisted snapshot.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original)
  })

  it('cancel() after a restart still aborts when the config snapshot is gone', async () => {
    // A logs cleanup can take the snapshot with it; declining must abort the
    // workflow anyway rather than fail, even though the edit can't be undone.
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    const paths = buildPortifyPaths(portifyDir(logsDir, workflowId))
    fs.rmSync(paths.originalConfigPath, { force: true })

    await reclaimOrphanedPortify(new PortifyRunStore(logsDir), logsDir, () => '2026-06-07T02:00:00.000Z')
    const fresh = makeRunner(featuresDir, logsDir)

    expect((await fresh.runner.cancel(workflowId)).status).toBe('aborted')
  })

  it('rejects a NEW workflow for a feature whose parked review survived a restart', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')

    await reclaimOrphanedPortify(new PortifyRunStore(logsDir), logsDir, () => '2026-06-07T02:00:00.000Z')
    const fresh = makeRunner(featuresDir, logsDir)
    await expect(fresh.runner.startPortify({ feature: 'myfeat', agent: 'claude' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('parked awaiting save/cancel') })
  })

  it('save() 404s for an unknown workflow and 409s when not ready', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)
    await expect(runner.save('nope')).rejects.toMatchObject({ statusCode: 404 })

    store.save({
      workflowId: 'w', feature: 'f', featureDir: '/f', repos: [], agent: 'claude',
      branch: 'b', status: 'editing', attempt: 1, maxAttempts: 1, startedAt: 'now',
    } as PortifyManifest)
    await expect(runner.save('w')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('applies review feedback by resuming the agent and re-verifying, then saves the overlay', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const featureDir = path.join(featuresDir, 'myfeat')
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    const agentCallsBefore = vi.mocked(runPortifyAgent).mock.calls.length

    // Feedback flips back to editing synchronously, then re-runs to ready-to-save.
    const flipped = await runner.revise(workflowId, 'rename PORT to API_PORT')
    expect(flipped.status).toBe('editing')
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')

    const after = store.get(workflowId)!
    expect(after.feedbackRounds).toBe(1)
    expect(after.attempt).toBe(1) // auto-retry budget untouched
    expect(after.verification?.ok).toBe(true)

    // The agent ran once more, resuming its session.
    const calls = vi.mocked(runPortifyAgent).mock.calls
    expect(calls.length).toBe(agentCallsBefore + 1)
    expect(calls[calls.length - 1][0]).toMatchObject({ resume: true })

    // Scratch worktree survived the revise — save still writes the overlay.
    const saved = await runner.save(workflowId)
    expect(saved.status).toBe('saved')
    expect(overlayExists(featureDir)).toBe(true)
  })

  it('revise falls back to the in-memory manifest when the post-float store read returns nothing', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')

    const real = store.get(workflowId)!
    const realGet = store.get.bind(store)
    // First read is the guard (manifest must exist); the post-float read
    // returns undefined so the `?? m` fallback is taken. All later reads
    // (the floated revise + waitForStatus) use the real store.
    vi.spyOn(store, 'get')
      .mockReturnValueOnce(real)
      .mockReturnValueOnce(null)
      .mockImplementation(realGet)

    const flipped = await runner.revise(workflowId, 'tweak ports')
    expect(flipped).toBe(real)

    // Let the floated revise settle before teardown (process.kill stays mocked).
    await waitForStatus(store, workflowId, TERMINAL)
  })

  it('fails after exhausting attempts, discards the worktree, and restores the config', async () => {
    const { featuresDir, logsDir, appRepo } = await singleFixture()
    const featureDir = path.join(featuresDir, 'myfeat')
    const configBefore = fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')
    const { store, runner } = makeRunner(featuresDir, logsDir, /* healthy */ false)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('failed')
    const m = store.get(workflowId)!
    expect(m.verification?.ok).toBe(false)

    // cleanup ran: the config is restored and the branch/worktree are gone.
    expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')).toBe(configBefore)
    const branches = await runGit(appRepo, ['branch', '--list', m.branch])
    expect(branches.stdout.trim()).toBe('')
  })

  it('rejects a second workflow while one is active; cancel frees the slot', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    await waitForStatus(store, workflowId, TERMINAL)
    await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
    expect((await runner.cancel(workflowId)).status).toBe('aborted')
    const second = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(second.workflowId).toBeTruthy()
    await runner.cancel(second.workflowId)
  })
})
