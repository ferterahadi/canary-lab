import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  snapshotFeatureRepos,
  diffFeatureRepos,
  diffContentForFeatureRepos,
} from './feature-repo-diff'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'

// The snapshot/diff pair is ground truth for what the heal agent edited — it
// feeds the journal's fix.file line and the orchestrator's restart planning, so
// it must never rest on the agent's own account of itself. Tested against real
// git working trees for that reason: a mocked git would prove nothing about
// whether the pathspec scoping actually holds.

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-frd-')))
  dirs.push(d)
  return d
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: 'ignore' as const }
  execFileSync('git', ['init', '-q'], opts)
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
  execFileSync('git', ['config', 'user.name', 'Test'], opts)
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], opts)
}

const feature = (over: Partial<FeatureConfig>): FeatureConfig =>
  ({ name: 'demo', ...over }) as FeatureConfig

describe('snapshotFeatureRepos', () => {
  it('snapshots nothing for a feature with neither repos nor a feature dir', async () => {
    expect(await snapshotFeatureRepos(feature({}))).toEqual(new Map())
  })

  it('skips a repo entry whose localPath is not a string', async () => {
    const config = feature({
      repos: [{ name: 'broken', localPath: undefined as unknown as string }],
    })

    expect(await snapshotFeatureRepos(config)).toEqual(new Map())
  })

  it('skips a feature dir declared as an empty string', async () => {
    expect(await snapshotFeatureRepos(feature({ featureDir: '' }))).toEqual(new Map())
  })

  it('omits a repo path that is not a git working tree', async () => {
    // Silently omitting is deliberate: an empty diff yields restart-everything,
    // which is the same safe fallback as the agent declaring no files.
    const notARepo = tmp()

    const snaps = await snapshotFeatureRepos(feature({ repos: [{ name: 'x', localPath: notARepo }] }))

    expect(snaps.size).toBe(0)
  })

  it('excludes a service repo nested under the feature dir from its pathspec', async () => {
    const root = tmp()
    gitInit(root)
    const featureDir = path.join(root, 'features', 'demo')
    const nested = path.join(featureDir, 'service')
    fs.mkdirSync(nested, { recursive: true })
    gitInit(nested)

    const snaps = await snapshotFeatureRepos(feature({ featureDir, repos: [{ name: 'svc', localPath: nested }] }))

    // Without the exclude, an edit inside the nested repo would be counted
    // twice — once by the repo and once by the feature-dir pathspec.
    expect(snaps.get(featureDir)?.pathspecs).toEqual([featureDir, `:(exclude)${nested}`])
  })
})

describe('diffFeatureRepos', () => {
  it('returns absolute paths of files edited since the snapshot', async () => {
    const repo = tmp()
    gitInit(repo)
    fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: repo, stdio: 'ignore' })

    const snaps = await snapshotFeatureRepos(feature({ repos: [{ name: 'svc', localPath: repo }] }))
    fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const a = 2\n')

    expect(await diffFeatureRepos(snaps)).toEqual([path.join(repo, 'tracked.ts')])
  })

  it('returns nothing when the agent changed no files', async () => {
    const repo = tmp()
    gitInit(repo)

    const snaps = await snapshotFeatureRepos(feature({ repos: [{ name: 'svc', localPath: repo }] }))

    expect(await diffFeatureRepos(snaps)).toEqual([])
  })

  it('scopes the feature-dir diff to the feature subtree', async () => {
    const root = tmp()
    gitInit(root)
    const featureDir = path.join(root, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'spec.ts'), 'a\n')
    fs.writeFileSync(path.join(root, 'outside.ts'), 'a\n')
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: root, stdio: 'ignore' })

    const snaps = await snapshotFeatureRepos(feature({ featureDir }))
    fs.writeFileSync(path.join(featureDir, 'spec.ts'), 'b\n')
    fs.writeFileSync(path.join(root, 'outside.ts'), 'b\n')

    // A file outside the feature is somebody else's edit — attributing it to
    // this heal cycle would restart the wrong services.
    expect(await diffFeatureRepos(snaps)).toEqual([path.join(featureDir, 'spec.ts')])
  })
})

describe('diffContentForFeatureRepos', () => {
  it('returns the unified diff for a single tree with no repo header', async () => {
    const repo = tmp()
    gitInit(repo)
    fs.writeFileSync(path.join(repo, 'a.ts'), 'one\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: repo, stdio: 'ignore' })

    const snaps = await snapshotFeatureRepos(feature({ repos: [{ name: 'svc', localPath: repo }] }))
    fs.writeFileSync(path.join(repo, 'a.ts'), 'two\n')

    const content = await diffContentForFeatureRepos(snaps)
    expect(content).toContain('-one')
    expect(content).toContain('+two')
    expect(content).not.toContain('# repo:')
  })

  it('labels each tree when a feature spans more than one', async () => {
    const repoA = tmp()
    const repoB = tmp()
    for (const r of [repoA, repoB]) {
      gitInit(r)
      fs.writeFileSync(path.join(r, 'f.ts'), 'before\n')
      execFileSync('git', ['add', '-A'], { cwd: r, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: r, stdio: 'ignore' })
    }

    const snaps = await snapshotFeatureRepos(feature({
      repos: [{ name: 'a', localPath: repoA }, { name: 'b', localPath: repoB }],
    }))
    fs.writeFileSync(path.join(repoA, 'f.ts'), 'after-a\n')
    fs.writeFileSync(path.join(repoB, 'f.ts'), 'after-b\n')

    const content = await diffContentForFeatureRepos(snaps)
    expect(content).toContain(`# repo: ${repoA}`)
    expect(content).toContain(`# repo: ${repoB}`)
  })

  it('drops a tree with an empty diff instead of emitting a bare header', async () => {
    const repoA = tmp()
    const repoB = tmp()
    for (const r of [repoA, repoB]) {
      gitInit(r)
      fs.writeFileSync(path.join(r, 'f.ts'), 'before\n')
      execFileSync('git', ['add', '-A'], { cwd: r, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'add'], { cwd: r, stdio: 'ignore' })
    }

    const snaps = await snapshotFeatureRepos(feature({
      repos: [{ name: 'a', localPath: repoA }, { name: 'b', localPath: repoB }],
    }))
    fs.writeFileSync(path.join(repoA, 'f.ts'), 'after-a\n')

    const content = await diffContentForFeatureRepos(snaps)
    expect(content).toContain(`# repo: ${repoA}`)
    expect(content).not.toContain(`# repo: ${repoB}`)
  })

  it('returns an empty string when nothing changed anywhere', async () => {
    const repo = tmp()
    gitInit(repo)

    const snaps = await snapshotFeatureRepos(feature({ repos: [{ name: 'svc', localPath: repo }] }))

    expect(await diffContentForFeatureRepos(snaps)).toBe('')
  })
})
