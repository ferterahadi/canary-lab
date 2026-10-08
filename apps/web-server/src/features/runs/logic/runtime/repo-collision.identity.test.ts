import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { detectRepoCollision, normalizeRepoPaths } from './repo-collision'
import { RunScheduler } from './run-scheduler'
import { updateReposToUpstream } from './repo-upstream-update'
import * as git from '../../../../shared/git-repo'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-collision-identity-')
let root: string
let repo: string
let alias: string
beforeEach(() => {
  root = tempDir()
  repo = path.join(root, 'repo'); alias = path.join(root, 'alias')
  fs.mkdirSync(repo); fs.symlinkSync(repo, alias, 'dir')
})
afterEach(() => { vi.restoreAllMocks() })

it('deduplicates aliases in supplied order and reports the first conflicting run', () => {
  expect(normalizeRepoPaths([alias, root, repo, '', null as unknown as string])).toEqual([repo, root])
  expect(detectRepoCollision([repo], [
    { runId: 'first', feature: 'a', repoPaths: [alias] },
    { runId: 'second', feature: 'b', repoPaths: [repo] },
  ])).toEqual({ conflictingRunId: 'first', conflictingFeature: 'a', repoPaths: [repo] })
  expect(detectRepoCollision([root], [{ runId: 'first', feature: 'a', repoPaths: [alias] }])).toBeNull()
})

it('blocks alias admission and promotion until the recorded owner settles', async () => {
  const active = [{ runId: 'owner', feature: 'a', repoPaths: [alias], cost: 1 }]
  const scheduler = new RunScheduler({ listActive: () => active, readResources: () => ({ cpuCount: 16, freeMemBytes: 32 * 1024 ** 3 }), config: { maxConcurrentRuns: null, perRunMemBytes: 1024 ** 3 } })
  const launch = vi.fn(async () => {})
  scheduler.enqueue({ runId: 'queued', feature: 'b', repoPaths: [repo], cost: 1, reason: 'repo-collision', launch })
  expect(scheduler.fits({ repoPaths: [repo], cost: 1 })).toEqual({ ok: false, reason: 'repo-collision' })
  expect(scheduler.diagnostics('queued')).toMatchObject({ reason: 'repo-collision', conflictingRunId: 'owner' })
  await scheduler.promote()
  expect(launch).not.toHaveBeenCalled()
  active.splice(0)
  expect(scheduler.diagnostics('queued')).toMatchObject({ reason: 'ready' })
  await scheduler.promote()
  expect(launch).toHaveBeenCalledTimes(1)
  expect(scheduler.queued()).toEqual([])
})

it('refuses an upstream update through an occupied alias before any Git command', async () => {
  const commands = vi.spyOn(git, 'runGit')
  await expect(updateReposToUpstream({ name: 'b', description: '', envs: [], featureDir: root, repos: [{ name: 'app', localPath: alias }] }, true, {
    inUseBy: (candidate) => detectRepoCollision([candidate], [{ runId: 'owner', feature: 'a', repoPaths: [repo] }])?.conflictingRunId ?? null,
  })).rejects.toMatchObject({ statusCode: 409, repoUpdate: [{ name: 'app', path: alias, reason: 'in-use' }] })
  expect(commands).not.toHaveBeenCalled()
})
