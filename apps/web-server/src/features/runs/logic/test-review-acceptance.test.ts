import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { buildGitReview, commitReviewedFiles, restoreGitReview } from './test-review-acceptance'
import { suiteReviewFiles } from './runtime/suite-review'
import { git, initGitRepo } from '../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('canary-review-git-')

function fixture(): string {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'before\n')
  fs.writeFileSync(path.join(root, 'e2e/fixture.ts'), 'fixture before\n')
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated before\n')
  initGitRepo(root)
  return root
}

describe('revision-bound Git test review', () => {
  it('matches snapshot comparison for the same bytes and deduplicates disclosed paths', async () => {
    const root = fixture()
    const snapshot = tempDir('canary-review-baseline-')
    fs.cpSync(root, snapshot, { recursive: true })
    fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'after without newline')
    fs.rmSync(path.join(root, 'e2e/fixture.ts'))
    fs.writeFileSync(path.join(root, 'empty.txt'), '')
    const gitReview = await buildGitReview(root, ['unrelated.txt', 'empty.txt', 'e2e/fixture.ts', 'e2e/a.spec.ts', 'empty.txt'])
    expect(gitReview).toEqual(suiteReviewFiles(snapshot, root))
    expect(gitReview.files).toEqual([
      { file: 'e2e/a.spec.ts', change: 'modified' }, { file: 'e2e/fixture.ts', change: 'deleted' },
      { file: 'empty.txt', change: 'added' },
    ])
    const missing = await buildGitReview(root, ['missing.ts', 'missing.ts'])
    expect(missing).toEqual({
      revision: 'fc6818fa21d92d2d314fa4568ca3fd117c06942ecb757f8678ae602c95472a0c',
      files: [{ file: 'missing.ts', change: 'added' }], before: new Map(), after: new Map(),
    })
  })

  it('rejects an uncommitted suite and does not hide filesystem read failures', async () => {
    const root = tempDir('canary-review-no-git-')
    fs.mkdirSync(path.join(root, 'e2e', 'directory.spec.ts'), { recursive: true })

    await expect(buildGitReview(root, ['e2e/a.spec.ts'])).rejects.toMatchObject({ statusCode: 409 })
    // A directory at a reviewed file path is an I/O fault, not a deleted file.
    // The review must surface it rather than silently treating it as an addition.
    const committed = fixture()
    fs.mkdirSync(path.join(committed, 'e2e', 'directory.spec.ts'))
    await expect(buildGitReview(committed, ['e2e/directory.spec.ts'])).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rejects a path that was never within the disclosed suite review', async () => {
    const root = fixture()
    await expect(buildGitReview(root, ['../outside.spec.ts'])).rejects.toMatchObject({ statusCode: 400 })
    await expect(commitReviewedFiles('checkout', root, [])).rejects.toMatchObject({ statusCode: 409 })
  })

  it('commits exactly the disclosed specs and supporting files while preserving unrelated staged work', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'after\n')
    fs.writeFileSync(path.join(root, 'e2e/fixture.ts'), 'fixture after\n')
    fs.writeFileSync(path.join(root, 'e2e/new-fixture.ts'), 'new fixture\n')
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated staged\n')
    execFileSync('git', ['add', 'unrelated.txt'], { cwd: root })

    const plan = await buildGitReview(root, ['e2e/a.spec.ts', 'e2e/fixture.ts', 'e2e/new-fixture.ts'])
    expect(plan.files).toEqual([
      { file: 'e2e/a.spec.ts', change: 'modified' },
      { file: 'e2e/fixture.ts', change: 'modified' },
      { file: 'e2e/new-fixture.ts', change: 'added' },
    ])
    const receipt = await commitReviewedFiles('checkout', root, plan.files.map((file) => file.file))
    expect(receipt).toMatchObject({ status: 'committed', commit: expect.stringMatching(/^[a-f0-9]{40}$/) })
    expect(execFileSync('git', ['show', 'HEAD:e2e/a.spec.ts'], { cwd: root }).toString()).toBe('after\n')
    expect(execFileSync('git', ['show', 'HEAD:e2e/fixture.ts'], { cwd: root }).toString()).toBe('fixture after\n')
    expect(execFileSync('git', ['show', 'HEAD:e2e/new-fixture.ts'], { cwd: root }).toString()).toBe('new fixture\n')
    expect(execFileSync('git', ['show', 'HEAD:unrelated.txt'], { cwd: root }).toString()).toBe('unrelated before\n')
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root }).toString().trim()).toBe('unrelated.txt')

    expect(await commitReviewedFiles('checkout', root, plan.files.map((file) => file.file))).toEqual({
      status: 'already-committed', commit: receipt.commit,
    })
  })

  it('accepts a committed move without passing its removed path to Git', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'e2e/subscription.cjs'), 'original\n')
    git(root, 'add', 'e2e/subscription.cjs')
    git(root, 'commit', '-qm', 'record subscription helper')

    fs.mkdirSync(path.join(root, 'scripts'))
    fs.renameSync(path.join(root, 'e2e/subscription.cjs'), path.join(root, 'scripts/subscription.cjs'))
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'move subscription helper')
    fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'after\n')
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated staged\n')
    git(root, 'add', 'unrelated.txt')

    const receipt = await commitReviewedFiles('checkout', root, ['e2e/a.spec.ts', 'e2e/subscription.cjs'])
    expect(receipt.status).toBe('committed')
    expect(git(root, 'show', 'HEAD:e2e/a.spec.ts')).toBe('after')
    expect(git(root, 'show', 'HEAD:scripts/subscription.cjs')).toBe('original')
    expect(git(root, 'ls-files', 'e2e/subscription.cjs')).toBe('')
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('unrelated.txt')
    expect(await commitReviewedFiles('checkout', root, ['e2e/a.spec.ts', 'e2e/subscription.cjs'])).toEqual({
      status: 'already-committed', commit: receipt.commit,
    })
    expect(await commitReviewedFiles('checkout', root, ['e2e/subscription.cjs'])).toEqual({
      status: 'already-committed', commit: receipt.commit,
    })
  })

  it('commits a reviewed deletion that is still tracked by Git', async () => {
    const root = fixture()
    fs.rmSync(path.join(root, 'e2e/fixture.ts'))

    const receipt = await commitReviewedFiles('checkout', root, ['e2e/fixture.ts'])
    expect(receipt.status).toBe('committed')
    expect(git(root, 'ls-files', 'e2e/fixture.ts')).toBe('')
    expect(git(root, 'show', '--format=', '--name-status', 'HEAD')).toBe('D\te2e/fixture.ts')
  })

  it('commits a reviewed deletion already staged with git rm', async () => {
    const root = fixture()
    git(root, 'rm', 'e2e/fixture.ts')

    const receipt = await commitReviewedFiles('checkout', root, ['e2e/fixture.ts'])
    expect(receipt.status).toBe('committed')
    expect(git(root, 'show', '--format=', '--name-status', 'HEAD')).toBe('D\te2e/fixture.ts')
  })

  it('restores the exact reviewed revision, including removing a newly added supporting file', async () => {
    const root = fixture()
    fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'after\n')
    fs.writeFileSync(path.join(root, 'e2e/new-fixture.ts'), 'new\n')
    const plan = await buildGitReview(root, ['e2e/a.spec.ts', 'e2e/new-fixture.ts'])

    expect(await restoreGitReview(root, plan)).toEqual(['e2e/a.spec.ts', 'e2e/new-fixture.ts'])
    expect(fs.readFileSync(path.join(root, 'e2e/a.spec.ts'), 'utf8')).toBe('before\n')
    expect(fs.existsSync(path.join(root, 'e2e/new-fixture.ts'))).toBe(false)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString()).toBe('')
  })
})
