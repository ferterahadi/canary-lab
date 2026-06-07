import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../pty-spawner'
import type { FeatureConfig } from '../../../../../shared/launcher/types'
import { runGit } from '../../git-repo'
import { loadFeatures } from '../../feature-loader'
import { PortifyRunStore } from './store'
import { createPortifyRunner } from './runner'

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

// Block the REAL process.kill: verification teardown calls process.kill(-pid),
// and a fake pid must never signal a real process group.
beforeEach(() => { vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') }) })
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

function repoStartCommand(name: string, slot: string, env: string): string {
  return (
    `    {\n` +
    `      command: 'node src/server.js',\n` +
    `      name: ${JSON.stringify(name)},\n` +
    `      ports: [{ name: ${JSON.stringify(slot)}, env: ${JSON.stringify(env)} }],\n` +
    `      healthCheck: { http: { url: 'http://localhost:\${port.${slot}}/', timeoutMs: 30, deadlineMs: 250 } },\n` +
    `    }`
  )
}

function writeConfig(featureDir: string, repos: { name: string; localPath: string; slot: string; env: string }[]): void {
  const reposSrc = repos.map((r) =>
    `  {\n` +
    `    name: ${JSON.stringify(r.name)},\n` +
    `    localPath: ${JSON.stringify(r.localPath)},\n` +
    `    startCommands: [\n${repoStartCommand(r.name, r.slot, r.env)}\n    ],\n` +
    `  }`,
  ).join(',\n')
  const cfg =
    `const config = {\n` +
    `  name: 'myfeat',\n  description: 'test',\n  envs: ['local'],\n` +
    `  repos: [\n${reposSrc}\n  ],\n  featureDir: __dirname,\n}\n` +
    `module.exports = { config }\n`
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), cfg)
}

function makeRunner(featuresDir: string, logsDir: string, healthy = true) {
  const store = new PortifyRunStore(logsDir)
  const runner = createPortifyRunner({
    logsDir,
    store,
    ptyFactory: fakePtyFactory,
    loadFeatures: () => loadFeatures(featuresDir),
    pickAgent: () => 'claude',
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

const TERMINAL = ['ready-to-commit', 'failed', 'aborted']

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
  it('runs to ready-to-commit, then commits a branch in the repo', async () => {
    const { featuresDir, logsDir, appRepo } = await singleFixture()
    const { store, runner } = makeRunner(featuresDir, logsDir)

    const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
    expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-commit')

    const ready = store.get(workflowId)!
    expect(ready.verification?.ok).toBe(true)
    expect(ready.verification?.instances).toHaveLength(2)
    expect(ready.diff).toContain('port made injectable by agent')

    const committed = await runner.commit(workflowId)
    expect(committed.status).toBe('committed')
    expect(committed.repos.find((r) => r.name === 'app')?.commitSha).toMatch(/^[0-9a-f]{7,}$/)
    const branches = await runGit(appRepo, ['branch', '--list', committed.branch])
    expect(branches.stdout).toContain('canary/dynamic-ports-myfeat')
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
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-commit')
      // Two distinct worktree paths recorded (one per root).
      const ready = store.get(workflowId)!
      const wts = new Set(ready.repos.map((r) => r.worktreePath))
      expect(wts.size).toBe(2)
      const committed = await runner.commit(workflowId)
      expect(committed.status).toBe('committed')
      // The edited group (cwd = first group) committed; the other had no edit.
      expect(committed.repos.some((r) => r.commitSha)).toBe(true)
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
      // Grouping fixes it: one worktree, no clash → reaches ready-to-commit.
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-commit')
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
  })

  describe('commit / cancel guards', () => {
    it('commit 404s for an unknown workflow', async () => {
      const { runner } = makeRunner(path.join(os.tmpdir(), 'nope-f'), fs.mkdtempSync(path.join(os.tmpdir(), 'portify-c-')))
      await expect(runner.commit('nope')).rejects.toMatchObject({ statusCode: 404 })
    })
    it('commit 409s when the workflow is not ready-to-commit', async () => {
      const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-nr-'))
      roots.push(logsDir)
      const { store, runner } = makeRunner('x', logsDir)
      store.save({
        workflowId: 'w', feature: 'f', featureDir: '/f', repos: [], agent: 'claude',
        branch: 'b', status: 'editing', attempt: 1, maxAttempts: 3, startedAt: 'now',
      })
      await expect(runner.commit('w')).rejects.toMatchObject({ statusCode: 409 })
    })
    it('cancel 404s for an unknown workflow', async () => {
      const { runner } = makeRunner('x', fs.mkdtempSync(path.join(os.tmpdir(), 'portify-cc-')))
      await expect(runner.cancel('nope')).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
