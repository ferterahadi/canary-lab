import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyFactory, PtyHandle } from '../../../../runs/logic/runtime/pty-spawner'
import type { FeatureConfig } from '../../../../../../../../shared/launcher/types'
import { runGit } from '../../../../../shared/git-repo'
import { loadFeatures } from '../../../../../shared/feature-loader'
import { PortifyRunStore } from '../store'
import { createPortifyRunner, portifyConcurrencyCap, safeKey } from '../runner'

// Default mocked-agent behavior: edit a source file in the worktree so there's
// something to commit. Also register a fake child in the set the real agent
// would populate, so abort()'s child-kill loop is exercised on cancel. Tests
// can override per-case (e.g. the retry case).
export async function defaultAgentEdit(opts: { cwd: string; children?: Set<unknown> }): Promise<void> {
  opts.children?.add({ kill: () => {} })
  try {
    fs.mkdirSync(path.join(opts.cwd, 'src'), { recursive: true })
    fs.appendFileSync(path.join(opts.cwd, 'src', 'server.js'), '\n// port made injectable by agent\n')
  } catch { /* best-effort */ }
}

export const fakePtyFactory: PtyFactory = (): PtyHandle => ({
  pid: 9_999_998,
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

export function repoStartCommand(name: string, slot: string, env: string, withPorts: boolean): string {
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

export function buildConfigSource(repos: { name: string; localPath: string; slot: string; env: string }[], withPorts: boolean, name = 'myfeat', envs: string[] = ['local']): string {
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

export function writeConfig(
  featureDir: string,
  repos: { name: string; localPath: string; slot: string; env: string }[],
  opts: { ext?: 'cjs' | 'js'; withPorts?: boolean; name?: string; envs?: string[] } = {},
): void {
  fs.writeFileSync(
    path.join(featureDir, `feature.config.${opts.ext ?? 'cjs'}`),
    buildConfigSource(repos, opts.withPorts ?? true, opts.name, opts.envs),
  )
}

export function makeRunner(
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
    resolveModels: () => ({ model: null, effort: null }),
    now: () => '2026-06-07T00:00:00.000Z',
    healthCheck: async () => healthy,
    healthPollIntervalMs: 5,
    healthDeadlineMs: healthy ? 400 : 40,
  })
  return { store, runner }
}

export async function waitForStatus(store: PortifyRunStore, id: string, until: string[], timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const m = store.get(id)
    if (m && until.includes(m.status)) return m.status
    await new Promise((r) => setTimeout(r, 25))
  }
  return store.get(id)?.status ?? 'missing'
}

export const TERMINAL = ['ready-to-save', 'failed', 'aborted']

// Single-repo fixture (the common case).
export async function singleFixture(): Promise<{ featuresDir: string; logsDir: string; appRepo: string }> {
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

// singleFixture + a captured envset whose slot targets a CHECKED-IN repo config
// file with different content (the real-world shape: docker `db` host committed,
// `localhost` captured). Exercises the verify-time worktree hydration.
export async function envsetFixture(slotContent: string): Promise<{
  featuresDir: string; logsDir: string; appRepo: string; checkedIn: string
}> {
  const { featuresDir, logsDir, appRepo } = await singleFixture()
  const checkedIn = 'db=jdbc:mysql://db:3306/x\n'
  fs.mkdirSync(path.join(appRepo, 'config'), { recursive: true })
  fs.writeFileSync(path.join(appRepo, 'config', 'app-local.properties'), checkedIn)
  await runGit(appRepo, ['add', '-A'])
  await runGit(appRepo, ['commit', '-q', '-m', 'config', '--no-verify'])
  const featureDir = path.join(featuresDir, 'myfeat')
  const setDir = path.join(featureDir, 'envsets', 'local')
  fs.mkdirSync(setDir, { recursive: true })
  fs.writeFileSync(
    path.join(featureDir, 'envsets', 'envsets.config.json'),
    JSON.stringify({
      appRoots: {},
      slots: {
        'app-local.properties': {
          description: 'captured',
          target: path.join(appRepo, 'config', 'app-local.properties'),
        },
      },
      feature: { slots: ['app-local.properties'], testCommand: 'true', testCwd: featureDir },
    }),
  )
  fs.writeFileSync(path.join(setDir, 'app-local.properties'), slotContent)
  return { featuresDir, logsDir, appRepo, checkedIn }
}

/** Every scratch-worktree copy of the envset-targeted config file. */
export function findWorktreeEnvFiles(logsDir: string): string[] {
  const base = path.join(logsDir, 'portify')
  if (!fs.existsSync(base)) return []
  const out: string[] = []
  for (const wf of fs.readdirSync(base)) {
    const wtDir = path.join(base, wf, 'worktrees')
    if (!fs.existsSync(wtDir)) continue
    for (const g of fs.readdirSync(wtDir)) {
      const f = path.join(wtDir, g, 'config', 'app-local.properties')
      if (fs.existsSync(f)) out.push(f)
    }
  }
  return out
}

// Two independent features, each with its own single-repo git root. Used to
// prove the lock is keyed per FEATURE: different features port-ify concurrently.
export async function twoFeatureFixture(): Promise<{ featuresDir: string; logsDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-two-'))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const logsDir = path.join(root, 'logs')
  for (const name of ['featA', 'featB']) {
    const featureDir = path.join(featuresDir, name)
    const appRepo = path.join(root, `${name}-app`)
    fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true })
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(appRepo, 'src', 'server.js'), 'const PORT = process.env.PORT ?? 3007\n')
    await gitInit(appRepo)
    writeConfig(featureDir, [{ name: 'app', localPath: appRepo, slot: 'api', env: 'PORT' }], { name })
  }
  return { featuresDir, logsDir }
}
