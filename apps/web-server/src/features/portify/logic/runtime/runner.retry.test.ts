import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import { loadFeatures } from '../../../../shared/feature-loader'
import { PortifyRunStore } from './store'
import { createPortifyRunner } from './runner'
import { runPortifyAgent } from './agent'
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

describe('createPortifyRunner (branch coverage)', () => {
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
})
