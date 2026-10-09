import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runManifest } from '../__fixtures__/run-manifest'
import { resolveCycleTree, suiteRelativePath } from './cycle-tree'
import { initGitRepo } from '../../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-cycle-tree-')
afterEach(() => vi.unstubAllEnvs())

function repo(root: string, name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), name)
  return initGitRepo(dir)
}

function workspace(): { root: string; featureDir: string; app: string } {
  const root = tempDir()
  const ws = repo(root, 'workspace')
  const featureDir = path.join(ws, 'features', 'demo')
  fs.mkdirSync(featureDir, { recursive: true })
  return { root, featureDir, app: repo(root, 'app') }
}

const feature = (over: Partial<FeatureConfig>): FeatureConfig => ({ name: 'demo', description: 'd', envs: ['local'], featureDir: '/nowhere', ...over })

describe('resolveCycleTree', () => {
  it('reads a keyless diff as the suite\'s when the run had no app repos', async () => {
    const { root, featureDir } = workspace()
    expect(await resolveCycleTree(undefined, runManifest({ featureDir }), undefined))
      .toEqual({ kind: 'feature-dir', gitRoot: path.join(root, 'workspace'), suitePrefix: 'features/demo' })
    expect(await resolveCycleTree(undefined, runManifest(), undefined)).toEqual({ kind: 'unknown' })
  })

  it('reads a keyless diff as the one repo\'s, and refuses to pick between two', async () => {
    const { root, app } = workspace()
    expect(await resolveCycleTree(undefined, runManifest({ repoPaths: [app] }), undefined)).toEqual({ kind: 'repo', dir: app })
    expect(await resolveCycleTree(undefined, runManifest({ repoPaths: [app, repo(root, 'other')] }), undefined)).toEqual({ kind: 'unknown' })
  })

  it('matches a home-relative key to the run\'s recorded paths', async () => {
    const { root, featureDir, app } = workspace()
    vi.stubEnv('HOME', root)
    const manifest = runManifest({ featureDir, repoPaths: [app] })
    expect(await resolveCycleTree('~/workspace/features/demo', manifest, undefined)).toMatchObject({ kind: 'feature-dir', suitePrefix: 'features/demo' })
    expect(await resolveCycleTree('~/app', manifest, undefined)).toEqual({ kind: 'repo', dir: app })
  })

  it('never resolves a key the run did not record, even one naming a real repository', async () => {
    const { root, featureDir } = workspace()
    expect(await resolveCycleTree(repo(root, 'stranger'), runManifest({ featureDir }), undefined)).toEqual({ kind: 'unknown' })
  })

  it('falls back from a dangling worktree to the configured checkout of the same repo', async () => {
    const { root, app } = workspace()
    const worktree = path.join(root, 'run', 'worktrees', 'app')
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(root, 'gone', '.git', 'worktrees', 'app')}\n`)
    const manifest = runManifest({ worktrees: { app: worktree } })
    expect(await resolveCycleTree(worktree, manifest, feature({ repos: [{ name: 'app', localPath: app }] }))).toEqual({ kind: 'repo', dir: app })
    expect(await resolveCycleTree(worktree, manifest, feature({ repos: [{ name: 'app', localPath: path.join(root, 'missing') }] }))).toEqual({ kind: 'repo', dir: null })
    expect(await resolveCycleTree(worktree, manifest, undefined)).toEqual({ kind: 'repo', dir: null })
  })

  it('names a recorded repo path from the run\'s branch record or the suite config', async () => {
    const { root, app } = workspace()
    const gone = path.join(root, 'moved-app')
    const byBranch = runManifest({ repoPaths: [gone], repoBranches: [{ name: 'app', path: gone, branch: 'main', detached: false, dirty: false }] })
    const config = feature({ repos: [{ name: 'app', localPath: app }] })
    expect(await resolveCycleTree(gone, byBranch, config)).toEqual({ kind: 'repo', dir: app })
    expect(await resolveCycleTree(undefined, runManifest({ repoPaths: [gone] }), feature({ repos: [{ name: 'app', localPath: gone }] }))).toEqual({ kind: 'repo', dir: null })
    expect(await resolveCycleTree(gone, runManifest({ repoPaths: [gone] }), undefined)).toEqual({ kind: 'repo', dir: null })
  })

  it('finds the git root of a deleted feature dir from its nearest parent, through a symlink', async () => {
    const { root } = workspace()
    const link = path.join(root, 'link')
    fs.symlinkSync(path.join(root, 'workspace'), link)
    expect(await resolveCycleTree(undefined, runManifest({ featureDir: path.join(link, 'features', 'deleted') }), undefined))
      .toEqual({ kind: 'feature-dir', gitRoot: path.join(root, 'workspace'), suitePrefix: 'features/deleted' })
  })

  it('gives the suite an empty prefix at its git root, and none outside any repository', async () => {
    const root = tempDir()
    const suite = repo(root, 'suite')
    expect(await resolveCycleTree(undefined, runManifest({ featureDir: suite }), undefined)).toEqual({ kind: 'feature-dir', gitRoot: suite, suitePrefix: '' })
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-cycle-tree-plain-'))
    try {
      expect(await resolveCycleTree(undefined, runManifest(), feature({ featureDir: plain }))).toEqual({ kind: 'feature-dir', gitRoot: null, suitePrefix: null })
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('suiteRelativePath', () => {
  it('maps a diff path into the suite, and refuses one outside it', () => {
    const tree = { kind: 'feature-dir' as const, gitRoot: '/r' }
    expect(suiteRelativePath({ ...tree, suitePrefix: 'features/demo' }, 'features/demo/e2e/a.spec.ts')).toBe('e2e/a.spec.ts')
    expect(suiteRelativePath({ ...tree, suitePrefix: 'features/demo' }, 'features/demo-two/a.ts')).toBeNull()
    expect(suiteRelativePath({ ...tree, suitePrefix: '' }, 'e2e/a.spec.ts')).toBe('e2e/a.spec.ts')
    expect(suiteRelativePath({ ...tree, suitePrefix: null }, 'e2e/a.spec.ts')).toBeNull()
  })
})
