import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import { loadFeatures } from '../../../../shared/feature-loader'
import { PortifyRunStore } from './store'
import { PortifyOrchestrator } from './orchestrator'
import { createPortifyRunner } from './runner'
import { runPortifyAgent } from './agent'
import { readOverlay, writeOverlay } from './overlay'
import type { PortifyManifest } from './types'
import { TERMINAL, defaultAgentEdit, envsetFixture, fakePtyFactory, findWorktreeEnvFiles, gitInit, makeRunner, roots, singleFixture, waitForStatus, writeConfig } from './__fixtures__/runner.part4-fixtures'

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
it('submitExternalPortify 409s with polling instructions while a canary-started double-boot is in flight', async () => {
      // Reached when a complete borrow left nothing to edit, so start kicked off
      // the verification itself. A bare status name would read to the client as
      // its own sequencing bug — the error has to name the poll instead.
      const { featuresDir, logsDir } = await singleFixture()
      const { store, runner } = makeRunner(featuresDir, logsDir)
      const result = await runner.startExternalPortify({ feature: 'myfeat', clientKind: 'claude', sessionId: 's1' })
      await waitForStatus(store, result.workflowId, ['editing'])
      store.save({ ...store.get(result.workflowId)!, status: 'verifying' })
      await expect(runner.submitExternalPortify(result.workflowId)).rejects.toThrow(/poll get_portify/)
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
      if (!(err instanceof Error)) throw new Error('expected startExternalPortify to reject with an Error')
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
      if (!(err instanceof Error)) throw new Error('expected startExternalPortify to reject with an Error')
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
        .mockReturnValueOnce(real) // line 471: existence guard
        .mockReturnValueOnce(null) // line 487: fallback taken → returns `m`
        .mockImplementation(realGet)

      const returned = await runner.submitExternalPortify(result.workflowId)
      expect(returned).toBe(real)

      await waitForStatus(store, result.workflowId, ['ready-to-save', 'editing', 'failed'])
      await runner.cancel(result.workflowId)
    })
it('envset hydration: worktree carries the captured envset during the double-boot, restored after', async () => {
      const { featuresDir, logsDir, checkedIn } = await envsetFixture('db=jdbc:mysql://localhost:3306/x\n')
      const seen: string[] = []
      const store = new PortifyRunStore(logsDir)
      const runner = createPortifyRunner({
        logsDir,
        store,
        ptyFactory: fakePtyFactory,
        loadFeatures: () => loadFeatures(featuresDir),
        pickAgent: () => 'claude',
        resolveModels: () => ({ model: null, effort: null }),
        now: () => '2026-06-07T00:00:00.000Z',
        // Observe the worktree copy WHILE the double-boot runs — the health
        // probe fires inside verifyDoubleBoot, i.e. inside the boot window.
        healthCheck: async () => {
          for (const f of findWorktreeEnvFiles(logsDir)) seen.push(fs.readFileSync(f, 'utf-8'))
          return true
        },
        healthPollIntervalMs: 5,
        healthDeadlineMs: 400,
      })

      const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')

      // The boots saw the CAPTURED content, not the checked-in bytes.
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((c) => c === 'db=jdbc:mysql://localhost:3306/x\n')).toBe(true)
      // After verify the worktree (kept until save/cancel) is byte-identical
      // to the checkout again — hydration must not survive the boot window.
      const after = findWorktreeEnvFiles(logsDir)
      expect(after.length).toBeGreaterThan(0)
      for (const f of after) expect(fs.readFileSync(f, 'utf-8')).toBe(checkedIn)
      await runner.cancel(workflowId)
    })
it("envset hydration: save()'s overlay patch carries the agent's edits but ZERO envset content", async () => {
      const { featuresDir, logsDir } = await envsetFixture('db=jdbc:mysql://localhost:3306/x\n')
      const { store, runner } = makeRunner(featuresDir, logsDir)

      const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('ready-to-save')
      await runner.save(workflowId)

      const overlay = readOverlay(path.join(featuresDir, 'myfeat'))!
      const patch = overlay.patches['app']
      expect(patch).toContain('port made injectable by agent')
      // The load-bearing regression: the overlay ships ports-only — the
      // hydrated envset must never leak into the captured diff.
      expect(patch).not.toContain('jdbc:mysql://localhost')
      expect(patch).not.toContain('app-local.properties')
    })
it('envset hydration: a failed verify hints when envset files carry unresolved ${port.*} tokens', async () => {
      const { featuresDir, logsDir } = await envsetFixture('url=http://localhost:${port.api}/\n')
      const { store, runner } = makeRunner(featuresDir, logsDir, /* healthy */ false)

      const { workflowId } = await runner.startPortify({ feature: 'myfeat', agent: 'claude', maxAttempts: 1 })
      expect(await waitForStatus(store, workflowId, TERMINAL)).toBe('failed')

      const detail = store.get(workflowId)!.verification?.failureDetail ?? ''
      expect(detail).toContain('UNRESOLVED')
      expect(detail).toContain('app-local.properties')
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
