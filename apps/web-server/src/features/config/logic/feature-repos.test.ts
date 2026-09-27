import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { checkoutFeatureRepo, readFeatureRepo, updateFeatureRepo } from './feature-repos'

let root: string
let featuresDir: string
let repoDir: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-feature-repos-'))
  featuresDir = path.join(root, 'features')
  repoDir = path.join(root, 'repo')
  const suite = path.join(featuresDir, 'old-folder')
  fs.mkdirSync(suite, { recursive: true }); fs.mkdirSync(repoDir)
  // Lookup follows the declared name and linked directory, not folder spelling.
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), `module.exports={config:{name:'renamed',featureDir:${JSON.stringify(root)},repos:[{name:'app',localPath:${JSON.stringify(repoDir)}}]}}`)
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  git('commit', '--allow-empty', '-m', 'initial'); git('branch', 'other')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('keeps lookup refusals ahead of activity checks and guards both mutations before Git changes', async () => {
  const isRepoActive = vi.fn(() => true)
  const publish = vi.fn()
  const deps = { featuresDir, isRepoActive, workspaceEvents: { publish } }
  for (const operation of [checkoutFeatureRepo, updateFeatureRepo]) {
    expect(await operation(deps, { feature: 'missing', repo: 'app', branch: 'other' })).toMatchObject({ ok: false, statusCode: 404, error: 'feature not found' })
    expect(await operation(deps, { feature: 'renamed', repo: 'missing', branch: 'other' })).toMatchObject({ ok: false, statusCode: 404, error: 'repo not found' })
  }
  expect(isRepoActive).not.toHaveBeenCalled()
  expect(await readFeatureRepo(deps, { feature: 'renamed', repo: 'app' })).toMatchObject({ ok: true, value: { currentBranch: 'main' } })
  expect(isRepoActive).not.toHaveBeenCalled()
  for (const operation of [checkoutFeatureRepo, updateFeatureRepo]) {
    expect(await operation(deps, { feature: 'renamed', repo: 'app', branch: 'other' })).toEqual({ ok: false, statusCode: 409, error: 'repo has an active service run' })
  }
  expect(isRepoActive).toHaveBeenCalledWith('renamed', 'app')
  expect(git('branch', '--show-current')).toBe('main')
  expect(publish).not.toHaveBeenCalled()
})

it('announces only actual moves and supports directory-only callers without a publisher or guard', async () => {
  const publish = vi.fn()
  const deps = { featuresDir, workspaceEvents: { publish }, isRepoActive: () => false }
  const target = { feature: 'renamed', repo: 'app', branch: ' other ' }
  expect(await checkoutFeatureRepo(deps, target)).toMatchObject({ ok: true, value: { currentBranch: 'other', expectedBranch: null, path: repoDir } })
  expect(await checkoutFeatureRepo(deps, target)).toMatchObject({ ok: true })
  expect(publish.mock.calls).toEqual([[{ type: 'features-changed' }]])
  expect(await checkoutFeatureRepo({ featuresDir }, { ...target, branch: 'main' })).toMatchObject({ ok: true, value: { currentBranch: 'main' } })
})
