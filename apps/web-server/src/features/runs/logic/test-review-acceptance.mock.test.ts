import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const git = vi.hoisted(() => ({ getGitRoot: vi.fn(), runGit: vi.fn() }))

vi.mock('../../../shared/git-repo', () => git)

const { buildGitReview, commitReviewedFiles, restoreGitReview } = await import('./test-review-acceptance')

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-git-mock-')))
  fs.mkdirSync(path.join(root, 'e2e'))
  fs.writeFileSync(path.join(root, 'e2e', 'a.spec.ts'), 'current\n')
  git.getGitRoot.mockReset()
  git.runGit.mockReset()
  git.getGitRoot.mockResolvedValue(root)
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('returns actionable Git review failures without attempting a partial commit', async () => {
  git.getGitRoot.mockResolvedValueOnce(null)
  await expect(buildGitReview(root, ['e2e/a.spec.ts'])).rejects.toMatchObject({ statusCode: 409 })

  git.runGit.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'index locked' })
  await expect(commitReviewedFiles('checkout', root, ['e2e/a.spec.ts'])).rejects.toMatchObject({ statusCode: 500, message: 'index locked' })

  git.runGit.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' })
  await expect(commitReviewedFiles('checkout', root, ['e2e/a.spec.ts'])).rejects.toMatchObject({ statusCode: 409, message: 'Git could not record reviewed file e2e/a.spec.ts.' })

  git.runGit.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
    .mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'diff unavailable' })
  await expect(commitReviewedFiles('checkout', root, ['e2e/a.spec.ts'])).rejects.toMatchObject({ statusCode: 500, message: 'diff unavailable' })
})

it('rejects an empty reviewed set and propagates an unreadable current file', async () => {
  await expect(commitReviewedFiles('checkout', root, [])).rejects.toMatchObject({ statusCode: 409 })

  fs.mkdirSync(path.join(root, 'e2e', 'directory.spec.ts'))
  await expect(buildGitReview(root, ['e2e/directory.spec.ts'])).rejects.toMatchObject({ code: 'EISDIR' })
})

it('distinguishes unchanged, added, and deleted reviewed files from Git evidence', async () => {
  git.runGit.mockResolvedValue({ code: 0, stdout: 'current\n', stderr: '' })
  expect((await buildGitReview(root, ['e2e/a.spec.ts'])).files).toEqual([])

  fs.rmSync(path.join(root, 'e2e/a.spec.ts'))
  git.runGit.mockResolvedValue({ code: 0, stdout: 'recorded\n', stderr: '' })
  expect((await buildGitReview(root, ['e2e/a.spec.ts'])).files).toEqual([{ file: 'e2e/a.spec.ts', change: 'deleted' }])

  fs.writeFileSync(path.join(root, 'e2e/a.spec.ts'), 'current\n')
  git.runGit.mockResolvedValue({ code: 1, stdout: '', stderr: '' })
  expect((await buildGitReview(root, ['e2e/a.spec.ts'])).files).toEqual([{ file: 'e2e/a.spec.ts', change: 'added' }])
})

it('surfaces all commit and restore protocol failures without accepting a partial review', async () => {
  const reviewed = ['e2e/a.spec.ts']
  const fail = (responses: Array<{ code: number; stdout: string; stderr: string }>) => {
    git.runGit.mockReset()
    for (const response of responses) git.runGit.mockResolvedValueOnce(response)
  }

  fail([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 0, stdout: 'head\n', stderr: '' }])
  await expect(commitReviewedFiles('checkout', root, reviewed)).resolves.toEqual({ status: 'already-committed', commit: 'head' })

  fail([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }])
  await expect(commitReviewedFiles('checkout', root, reviewed)).rejects.toMatchObject({ statusCode: 409, message: 'No Git commit exists for the reviewed files.' })

  fail([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'commit refused' }])
  await expect(commitReviewedFiles('checkout', root, reviewed)).rejects.toMatchObject({ statusCode: 500, message: 'commit refused' })

  fail([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: '' }])
  await expect(commitReviewedFiles('checkout', root, reviewed)).rejects.toMatchObject({ statusCode: 500, message: 'Git committed the review but could not report its revision.' })

  const trackedPlan = {
    revision: 'r',
    files: [{ file: 'e2e/a.spec.ts', change: 'modified' as const }],
    before: new Map([['e2e/a.spec.ts', Buffer.from('before')]]),
    after: new Map([['e2e/a.spec.ts', Buffer.from('current')]]),
  }
  fail([{ code: 1, stdout: '', stderr: 'restore refused' }])
  await expect(restoreGitReview(root, trackedPlan)).rejects.toMatchObject({ statusCode: 500, message: 'restore refused' })

  const escapedPlan = { ...trackedPlan, files: [{ file: '../outside.spec.ts', change: 'modified' as const }] }
  await expect(restoreGitReview(root, escapedPlan)).rejects.toMatchObject({ statusCode: 400 })
})

it('uses stable fallback messages when Git returns an error without output', async () => {
  const reviewed = ['e2e/a.spec.ts']
  const reply = (code: number) => ({ code, stdout: '', stderr: '' })

  git.runGit.mockResolvedValueOnce(reply(1))
  await expect(commitReviewedFiles('checkout', root, reviewed)).rejects.toMatchObject({
    statusCode: 500, message: 'Git could not stage the reviewed files.',
  })

  git.runGit.mockReset()
  git.runGit.mockResolvedValueOnce(reply(0)).mockResolvedValueOnce(reply(0)).mockResolvedValueOnce(reply(2))
  await expect(commitReviewedFiles('checkout', root, reviewed)).rejects.toMatchObject({
    statusCode: 500, message: 'Git could not inspect the reviewed files.',
  })

  git.runGit.mockReset()
  git.runGit.mockResolvedValueOnce(reply(0)).mockResolvedValueOnce(reply(0)).mockResolvedValueOnce(reply(1)).mockResolvedValueOnce(reply(1))
  await expect(commitReviewedFiles('checkout', root, reviewed)).rejects.toMatchObject({
    statusCode: 500, message: 'Git could not commit the reviewed files.',
  })

  git.runGit.mockReset()
  const trackedPlan = {
    revision: 'r', files: [{ file: 'e2e/a.spec.ts', change: 'modified' as const }],
    before: new Map([['e2e/a.spec.ts', Buffer.from('before')]]), after: new Map([['e2e/a.spec.ts', Buffer.from('current')]]),
  }
  git.runGit.mockResolvedValueOnce(reply(1))
  await expect(restoreGitReview(root, trackedPlan)).rejects.toMatchObject({
    statusCode: 500, message: 'Git could not restore the reviewed files.',
  })
})
