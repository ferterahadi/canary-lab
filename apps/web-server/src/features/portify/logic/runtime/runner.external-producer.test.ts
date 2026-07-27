import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGit } from '../../../../shared/git-repo'
import { createPortifyRunner } from './runner'
import { runPortifyAgent } from './agent'
import { overlayExists, readOverlay, writeOverlay } from './overlay'
import type { PortifyManifest } from './types'
import { defaultAgentEdit, gitInit, makeRunner, roots, singleFixture, twoFeatureFixture, waitForStatus } from './__fixtures__/runner.part4-fixtures'

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
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') })
  // Reset the agent mock to the default each test (cases may override it).
  vi.mocked(runPortifyAgent).mockImplementation(defaultAgentEdit as typeof runPortifyAgent)
})

afterEach(() => { vi.restoreAllMocks() })

afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

describe('createPortifyRunner (branch coverage)', () => {
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
it('enforces one workflow PER FEATURE across local + external', async () => {
      const { featuresDir, logsDir } = await singleFixture()
      const { runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      await expect(
        runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's2' }),
      ).rejects.toMatchObject({ statusCode: 409 })
      await expect(runner.startPortify({ feature: 'myfeat' })).rejects.toMatchObject({ statusCode: 409 })
      await runner.cancel(result.workflowId)
    })
it('allows DIFFERENT features to port-ify concurrently (lock is per-feature)', async () => {
      // Force cap ≥ 2 so low-core CI machines don't reject the second feature.
      const prev = process.env.CANARY_MAX_CONCURRENT_PORTIFY
      process.env.CANARY_MAX_CONCURRENT_PORTIFY = '4'
      try {
        const { featuresDir, logsDir } = await twoFeatureFixture()
        const { store, runner } = makeRunner(featuresDir, logsDir)
        const a = await runner.startExternalPortify({ feature: 'featA', clientKind: 'claude', sessionId: 'a' })
        // featB must NOT bounce on featA's workflow — different feature, same machine.
        const b = await runner.startExternalPortify({ feature: 'featB', clientKind: 'claude', sessionId: 'b' })
        expect(await waitForStatus(store, a.workflowId, ['editing'])).toBe('editing')
        expect(await waitForStatus(store, b.workflowId, ['editing'])).toBe('editing')
        await runner.cancel(a.workflowId)
        await runner.cancel(b.workflowId)
      } finally {
        if (prev === undefined) delete process.env.CANARY_MAX_CONCURRENT_PORTIFY
        else process.env.CANARY_MAX_CONCURRENT_PORTIFY = prev
      }
    })
it('returns 429 once the concurrency cap is reached', async () => {
      const prev = process.env.CANARY_MAX_CONCURRENT_PORTIFY
      process.env.CANARY_MAX_CONCURRENT_PORTIFY = '1'
      try {
        const { featuresDir, logsDir } = await twoFeatureFixture()
        const { runner } = makeRunner(featuresDir, logsDir)
        const a = await runner.startExternalPortify({ feature: 'featA', clientKind: 'claude', sessionId: 'a' })
        // Cap is 1 and featA holds the only slot → a DIFFERENT feature hits 429.
        await expect(
          runner.startExternalPortify({ feature: 'featB', clientKind: 'claude', sessionId: 'b' }),
        ).rejects.toMatchObject({ statusCode: 429 })
        await runner.cancel(a.workflowId)
        // Slot freed → featB is admitted.
        const b = await runner.startExternalPortify({ feature: 'featB', clientKind: 'claude', sessionId: 'b' })
        expect(b.workflowId).toBeTruthy()
        await runner.cancel(b.workflowId)
      } finally {
        if (prev === undefined) delete process.env.CANARY_MAX_CONCURRENT_PORTIFY
        else process.env.CANARY_MAX_CONCURRENT_PORTIFY = prev
      }
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
  })
})
