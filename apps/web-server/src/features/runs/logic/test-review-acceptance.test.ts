import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGitReview, commitReviewedFiles, restoreGitReview } from './test-review-acceptance'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-review-git-'))
  cleanups.push(root)
  fs.mkdirSync(path.join(root, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'before\n')
  fs.writeFileSync(path.join(root, 'e2e/fixture.ts'), 'fixture before\n')
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated before\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Canary Test')
  git('add', '.')
  git('commit', '-qm', 'initial')
  return root
}

describe('revision-bound Git test review', () => {
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
