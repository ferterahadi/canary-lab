import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { checkoutBranch, getGitStatus } from './git-repo'
import { fastForwardToUpstream } from './git-upstream'

let repo: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-status-read-'))
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'tracked'), 'original\n')
  git('add', 'tracked')
  git('commit', '-m', 'fixture')
  git('branch', 'other')
})
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }) })

it('does not refresh index metadata while detecting clean, modified and untracked files', async () => {
  const index = path.join(repo, '.git', 'index')
  const bytes = fs.readFileSync(index)
  const modified = fs.statSync(index, { bigint: true }).mtimeNs
  const file = path.join(repo, 'tracked')
  const stat = fs.statSync(file)
  // Identical content with a changed timestamp makes ordinary git status write
  // fresh stat information into the index, despite reporting a clean tree.
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000))
  expect(await getGitStatus(repo)).toMatchObject({ dirty: false, dirtyFiles: [] })
  expect(fs.readFileSync(index)).toEqual(bytes)
  expect(fs.statSync(index, { bigint: true }).mtimeNs).toBe(modified)

  fs.writeFileSync(file, 'edited\n')
  fs.writeFileSync(path.join(repo, 'untracked'), 'new\n')
  expect(await getGitStatus(repo)).toMatchObject({ dirty: true, dirtyFiles: [' M tracked', '?? untracked'] })
  expect(fs.readFileSync(index)).toEqual(bytes)
  expect(fs.statSync(index, { bigint: true }).mtimeNs).toBe(modified)
})

it('rejects unreadable evidence before checkout or upstream update, and recovers after repair', async () => {
  const index = path.join(repo, '.git', 'index')
  const bytes = fs.readFileSync(index)
  const head = git('rev-parse', 'HEAD')
  fs.writeFileSync(index, 'invalid index')
  const events = { publish: (event: unknown) => { announcements.push(event) } }
  const announcements: unknown[] = []
  await expect(getGitStatus(repo)).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('status --porcelain') })
  await expect(checkoutBranch(repo, 'other', events)).rejects.toMatchObject({ statusCode: 500 })
  await expect(fastForwardToUpstream(repo)).rejects.toMatchObject({ statusCode: 500 })
  expect(git('branch', '--show-current')).toBe('main')
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(fs.readFileSync(index, 'utf8')).toBe('invalid index')
  expect(fs.readFileSync(path.join(repo, 'tracked'), 'utf8')).toBe('original\n')
  expect(announcements).toEqual([])

  fs.writeFileSync(index, bytes)
  expect(await getGitStatus(repo)).toMatchObject({ currentBranch: 'main', dirty: false })
})
