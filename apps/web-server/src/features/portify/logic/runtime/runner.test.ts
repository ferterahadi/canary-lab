import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import { loadFeatures } from '../../../config/logic/feature-loader'
import { PortifyRunStore } from './store'
import { PortifyOrchestrator } from './orchestrator'
import { createPortifyRunner, safeKey } from './runner'
import { runPortifyAgent } from './agent'
import { overlayExists, readOverlay, overlayDir, writeOverlay } from './overlay'
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

function buildConfigSource(repos: { name: string; localPath: string; slot: string; env: string }[], withPorts: boolean): string {
  const reposSrc = repos.map((r) =>
    `  {\n` +
    `    name: ${JSON.stringify(r.name)},\n` +
    `    localPath: ${JSON.stringify(r.localPath)},\n` +
    `    startCommands: [\n${repoStartCommand(r.name, r.slot, r.env, withPorts)}\n    ],\n` +
    `  }`,
  ).join(',\n')
  return (
    `const config = {\n` +
    `  name: 'myfeat',\n  description: 'test',\n  envs: ['local'],\n` +
    `  repos: [\n${reposSrc}\n  ],\n  featureDir: __dirname,\n}\n` +
    `module.exports = { config }\n`
  )
}

function writeConfig(
  featureDir: string,
  repos: { name: string; localPath: string; slot: string; env: string }[],
  opts: { ext?: 'cjs' | 'js'; withPorts?: boolean } = {},
): void {
  fs.writeFileSync(
    path.join(featureDir, `feature.config.${opts.ext ?? 'cjs'}`),
    buildConfigSource(repos, opts.withPorts ?? true),
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
      .mockReturnValueOnce(undefined)
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

  describe('multi-repo', () => {
    it('handles two repos in DIFFERENT git roots (one worktree each)', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-multi-'))
      roots.push(root)
      const featuresDir = path.join(root, 'features')
      const featureDir = path.join(featuresDir, 'myfeat')
      const appA = path.join(root, 'a')
      const appB = path.join(root, 'b')
      const logsDir = path.join(root, 'logs')
      for (const r of [appA, appB]) {
        fs.mkdirSync(path.join(r, 'src'), { recursive: true })
        fs.writeFileSync(path.join(r, 'src', 'server.js'), 'const PORT = process.env.PORT\n')
        await gitInit(r)
      }
      fs.mkdirSync(featureDir, { recursive: true })
      writeConfig(featureDir, [
        { name: 'a', localPath: appA, slot: 'a', env: 'PORT_A' },
        { name: 'b', localPath: appB, slot: 'b', env: 'PORT_B' },
      ])
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
      // Two distinct worktree paths recorded (one per root).
      const ready = store.get(workflowId)!
      const wts = new Set(ready.repos.map((r) => r.worktreePath))
      expect(wts.size).toBe(2)
      const saved = await runner.save(workflowId)
      expect(saved.status).toBe('saved')
      // The overlay records both repos; the edited group's patch is non-empty.
      const overlay = readOverlay(featureDir)!
      expect(overlay.meta.repos.map((r) => r.name).sort()).toEqual(['a', 'b'])
      expect(Object.values(overlay.patches).some((p) => p.includes('port made injectable by agent'))).toBe(true)
    })

    it('handles two repos in the SAME git root (one shared worktree, no branch clash)', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-mono-'))
      roots.push(root)
      const featuresDir = path.join(root, 'features')
      const featureDir = path.join(featuresDir, 'myfeat')
      const mono = path.join(root, 'mono')
      const logsDir = path.join(root, 'logs')
      for (const svc of ['svcA', 'svcB']) {
        fs.mkdirSync(path.join(mono, svc, 'src'), { recursive: true })
        fs.writeFileSync(path.join(mono, svc, 'src', 'server.js'), 'const PORT = process.env.PORT\n')
      }
      await gitInit(mono)
      fs.mkdirSync(featureDir, { recursive: true })
      writeConfig(featureDir, [
        { name: 'a', localPath: path.join(mono, 'svcA'), slot: 'a', env: 'PORT_A' },
        { name: 'b', localPath: path.join(mono, 'svcB'), slot: 'b', env: 'PORT_B' },
      ])
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
      // Same-root previously failed at setup with "branch already checked out".
      // Grouping fixes it: one worktree, no clash → reaches ready-to-save.
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
      const ready = store.get(workflowId)!
      expect(new Set(ready.repos.map((r) => r.worktreePath)).size).toBe(1)
      await runner.cancel(workflowId)
    })
  })

  describe('start guards', () => {
    async function runnerWith(features: FeatureConfig[], pickAgent: () => 'claude' | null = () => 'claude') {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-guard-'))
      roots.push(root)
      const store = new PortifyRunStore(path.join(root, 'logs'))
      return createPortifyRunner({
        logsDir: path.join(root, 'logs'), store, ptyFactory: fakePtyFactory,
        loadFeatures: () => features, pickAgent, now: () => 'now',
      })
    }
    const feat = (over: Partial<FeatureConfig>): FeatureConfig =>
      ({ name: 'myfeat', description: 'd', envs: ['local'], featureDir: '/f', repos: [{ name: 'r', localPath: '~/r' }], ...over })

    it('404 when the feature is unknown', async () => {
      const runner = await runnerWith([])
      await expect(runner.startPortify({ feature: 'nope' })).rejects.toMatchObject({ statusCode: 404 })
    })
    it('409 when the feature declares no repos', async () => {
      const runner = await runnerWith([feat({ repos: [] })])
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
    })
    it('409 when no agent CLI is available', async () => {
      const runner = await runnerWith([feat({})], () => null)
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
    })
    it('409 when a repo is not a git repository', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-nogit-'))
      roots.push(dir)
      const runner = await runnerWith([feat({ repos: [{ name: 'r', localPath: dir }] })])
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
    })
    it('409 when a repo has uncommitted changes', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-dirty-'))
      roots.push(dir)
      fs.writeFileSync(path.join(dir, 'f.txt'), 'a')
      await gitInit(dir)
      fs.writeFileSync(path.join(dir, 'f.txt'), 'changed') // now dirty
      const runner = await runnerWith([feat({ repos: [{ name: 'r', localPath: dir }] })])
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
    })
    it('409 when repos is undefined (no bootable repos)', async () => {
      const runner = await runnerWith([feat({ repos: undefined })])
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
    })
    it('names the requested agent in the error when that CLI is unavailable', async () => {
      const runner = await runnerWith([feat({})], () => null)
      await expect(runner.startPortify({ feature: 'myfeat', agent: 'codex' }))
        .rejects.toThrow(/the codex CLI is not available/)
    })
  })

  describe('save / cancel guards', () => {
    it('cancel 404s for an unknown workflow', async () => {
      const { runner } = makeRunner('x', fs.mkdtempSync(path.join(os.tmpdir(), 'portify-cc-')))
      await expect(runner.cancel('nope')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('save 409s when the latest revise left verification failing', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-unproven-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save(readyManifest({ verification: { ok: false, instances: [], failureDetail: 'clash' } }))
      await expect(runner.save('w')).rejects.toMatchObject({ statusCode: 409 })
    })

    it('revise 404s for an unknown workflow', async () => {
      const { runner } = makeRunner('x', fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rv-')))
      await expect(runner.revise('nope', 'do x')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('revise 400s on empty feedback', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rvb-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save(readyManifest())
      await expect(runner.revise('w', '   ')).rejects.toMatchObject({ statusCode: 400 })
    })

    it('revise 409s when the workflow is not ready-to-save', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rvs-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save(readyManifest({ status: 'editing' }))
      await expect(runner.revise('w', 'do x')).rejects.toMatchObject({ statusCode: 409 })
    })

    it('revise 409s when the worktree is no longer active (e.g. after a restart)', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rvi-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      // Saved directly → never went through startPortify → not in the active map.
      store.save(readyManifest())
      await expect(runner.revise('w', 'do x')).rejects.toMatchObject({ statusCode: 409 })
    })

    it('remove 404s for an unknown workflow', async () => {
      const { runner } = makeRunner('x', fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rm404-')))
      await expect(runner.remove('nope')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('remove 409s for a non-terminal workflow', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rmne-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save(readyManifest()) // ready-to-save is non-terminal
      await expect(runner.remove('w')).rejects.toMatchObject({ statusCode: 409 })
    })

    it('remove drops a terminal workflow from history', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rmok-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save(readyManifest({ status: 'saved', endedAt: 'now' }))
      expect(await runner.remove('w')).toEqual({ workflowId: 'w', removed: true })
      expect(store.list()).toEqual([])
    })
  })

})

function readyManifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'w', feature: 'f', featureDir: '/f', repos: [], agent: 'claude',
    branch: 'b', status: 'ready-to-save', attempt: 1, maxAttempts: 3, startedAt: 'now', ...over,
  }
}

describe('createPortifyRunner (branch coverage)', () => {
  it('safeKey sanitizes and falls back to "root"', () => {
    expect(safeKey('A b!')).toBe('A-b')
    expect(safeKey('@@@')).toBe('root')
  })

  it('runs with the codex agent (no claude session id)', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir, true, 'codex')
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'codex', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    await runner.cancel(workflowId)
  })

  it('clamps a non-positive maxAttempts to the default', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: -1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    expect(store.get(workflowId)!.maxAttempts).toBe(3)
    await runner.cancel(workflowId)
  })

  it('retries with resume after a failed verify, then succeeds (and diffs the config)', async () => {
    // Config starts WITHOUT port slots → attempt 1 verify fails ("no slots").
    // The agent adds the slot to the (git-tracked) config on attempt 2 → passes.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-retry-'))
    roots.push(root)
    const featuresDir = path.join(root, 'features')
    const featureDir = path.join(featuresDir, 'myfeat')
    const appRepo = path.join(root, 'app')
    const logsDir = path.join(root, 'logs')
    fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT\n')
    await gitInit(appRepo)
    writeConfig(featureDir, [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }], { withPorts: false })
    await gitInit(featureDir) // config is git-tracked so canonicalConfigDiff is non-empty

    let call = 0
    vi.mocked(runPortifyAgent).mockImplementation(async (opts: { cwd: string }) => {
      call += 1
      await defaultAgentEdit(opts)
      if (call === 2) {
        writeConfig(featureDir, [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }], { withPorts: true })
      }
    })
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 2 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    const m = store.get(workflowId)!
    expect(m.attempt).toBe(2)
    expect(m.diff).toContain('# feature config:')
    await runner.cancel(workflowId)
  })

  it('falls back to the in-memory feature when the reload no longer finds it', async () => {
    const { featuresDir, logsDir } = await singleFixture()
    const feats = loadFeatures(featuresDir)
    let n = 0
    // First call (startPortify) sees the feature; the verify reload sees none.
    const loadFeaturesFn = (): FeatureConfig[] => (++n === 1 ? feats : [])
    const { store, runner } = makeRunner(featuresDir, logsDir, true, 'claude', loadFeaturesFn)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    await runner.cancel(workflowId)
  })

  it('skips the config snapshot/restore when there is no .cjs config (feature.config.js)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-js-'))
    roots.push(root)
    const featuresDir = path.join(root, 'features')
    const featureDir = path.join(featuresDir, 'myfeat')
    const appRepo = path.join(root, 'app')
    const logsDir = path.join(root, 'logs')
    fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT\n')
    await gitInit(appRepo)
    writeConfig(featureDir, [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }], { ext: 'js' })
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    await runner.cancel(workflowId) // restoreConfig hits the originalConfig == null arm
  })

  it('save 409s when the manifest is ready but the active state is gone', async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-nostate-'))
    roots.push(logsDir)
    const { store, runner } = makeRunner('x', logsDir)
    store.save(readyManifest({ workflowId: 'w' }))
    await expect(runner.save('w')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('save returns idempotently when the workflow is already saved (line 341 TRUE branch)', async () => {
    // Line 341: `if (m.status === 'saved') return m` — double-save guard.
    // If the workflow was already saved (e.g. a race) it is returned unchanged.
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-saved2-'))
    roots.push(logsDir)
    const { store, runner } = makeRunner('x', logsDir)
    const saved = readyManifest({ workflowId: 'w', status: 'saved', endedAt: 'now' })
    store.save(saved)
    const result = await runner.save('w')
    expect(result.status).toBe('saved')
    expect(result).toMatchObject({ workflowId: 'w', status: 'saved' })
  })

  it('cancel marks a stateless workflow aborted, and returns a saved one untouched', async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-cancel2-'))
    roots.push(logsDir)
    const { store, runner } = makeRunner('x', logsDir)
    // No active state, no endedAt → aborted with now().
    store.save(readyManifest({ workflowId: 'a', status: 'editing' }))
    expect((await runner.cancel('a')).status).toBe('aborted')
    // Already saved → returned untouched.
    store.save(readyManifest({ workflowId: 'b', status: 'saved', endedAt: '2026-06-07T00:00:00.000Z' }))
    expect((await runner.cancel('b')).status).toBe('saved')
  })

  it('handles a repo whose localPath IS its git root (empty edit subpath)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portify-root-')))
    roots.push(root)
    const featuresDir = path.join(root, 'features')
    const featureDir = path.join(featuresDir, 'myfeat')
    const appRepo = path.join(root, 'app')
    const logsDir = path.join(root, 'logs')
    fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT\n')
    await gitInit(appRepo)
    // Use the realpath'd root as localPath so it equals the git toplevel → the
    // member's edit subpath is '' (the `: worktreeRoot` arm of the ternary).
    writeConfig(featureDir, [{ name: 'app', localPath: fs.realpathSync(appRepo), slot: 'api', env: 'PORT' }])
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
    await runner.cancel(workflowId)
  })

  it('flags a modified test file (checkTestsUntouched) and fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-testedit-'))
    roots.push(root)
    const featuresDir = path.join(root, 'features')
    const featureDir = path.join(featuresDir, 'myfeat')
    const appRepo = path.join(root, 'app')
    const logsDir = path.join(root, 'logs')
    fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
    fs.mkdirSync(path.join(appRepo, 'e2e'), { recursive: true })
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT\n')
    fs.writeFileSync(path.join(appRepo, 'e2e', 'api.spec.js'), '// test\n')
    await gitInit(appRepo)
    writeConfig(featureDir, [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }])
    // Agent modifies a tracked test file → checkTestsUntouched flags it.
    vi.mocked(runPortifyAgent).mockImplementation(async (opts: { cwd: string }) => {
      fs.appendFileSync(path.join(opts.cwd, 'e2e', 'api.spec.js'), '\n// agent touched a test\n')
    })
    const { store, runner } = makeRunner(featuresDir, logsDir)
    const { workflowId } = await runner.startPortify({ feature: 'myfeat', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('failed')
    expect(store.get(workflowId)!.verification?.failureDetail).toContain('api.spec.js')
  })

  describe('external producer', () => {
    it('startExternalPortify sets up the worktree, parks at editing, and runs no local agent', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const agentCallsBefore = vi.mocked(runPortifyAgent).mock.calls.length

      const result = await runner.startExternalPortify({
        feature: 'myfeat', clientKind: 'claude', sessionId: 's1', conversationName: 'port work',
      })
      expect(result.workflowId).toMatch(/^portify-/)
      expect(result.targets).toHaveLength(1)
      expect(result.targets[0].name).toBe('app')
      expect(result.targets[0].editPath).toBeTruthy()
      expect(result.configPath).toContain('feature.config.cjs')
      expect(result.instructions.length).toBeGreaterThan(0)

      const m = store.get(result.workflowId)!
      expect(m.status).toBe('editing')
      expect(m.producer).toBe('external')
      expect(m.external).toMatchObject({ clientKind: 'claude', sessionId: 's1', conversationName: 'port work' })
      expect(m.repos[0].worktreePath).toBeTruthy()
      // No local agent is spawned for an external workflow.
      expect(vi.mocked(runPortifyAgent).mock.calls.length).toBe(agentCallsBefore)

      await runner.cancel(result.workflowId)
    })

    it('submitExternalPortify verifies in-place edits → ready-to-save, then save captures the overlay', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const featureDir = path.join(featuresDir, 'myfeat')
      const { store, runner } = makeRunner(featuresDir, logsDir)

      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      // Simulate the external client editing the scratch worktree IN PLACE.
      fs.appendFileSync(
        path.join(result.targets[0].editPath, 'src', 'server.js'),
        '\n// port made injectable by external client\n',
      )

      await runner.submitExternalPortify(result.workflowId)
      expect(await waitForStatus(store, result.workflowId, ['ready-to-save', 'failed'])).toBe('ready-to-save')

      const ready = store.get(result.workflowId)!
      expect(ready.verification?.ok).toBe(true)
      expect(ready.diff).toContain('port made injectable by external client')

      const saved = await runner.save(result.workflowId)
      expect(saved.status).toBe('saved')
      expect(overlayExists(featureDir)).toBe(true)
      expect(readOverlay(featureDir)!.patches['app']).toContain('external client')
    })

    it('submitExternalPortify parks at ready-to-save on an empty diff when the double-boot passes (source already env-driven)', async () => {
      // The fixture's server.js already reads process.env.PORT (as if the repo
      // were portified for another feature), so no in-place edit is needed — the
      // concurrent boot still proves it and save records an empty overlay.
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)

      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'codex', sessionId: 's1' })
      await runner.submitExternalPortify(result.workflowId)

      expect(await waitForStatus(store, result.workflowId, ['ready-to-save', 'editing', 'failed'])).toBe('ready-to-save')
      const ready = store.get(result.workflowId)!
      expect(ready.verification?.ok).toBe(true)
      expect((ready.diff ?? '').trim()).toBe('') // empty overlay

      const saved = await runner.save(result.workflowId)
      expect(saved.status).toBe('saved')
      expect(overlayExists(path.join(featuresDir, 'myfeat'))).toBe(true)
    })

    it('borrows a sibling feature\'s saved overlay for the same app and pre-applies it into the worktree', async () => {
      // Two features target the SAME app repo. feat-a is already portified (a
      // non-empty overlay saved against the repo's HEAD). Starting portify for
      // feat-b should pre-apply feat-a's patch so feat-b starts from the rewrite
      // — and the borrowed lines flow into feat-b's OWN captured overlay.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-borrow-'))
      roots.push(root)
      const featuresDir = path.join(root, 'features')
      const appRepo = path.join(root, 'app')
      const logsDir = path.join(root, 'logs')
      fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
      fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
      await gitInit(appRepo)

      const cfg = (name: string) =>
        `const config = { name: ${JSON.stringify(name)}, description: 't', envs: ['local'], repos: [ { name: 'app', localPath: ${JSON.stringify(appRepo)}, startCommands: [ { command: 'node src/server.js', name: 'app', ports: [{ name: 'api', env: 'PORT' }], healthCheck: { http: { url: 'http://localhost:\${port.api}/', timeoutMs: 30, deadlineMs: 250 } } } ] } ], featureDir: __dirname }\nmodule.exports = { config }\n`
      const featADir = path.join(featuresDir, 'feat-a')
      const featBDir = path.join(featuresDir, 'feat-b')
      fs.mkdirSync(featADir, { recursive: true })
      fs.mkdirSync(featBDir, { recursive: true })
      fs.writeFileSync(path.join(featADir, 'feature.config.cjs'), cfg('feat-a'))
      fs.writeFileSync(path.join(featBDir, 'feature.config.cjs'), cfg('feat-b'))

      // Capture a real unified diff against appRepo HEAD, then restore the clean
      // tree (worktrees only see committed files) and save it as feat-a's overlay.
      const serverPath = path.join(appRepo, 'src', 'server.js')
      const origServer = fs.readFileSync(serverPath, 'utf-8')
      fs.appendFileSync(serverPath, '// borrowed: listener reads injected PORT\n')
      const patch = (await runGit(appRepo, ['diff'])).stdout
      fs.writeFileSync(serverPath, origServer)
      const baseSha = (await runGit(appRepo, ['rev-parse', 'HEAD'])).stdout.trim()
      writeOverlay(featADir, {
        featureName: 'feat-a',
        agent: 'claude',
        capturedAt: '2026-06-07T00:00:00.000Z',
        repos: [{ name: 'app', baseSha, patch, touchedFiles: [] }],
      })

      const { store, runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({ feature: 'feat-b', clientKind: 'codex', sessionId: 's1' })

      // The borrowed patch is pre-applied into feat-b's scratch worktree...
      const worktreeServer = fs.readFileSync(path.join(result.targets[0].editPath, 'src', 'server.js'), 'utf-8')
      expect(worktreeServer).toContain('borrowed: listener reads injected PORT')
      // ...and the client is told it was borrowed (so it reviews + declares slots).
      expect(result.instructions).toContain('PRE-APPLIED')
      expect(result.instructions).toContain('feat-a')

      // Submit with no further edits: the borrowed source already reads the port,
      // so the double-boot passes and feat-b's OWN overlay captures the patch.
      await runner.submitExternalPortify(result.workflowId)
      expect(await waitForStatus(store, result.workflowId, ['ready-to-save', 'editing', 'failed'])).toBe('ready-to-save')
      await runner.save(result.workflowId)
      expect(readOverlay(featBDir)!.patches['app']).toContain('borrowed: listener reads injected PORT')
    })

    it('submitExternalPortify re-parks at editing with a clear message when an empty diff also fails to boot', async () => {
      // healthy=false → the double-boot fails; with no edits to point at, the
      // message tells the client the listeners still aren't reading the port.
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir, /* healthy */ false)

      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'codex', sessionId: 's1' })
      await runner.submitExternalPortify(result.workflowId)

      const deadline = Date.now() + 4000
      let m = store.get(result.workflowId)!
      while (Date.now() < deadline && !m.verification?.failureDetail) {
        await new Promise((r) => setTimeout(r, 25))
        m = store.get(result.workflowId)!
      }
      expect(m.status).toBe('editing')
      expect(m.verification?.failureDetail).toMatch(/no edits detected/i)
      await runner.cancel(result.workflowId)
    })

    it('enforces one workflow at a time across local + external', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      await expect(
        runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's2' }),
      ).rejects.toMatchObject({ statusCode: 409 })
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
      await runner.cancel(result.workflowId)
    })

    it('submitExternalPortify 404s for an unknown workflow and 409s for a non-external one', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      await expect(runner.submitExternalPortify('nope')).rejects.toMatchObject({ statusCode: 404 })

      store.save({
        workflowId: 'w', feature: 'f', featureDir: '/f', repos: [], agent: 'claude',
        producer: 'internal', branch: 'b', status: 'editing', attempt: 1, maxAttempts: 1, startedAt: 'now',
      } as PortifyManifest)
      await expect(runner.submitExternalPortify('w')).rejects.toMatchObject({ statusCode: 409 })
    })

    it('startExternalPortify 404s when the feature is unknown', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { runner } = makeRunner(featuresDir, logsDir)
      await expect(
        runner.startExternalPortify({ feature: 'nonexistent', clientKind: 'claude', sessionId: 's1' }),
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('startExternalPortify includes sessionUrl in the external session record when provided', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({
        feature: 'myfeat',
        clientKind: 'claude',
        sessionId: 's1',
        sessionUrl: 'https://claude.ai/chat/abc-123',
      })
      await waitForStatus(store, result.workflowId, ['editing'])
      const m = store.get(result.workflowId)!
      expect(m.external?.sessionUrl).toBe('https://claude.ai/chat/abc-123')
      await runner.cancel(result.workflowId)
    })

    it('startExternalPortify 409s when orchestrator setup fails (startExternal returns non-editing)', async () => {
      // Use an invalid git repo so worktree setup throws
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-bad-'))
      roots.push(root)
      const featuresDir = path.join(root, 'features')
      const featureDir = path.join(featuresDir, 'badfeature')
      const notAGitRepo = path.join(root, 'not-a-repo')
      fs.mkdirSync(featureDir, { recursive: true })
      fs.mkdirSync(notAGitRepo, { recursive: true })
      // Write a feature config pointing to a non-git dir so worktree creation fails
      fs.writeFileSync(
        path.join(featureDir, 'feature.config.cjs'),
        `const config = { name: 'badfeature', description: 'd', envs: ['local'], repos: [{ name: 'app', localPath: ${JSON.stringify(notAGitRepo)}, startCommands: [{ command: 'node x', name: 'app', healthCheck: { http: { url: 'http://localhost:3000/', timeoutMs: 30, deadlineMs: 250 } } }] }], featureDir: __dirname }; module.exports = { config }`,
      )
      const logsDir = path.join(root, 'logs')
      const { runner } = makeRunner(featuresDir, logsDir)
      await expect(
        runner.startExternalPortify({ feature: 'badfeature', clientKind: 'claude', sessionId: 's1' }),
      ).rejects.toMatchObject({ statusCode: 409 })
    })

    it('submitExternalPortify 409s when workflow is not in editing state', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      await waitForStatus(store, result.workflowId, ['editing'])
      // Simulate verification already completed by manually patching the manifest
      const m = store.get(result.workflowId)!
      store.save({ ...m, status: 'ready-to-save' })
      await expect(runner.submitExternalPortify(result.workflowId)).rejects.toMatchObject({ statusCode: 409 })
      await runner.cancel(result.workflowId)
    })

    it('submitExternalPortify 409s when there is no active orchestrator (server restart simulation)', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner: runner1 } = makeRunner(featuresDir, logsDir)
      const result = await runner1.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      await waitForStatus(store, result.workflowId, ['editing'])

      // Create a second runner instance (simulates server restart) — no active orchestrators
      const { runner: runner2 } = makeRunner(featuresDir, logsDir)
      await expect(runner2.submitExternalPortify(result.workflowId)).rejects.toMatchObject({ statusCode: 409 })
      await runner1.cancel(result.workflowId)
    })

    it('buildSiblingOverlayIndex skips siblings with no overlay, empty patch, missing repos decl, or bad git root; sort comparator is non-zero on SHA-match diff; applyOverlay non-ok is a no-op', async () => {
      // Covers BRDA:126,2,0 (no overlay), 129,3,0 (empty patch), 130,5,1 + 131,6,0 (repos undefined),
      // 134,7,0 (bad git root), 159,12,0 (sort non-zero → SHA-match branch), 314,28,1 (applyOverlay non-ok)
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-sibidx-'))
      roots.push(root)
      const appRepo = path.join(root, 'app')
      const notGit = path.join(root, 'notgit')
      const logsDir = path.join(root, 'logs')
      fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
      fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT ?? 3000\n')
      await gitInit(appRepo)
      fs.mkdirSync(notGit)
      const headSha = (await runGit(appRepo, ['rev-parse', 'HEAD'])).stdout.trim()

      const sibNames = ['current', 'sib-no-overlay', 'sib-empty-patch', 'sib-no-repos', 'sib-bad-root', 'sib-exact', 'sib-old']
      const dirs: Record<string, string> = {}
      for (const n of sibNames) {
        dirs[n] = path.join(root, n)
        fs.mkdirSync(dirs[n], { recursive: true })
      }
      writeConfig(dirs['current'], [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }])

      // sib-no-overlay: no overlay written → readOverlay returns null (BRDA:126,2,0)

      // sib-empty-patch: whitespace-only patch → !patch.trim() (BRDA:129,3,0)
      writeOverlay(dirs['sib-empty-patch'], {
        featureName: 'sib-empty-patch', agent: 'claude', capturedAt: '2026-01-01T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: headSha, patch: '  \n  ', touchedFiles: [] }],
      })

      // sib-no-repos: non-empty patch but FeatureConfig.repos is undefined → ?? right side + !decl (BRDA:130,5,1 + 131,6,0)
      writeOverlay(dirs['sib-no-repos'], {
        featureName: 'sib-no-repos', agent: 'claude', capturedAt: '2026-01-01T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: headSha, patch: 'not-blank', touchedFiles: [] }],
      })

      // sib-bad-root: decl exists but localPath is not a git repo → getGitRoot throws → root=null (BRDA:134,7,0)
      writeOverlay(dirs['sib-bad-root'], {
        featureName: 'sib-bad-root', agent: 'claude', capturedAt: '2026-01-01T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: headSha, patch: 'not-blank', touchedFiles: [] }],
      })

      // sib-exact: baseSha = HEAD → exact-match candidate; corrupt patch → applyOverlay non-ok (BRDA:314,28,1)
      writeOverlay(dirs['sib-exact'], {
        featureName: 'sib-exact', agent: 'claude', capturedAt: '2026-01-15T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: headSha, patch: 'this is not a valid diff', touchedFiles: [] }],
      })

      // sib-old: non-matching SHA → sort comparator returns non-zero when compared with sib-exact (BRDA:159,12,0)
      writeOverlay(dirs['sib-old'], {
        featureName: 'sib-old', agent: 'claude', capturedAt: '2026-01-01T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: 'dead1234dead1234dead1234dead1234dead1234', patch: 'this is not a valid diff', touchedFiles: [] }],
      })

      const allFeatures: FeatureConfig[] = [
        { name: 'current', description: 't', envs: ['local'], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['current'] },
        { name: 'sib-no-overlay', description: 't', envs: [], featureDir: dirs['sib-no-overlay'] },
        { name: 'sib-empty-patch', description: 't', envs: [], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['sib-empty-patch'] },
        { name: 'sib-no-repos', description: 't', envs: [], featureDir: dirs['sib-no-repos'] },
        { name: 'sib-bad-root', description: 't', envs: [], repos: [{ name: 'app', localPath: notGit }], featureDir: dirs['sib-bad-root'] },
        { name: 'sib-exact', description: 't', envs: [], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['sib-exact'] },
        { name: 'sib-old', description: 't', envs: [], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['sib-old'] },
      ]

      const { runner } = makeRunner('', logsDir, true, 'claude', () => allFeatures)
      const result = await runner.startExternalPortify({ feature: 'current', clientKind: 'claude', sessionId: 's1' })
      expect(result.workflowId).toMatch(/^portify-/)
      // corrupt patch → applyOverlay failed → no borrow seeded
      expect(result.instructions).not.toContain('PRE-APPLIED')
      await runner.cancel(result.workflowId)
    })

    it('pickBorrowable sort comparator falls through to date comparison when all candidate SHAs differ from HEAD', async () => {
      // Covers BRDA:159,12,1: both candidates have the same non-matching SHA → sort left side is 0
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-datesort-'))
      roots.push(root)
      const appRepo = path.join(root, 'app')
      const logsDir = path.join(root, 'logs')
      fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
      fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT ?? 3000\n')
      await gitInit(appRepo)

      const dirs: Record<string, string> = {}
      for (const n of ['current', 'sib-a', 'sib-b']) {
        dirs[n] = path.join(root, n)
        fs.mkdirSync(dirs[n], { recursive: true })
      }
      writeConfig(dirs['current'], [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }])

      const oldSha = 'dead1234dead1234dead1234dead1234dead1234'
      writeOverlay(dirs['sib-a'], {
        featureName: 'sib-a', agent: 'claude', capturedAt: '2026-02-01T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: oldSha, patch: 'not-a-valid-diff', touchedFiles: [] }],
      })
      writeOverlay(dirs['sib-b'], {
        featureName: 'sib-b', agent: 'claude', capturedAt: '2026-01-01T00:00:00.000Z',
        repos: [{ name: 'app', baseSha: oldSha, patch: 'not-a-valid-diff', touchedFiles: [] }],
      })

      const allFeatures: FeatureConfig[] = [
        { name: 'current', description: 't', envs: ['local'], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['current'] },
        { name: 'sib-a', description: 't', envs: [], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['sib-a'] },
        { name: 'sib-b', description: 't', envs: [], repos: [{ name: 'app', localPath: appRepo }], featureDir: dirs['sib-b'] },
      ]

      const { runner } = makeRunner('', logsDir, true, 'claude', () => allFeatures)
      const result = await runner.startExternalPortify({ feature: 'current', clientKind: 'claude', sessionId: 's1' })
      expect(result.workflowId).toMatch(/^portify-/)
      await runner.cancel(result.workflowId)
    })

    it('startExternalPortify 409s with the orchestrator error when startExternal returns failed with an error string', async () => {
      // Covers BRDA:449,46,0 (m.status !== editing → throw) and BRDA:451,47,0 (m.error is defined → used as message)
      const { featuresDir, logsDir } = await singleFixture()
      const { runner } = makeRunner(featuresDir, logsDir)
      vi.spyOn(PortifyOrchestrator.prototype, 'startExternal').mockResolvedValueOnce(
        { status: 'failed', error: 'git exploded' } as unknown as PortifyManifest,
      )
      const err = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
        .catch((e: unknown) => e as Error & { statusCode: number })
      expect(err.message).toBe('git exploded')
      expect(err.statusCode).toBe(409)
    })

    it('startExternalPortify 409s with the default message when startExternal returns non-editing without an error', async () => {
      // Covers BRDA:451,47,1: m.error is undefined → fallback string used
      const { featuresDir, logsDir } = await singleFixture()
      const { runner } = makeRunner(featuresDir, logsDir)
      vi.spyOn(PortifyOrchestrator.prototype, 'startExternal').mockResolvedValueOnce(
        { status: 'aborted' } as unknown as PortifyManifest,
      )
      const err = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
        .catch((e: unknown) => e as Error & { statusCode: number })
      expect(err.message).toBe('failed to set up the external port-ification worktree')
      expect(err.statusCode).toBe(409)
    })

    it('submitExternalPortify returns the in-flight manifest when the post-fire store read returns null', async () => {
      // Covers BRDA:487,52,1: store.get returns null after verifyExternalEdits is fired → ?? m fallback taken
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      await waitForStatus(store, result.workflowId, ['editing'])

      const real = store.get(result.workflowId)!
      const realGet = store.get.bind(store)
      vi.spyOn(store, 'get')
        .mockReturnValueOnce(real)      // line 471: existence guard
        .mockReturnValueOnce(undefined) // line 487: fallback taken → returns `m`
        .mockImplementation(realGet)

      const returned = await runner.submitExternalPortify(result.workflowId)
      expect(returned).toBe(real)

      await waitForStatus(store, result.workflowId, ['ready-to-save', 'editing', 'failed'])
      await runner.cancel(result.workflowId)
    })

    it('realpathOrSelf falls back to returning the original path when fs.realpathSync throws', async () => {
      // Covers runner.ts:617 catch { return p } — the defensive fallback for broken symlinks.
      // The first realpathSync call (repo-worktree.ts) succeeds; the second (realpathOrSelf) throws.
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)

      const originalRealpathSync = fs.realpathSync
      let realpathSyncCalls = 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(fs, 'realpathSync').mockImplementation((...args: any[]) => {
        realpathSyncCalls++
        // Call 1: require() inside loadFeatures; call 2: addWorktree (repo-worktree.ts).
        // Call 3 is realpathOrSelf (runner.ts:617) — throw there to trigger the catch fallback.
        if (realpathSyncCalls <= 2) return originalRealpathSync(args[0] as string, args[1])
        throw Object.assign(new Error('realpathSync failure'), { code: 'ENOENT' })
      })

      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      expect(result.workflowId).toMatch(/^portify-/)
      await runner.cancel(result.workflowId)
    })
  })
})
