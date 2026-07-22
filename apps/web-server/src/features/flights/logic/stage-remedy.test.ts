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

  it('409s when no remedy applies', async () => {
    await expect(applyFlightStageRemedy(manifestWith([makeRepo('remedy-none-')], 'agent timed out'), 'stash'))
      .rejects.toMatchObject({ statusCode: 409 })
  })
})
