import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FlightManifest } from '../../../../../../shared/flights/types'
import { applyFlightStageRemedy, flightStageRemedy } from './stage-remedy'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a')
  git(dir, 'init')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  return dir
}

function dirtyRepo(prefix: string): string {
  const dir = makeRepo(prefix)
  fs.writeFileSync(path.join(dir, 'f.txt'), 'changed')
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked')
  return dir
}

function manifestWith(repoPaths: string[], error?: string): FlightManifest {
  return {
    flightId: 'fl_test', feature: 'feat', repoPaths, description: 'd',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'paused', pauseReason: 'stage-failed', currentStage: 'portify',
    stages: [
      { key: 'repo-scan', status: 'done' },
      { key: 'portify', status: 'failed', ...(error !== undefined ? { error } : {}) },
    ],
    createdAt: 'now', updatedAt: 'now',
  } as FlightManifest
}

const DIRTY_ERROR = 'portify start rejected (409): repos "a", "b" have uncommitted changes — commit or stash them first'

describe('flightStageRemedy', () => {
  it('null when no failed stage matches the signature', async () => {
    expect(await flightStageRemedy(manifestWith([dirtyRepo('remedy-x-')], 'agent timed out'))).toBeNull()
    expect(await flightStageRemedy(manifestWith([dirtyRepo('remedy-y-')]))).toBeNull()
  })

  it('lists every currently-dirty repo with its modified count', async () => {
    const clean = makeRepo('remedy-clean-')
    const dirty = dirtyRepo('remedy-dirty-')
    const remedy = await flightStageRemedy(manifestWith([clean, dirty], DIRTY_ERROR))
    expect(remedy).toMatchObject({ kind: 'dirty-repos', stage: 'portify', actions: ['stash', 'commit'] })
    expect(remedy!.repos).toEqual([{ name: path.basename(dirty), path: dirty, modified: 2 }])
  })

  it('empty repos list once everything is clean again (self-heals from a stale error)', async () => {
    const remedy = await flightStageRemedy(manifestWith([makeRepo('remedy-healed-')], DIRTY_ERROR))
    expect(remedy!.repos).toEqual([])
  })

  it('skips paths that are not git repos instead of failing', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'remedy-plain-'))
    roots.push(plain)
    const remedy = await flightStageRemedy(manifestWith([plain], DIRTY_ERROR))
    expect(remedy!.repos).toEqual([])
  })
})

describe('applyFlightStageRemedy', () => {
  it('stash cleans every dirty repo (untracked included) and is git-undoable', async () => {
    const a = dirtyRepo('remedy-stash-a-')
    const b = dirtyRepo('remedy-stash-b-')
    const result = await applyFlightStageRemedy(manifestWith([a, b], DIRTY_ERROR), 'stash')
    expect(result).toEqual({ action: 'stash', cleaned: [a, b] })
    for (const dir of [a, b]) {
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()).toBe('')
      expect(execFileSync('git', ['stash', 'list'], { cwd: dir }).toString()).toContain('canary-lab: pre-flight stash')
    }
  })

  it('commit cleans the repo with the wip message', async () => {
    const a = dirtyRepo('remedy-commit-a-')
    const result = await applyFlightStageRemedy(manifestWith([a], DIRTY_ERROR), 'commit')
    expect(result.cleaned).toEqual([a])
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: a }).toString().trim()).toBe('')
    expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: a }).toString().trim()).toBe('canary-lab: wip')
  })

  it('commit works with no git identity configured — like init, the remedy is unattended', async () => {
    const a = dirtyRepo('remedy-commit-noid-')
    // Empty strings shadow any real global identity for this repo only, the
    // state a machine that never ran `git config --global user.email` is in.
    execFileSync('git', ['config', 'user.email', ''], { cwd: a, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', ''], { cwd: a, stdio: 'ignore' })

    const result = await applyFlightStageRemedy(manifestWith([a], DIRTY_ERROR), 'commit')

    expect(result.cleaned).toEqual([a])
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: a }).toString().trim()).toBe('')
  })

  // A feature repo is often a SUBDIRECTORY of a much larger git root — the
  // demo storefront's services sit beside `features/` in one workspace repo.
  // Both the remedy's own count and portify's gate are scoped with `-- .`, so
  // the sweep has to be too, or a button reading "2 modified" quietly commits
  // every unrelated dirty file in the workspace.
  function nestedRepo(prefix: string): { root: string; service: string } {
    const root = makeRepo(prefix)
    const service = path.join(root, 'demo-app', 'checkout-service')
    fs.mkdirSync(service, { recursive: true })
    fs.writeFileSync(path.join(service, 'server.ts'), 'v1')
    fs.writeFileSync(path.join(root, 'sibling.txt'), 'committed')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'nested baseline')
    // Dirty on BOTH sides of the pathspec.
    fs.writeFileSync(path.join(service, 'server.ts'), 'v2')
    fs.writeFileSync(path.join(service, 'untracked.ts'), 'new')
    fs.writeFileSync(path.join(root, 'sibling.txt'), 'unrelated edit')
    fs.writeFileSync(path.join(root, 'sibling-new.txt'), 'unrelated new')
    return { root, service }
  }

  const siblingState = (root: string): string =>
    execFileSync('git', ['status', '--porcelain', '--', 'sibling.txt', 'sibling-new.txt'], { cwd: root })
      .toString().trim()

  it('stash touches only the feature repo, not the rest of its git root', async () => {
    const { root, service } = nestedRepo('remedy-nested-stash-')
    const before = siblingState(root)
    await applyFlightStageRemedy(manifestWith([service], DIRTY_ERROR), 'stash')
    expect(execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: service }).toString().trim()).toBe('')
    expect(siblingState(root)).toBe(before)
  })

  it('commit records only the feature repo, leaving unrelated dirt alone', async () => {
    const { root, service } = nestedRepo('remedy-nested-commit-')
    const before = siblingState(root)
    await applyFlightStageRemedy(manifestWith([service], DIRTY_ERROR), 'commit')
    expect(execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: service }).toString().trim()).toBe('')
    expect(siblingState(root)).toBe(before)
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root }).toString()
    expect(committed).toContain('demo-app/checkout-service/untracked.ts')
    expect(committed).not.toContain('sibling')
  })

  it('409s when no remedy applies', async () => {
    await expect(applyFlightStageRemedy(manifestWith([makeRepo('remedy-none-')], 'agent timed out'), 'stash'))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})
