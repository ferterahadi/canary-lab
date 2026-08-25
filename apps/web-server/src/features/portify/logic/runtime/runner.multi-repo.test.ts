import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import { loadFeatures } from '../../../../shared/feature-loader'
import { PortifyRunStore } from './store'
import { createPortifyRunner, portifyConcurrencyCap, safeKey } from './runner'
import { runPortifyAgent } from './agent'
import { readOverlay } from './overlay'
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

function readyManifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'w', feature: 'f', featureDir: '/f', repos: [], agent: 'claude',
    branch: 'b', status: 'ready-to-save', attempt: 1, maxAttempts: 3, startedAt: 'now', ...over,
  }
}

describe('createPortifyRunner (integration)', () => {
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
    it('names ALL dirty repos in one error, not just the first', async () => {
      const a = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-dirty-a-'))
      const b = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-dirty-b-'))
      roots.push(a, b)
      for (const dir of [a, b]) {
        fs.writeFileSync(path.join(dir, 'f.txt'), 'a')
        await gitInit(dir)
        fs.writeFileSync(path.join(dir, 'f.txt'), 'changed') // now dirty
      }
      const runner = await runnerWith([feat({ repos: [{ name: 'ra', localPath: a }, { name: 'rb', localPath: b }] })])
      await expect(runner.startPortify({ feature: 'myfeat' }))
        .rejects.toThrow(/repos "ra", "rb" have uncommitted changes/)
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

    it('remove still clears an orphaned row whose record dir was wiped (status from the index)', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-rmorphan-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save(readyManifest({ status: 'failed', endedAt: 'now' }))
      // Wipe the record dir out-of-band — the index row lingers, get() now 404s.
      fs.rmSync(path.join(logsDir, 'portify', 'w'), { recursive: true, force: true })
      expect(store.get('w')).toBeNull()
      expect(store.list().map((e) => e.workflowId)).toEqual(['w'])
      expect(await runner.remove('w')).toEqual({ workflowId: 'w', removed: true })
      expect(store.list()).toEqual([])
    })
  })
})

describe('portifyConcurrencyCap', () => {
  it('returns the parsed env var when CANARY_MAX_CONCURRENT_PORTIFY is a positive integer', () => {
    expect(portifyConcurrencyCap({ CANARY_MAX_CONCURRENT_PORTIFY: '3' })).toBe(3)
  })

  it('falls back to computeSlotBudget when env var is absent', () => {
    const cap = portifyConcurrencyCap({})
    expect(typeof cap).toBe('number')
    expect(cap).toBeGreaterThan(0)
  })

  it('falls back to computeSlotBudget when env var is whitespace', () => {
    const cap = portifyConcurrencyCap({ CANARY_MAX_CONCURRENT_PORTIFY: '   ' })
    expect(typeof cap).toBe('number')
    expect(cap).toBeGreaterThan(0)
  })

  it('falls back to computeSlotBudget when env var is not a finite positive number', () => {
    expect(portifyConcurrencyCap({ CANARY_MAX_CONCURRENT_PORTIFY: 'abc' })).toBeGreaterThan(0)
    expect(portifyConcurrencyCap({ CANARY_MAX_CONCURRENT_PORTIFY: '0' })).toBeGreaterThan(0)
    expect(portifyConcurrencyCap({ CANARY_MAX_CONCURRENT_PORTIFY: '-1' })).toBeGreaterThan(0)
  })
})

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
})
