import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../../git-repo'
import { PortifyRunStore } from './store'
import { buildPortifyPaths, portifyDir } from './paths'
import { createBranchAndWorktree } from './git-ops'
import { reclaimOrphanedPortify } from './reclaim'
import type { PortifyManifest } from './types'

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
})

async function fixture(): Promise<{ logsDir: string; featureDir: string; appRepo: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-reclaim-'))
  roots.push(root)
  const logsDir = path.join(root, 'logs')
  const featureDir = path.join(root, 'features', 'myfeat')
  const appRepo = path.join(root, 'app')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(appRepo, { recursive: true })
  fs.writeFileSync(path.join(appRepo, 'app.js'), 'const PORT = 3007\n')
  await runGit(appRepo, ['init', '-q'])
  await runGit(appRepo, ['config', 'user.email', 't@t'])
  await runGit(appRepo, ['config', 'user.name', 'test'])
  await runGit(appRepo, ['add', '-A'])
  await runGit(appRepo, ['commit', '-q', '-m', 'init', '--no-verify'])
  // Feature config left in an "agent-edited" state on disk.
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'EDITED BY AGENT\n')
  return { logsDir, featureDir, appRepo }
}

function manifest(over: Partial<PortifyManifest>): PortifyManifest {
  return {
    workflowId: 'portify-orphan',
    feature: 'myfeat',
    featureDir: '/x',
    repos: [],
    agent: 'claude',
    branch: 'canary/dynamic-ports-myfeat',
    status: 'editing',
    attempt: 1,
    maxAttempts: 3,
    startedAt: '2026-06-07T00:00:00.000Z',
    ...over,
  }
}

describe('reclaimOrphanedPortify', () => {
  it('removes the orphaned worktree + branch, restores the config, and flips to aborted', async () => {
    const { logsDir, featureDir, appRepo } = await fixture()
    const store = new PortifyRunStore(logsDir)
    const id = 'portify-orphan'

    // Simulate a workflow that created a real branch + worktree, then crashed.
    const wt = await createBranchAndWorktree({
      repoName: 'app', localPath: appRepo,
      worktreesDir: portifyDir(logsDir, id) + '/worktrees',
      branch: 'canary/dynamic-ports-myfeat',
    })
    roots.push(wt.handle.worktreeRoot)
    // Persisted snapshot of the pre-edit config.
    const { originalConfigPath } = buildPortifyPaths(portifyDir(logsDir, id))
    fs.mkdirSync(path.dirname(originalConfigPath), { recursive: true })
    fs.writeFileSync(originalConfigPath, 'ORIGINAL\n')
    store.save(manifest({ workflowId: id, featureDir, repos: [{ name: 'app', path: appRepo, worktreePath: wt.handle.worktreeRoot }] }))

    await reclaimOrphanedPortify(store, logsDir, () => '2026-06-07T01:00:00.000Z')

    expect(fs.existsSync(wt.handle.worktreeRoot)).toBe(false)
    const branches = await runGit(appRepo, ['branch', '--list', 'canary/dynamic-ports-myfeat'])
    expect(branches.stdout.trim()).toBe('')
    expect(fs.readFileSync(path.join(featureDir, 'feature.config.cjs'), 'utf-8')).toBe('ORIGINAL\n')
    expect(store.get(id)?.status).toBe('aborted')
    expect(store.get(id)?.error).toContain('Interrupted by server restart')
  })

  it('leaves terminal workflows untouched', async () => {
    const { logsDir } = await fixture()
    const store = new PortifyRunStore(logsDir)
    store.save(manifest({ workflowId: 'done', status: 'saved' }))
    await reclaimOrphanedPortify(store, logsDir, () => 'x')
    expect(store.get('done')?.status).toBe('saved')
  })

  it('is best-effort when a repo no longer resolves to a git root', async () => {
    const { logsDir, featureDir } = await fixture()
    const store = new PortifyRunStore(logsDir)
    store.save(manifest({
      workflowId: 'gone', featureDir,
      repos: [{ name: 'app', path: '/no/such/repo', worktreePath: '/no/such/repo/wt' }],
    }))
    await expect(reclaimOrphanedPortify(store, logsDir, () => 'x')).resolves.toBeUndefined()
    expect(store.get('gone')?.status).toBe('aborted')
  })

  it('skips an index entry whose manifest is missing', async () => {
    const { logsDir } = await fixture()
    const store = new PortifyRunStore(logsDir)
    store.save(manifest({ workflowId: 'a', status: 'editing' }))
    fs.rmSync(path.join(logsDir, 'portify', 'a', 'portify.json'))
    await expect(reclaimOrphanedPortify(store, logsDir, () => 'x')).resolves.toBeUndefined()
  })

  it('skips repos without a worktreePath and dedupes shared worktree paths', async () => {
    const { logsDir, featureDir } = await fixture()
    const store = new PortifyRunStore(logsDir)
    // First repo has no worktreePath (skipped); next two share one path (deduped).
    store.save(manifest({
      workflowId: 'dup', featureDir,
      repos: [
        { name: 'no-wt', path: '/no/such/repo' },
        { name: 'a', path: '/no/such/repo', worktreePath: '/no/such/wt' },
        { name: 'b', path: '/no/such/repo', worktreePath: '/no/such/wt' },
      ],
    }))
    await expect(reclaimOrphanedPortify(store, logsDir, () => 'x')).resolves.toBeUndefined()
    expect(store.get('dup')?.status).toBe('aborted')
  })

  it('flips to aborted even when there is no config snapshot to restore', async () => {
    const { logsDir, featureDir } = await fixture()
    const store = new PortifyRunStore(logsDir)
    // No original-config.snapshot written → the restore step is skipped.
    store.save(manifest({ workflowId: 'nosnap', featureDir, repos: [] }))
    await reclaimOrphanedPortify(store, logsDir, () => '2026-06-07T01:00:00.000Z')
    expect(store.get('nosnap')?.status).toBe('aborted')
  })
})
