import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig, RepoPrerequisite } from '../../../../../../../../shared/launcher/types'
import { runGit } from '../../../../../shared/git-repo'
import { createBenchmarkRunner, type BenchmarkRunnerDeps } from '../runner'
import { BenchmarkRunStore } from '../store'
import type { StartBenchmarkInput } from '../types'

export const fakePtyFactory: PtyFactory = (): PtyHandle => ({
  pid: 9_999_997,
  onData: () => ({ dispose: () => {} }),
  onExit: () => ({ dispose: () => {} }),
  write: () => {},
  resize: () => {},
  kill: () => {},
})

export const roots: string[] = []

export async function gitInit(dir: string): Promise<void> {
  await runGit(dir, ['init', '-q'])
  await runGit(dir, ['config', 'user.email', 't@t'])
  await runGit(dir, ['config', 'user.name', 'test'])
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['commit', '-q', '-m', 'init', '--no-verify'])
}

export async function pollUntil(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return check()
}

export async function waitForStatus(store: BenchmarkRunStore, id: string, until: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = store.get(id)
    if (m && until.includes(m.status)) return m.status
    await new Promise((r) => setTimeout(r, 20))
  }
  return store.get(id)?.status ?? 'missing'
}

// Self-contained layout: repo.localPath IS the git root (featureSub === '' in
// sabotage's runSabotageAgent — the ": wtRoot" ternary arm).
export async function flatFixture(): Promise<{ root: string; appRepo: string; logsDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-flat-'))
  roots.push(root)
  const appRepo = path.join(root, 'app')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(appRepo, { recursive: true })
  fs.writeFileSync(path.join(appRepo, 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
  await gitInit(appRepo)
  return { root, appRepo, logsDir }
}

// Nested layout: repo.localPath is a SUBDIRECTORY of the git root (featureSub
// is non-empty — the "path.join(wtRoot, featureSub)" ternary arm), and the git
// root also carries a node_modules dir so linkNodeModules takes its symlink
// branch (fs.existsSync(src) true).
export async function nestedFixture(): Promise<{ root: string; gitRoot: string; appDir: string; logsDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-nested-'))
  roots.push(root)
  const gitRoot = path.join(root, 'mono')
  const appDir = path.join(gitRoot, 'app')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
  await gitInit(gitRoot)
  // Created AFTER the commit so it stays untracked (real node_modules is
  // gitignored) — a `git worktree add` checkout of this repo will NOT bring
  // it along, so linkNodeModules's symlink branch actually has work to do.
  fs.mkdirSync(path.join(gitRoot, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(gitRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = {}\n')
  return { root, gitRoot, appDir, logsDir }
}

export function feat(over: Partial<FeatureConfig> & { repos?: RepoPrerequisite[] } = {}): FeatureConfig {
  return {
    name: 'bench-feat',
    description: 'd',
    envs: ['local'],
    featureDir: '/f',
    repos: [{ name: 'app', localPath: '/f' }],
    ...over,
  } as FeatureConfig
}

export function makeDeps(opts: {
  logsDir: string
  loadFeatures: () => FeatureConfig[]
  pickAgent?: (preferred?: 'claude' | 'codex') => 'claude' | 'codex' | null
  applyFeatureEnvset?: BenchmarkRunnerDeps['applyFeatureEnvset']
}): { store: BenchmarkRunStore; deps: BenchmarkRunnerDeps; registry: { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }; attachRunStreams: ReturnType<typeof vi.fn>; allocateRunPorts: ReturnType<typeof vi.fn> } {
  const store = new BenchmarkRunStore(opts.logsDir)
  const registry = { set: vi.fn(), delete: vi.fn() }
  const attachRunStreams = vi.fn()
  const allocateRunPorts = vi.fn(async () => undefined)
  const deps: BenchmarkRunnerDeps = {
    projectRoot: opts.logsDir,
    logsDir: opts.logsDir,
    store,
    ptyFactory: fakePtyFactory,
    runStore: {},
    registry,
    scheduler: { fits: () => ({ ok: true }) },
    attachRunStreams,
    allocateRunPorts,
    applyFeatureEnvset: opts.applyFeatureEnvset ?? vi.fn(),
    loadFeatures: opts.loadFeatures,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pickAgent: (opts.pickAgent ?? ((preferred?: 'claude' | 'codex') => preferred ?? 'claude')) as any,
    now: () => '2026-06-07T00:00:00.000Z',
  }
  return { store, deps, registry, attachRunStreams, allocateRunPorts }
}

export const OFF_BY_ONE: Pick<StartBenchmarkInput, 'skill' | 'level'> = { skill: 'off-by-one', level: 'min' }
