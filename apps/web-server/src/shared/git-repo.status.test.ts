import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { checkoutBranch, getGitStatus, readWorkingTree } from './git-repo'
import { fastForwardToUpstream } from './git-upstream'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { initGitRepo, git } from '../../../../tools/test-helpers/git-repo'

const tempDir = trackTempDirs('cl-status-read-')

let repo: string

beforeEach(() => {
  repo = tempDir()
  fs.writeFileSync(path.join(repo, 'tracked'), 'original\n')
  initGitRepo(repo, { branch: 'main' })
  git(repo, 'branch', 'other')
})

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
  const head = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(index, 'invalid index')
  const events = { publish: (event: unknown) => { announcements.push(event) } }
  const announcements: unknown[] = []
  await expect(getGitStatus(repo)).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining('status --porcelain') })
  await expect(checkoutBranch(repo, 'other', events)).rejects.toMatchObject({ statusCode: 500 })
  await expect(fastForwardToUpstream(repo)).rejects.toMatchObject({ statusCode: 500 })
  expect(git(repo, 'branch', '--show-current')).toBe('main')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.readFileSync(index, 'utf8')).toBe('invalid index')
  expect(fs.readFileSync(path.join(repo, 'tracked'), 'utf8')).toBe('original\n')
  expect(announcements).toEqual([])

  fs.writeFileSync(index, bytes)
  expect(await getGitStatus(repo)).toMatchObject({ currentBranch: 'main', dirty: false })
})

it('preserves porcelain ordering for staged, unstaged, untracked, deleted and renamed files', async () => {
  for (const name of ['deleted', 'renamed', 'staged']) fs.writeFileSync(path.join(repo, name), name)
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'status variants')
  fs.unlinkSync(path.join(repo, 'deleted'))
  git(repo, 'mv', 'renamed', 'renamed-new')
  fs.writeFileSync(path.join(repo, 'staged'), 'staged edit')
  git(repo, 'add', 'staged')
  fs.writeFileSync(path.join(repo, 'tracked'), 'unstaged edit')
  fs.writeFileSync(path.join(repo, 'untracked'), 'untracked')
  expect(await readWorkingTree(repo, 'repository')).toEqual({
    ok: true,
    lines: [' D deleted', 'R  renamed -> renamed-new', 'M  staged', ' M tracked', '?? untracked'],
    stdout: ' D deleted\nR  renamed -> renamed-new\nM  staged\n M tracked\n?? untracked\n',
  })
})

it('limits directory inspection to its subtree while repository inspection includes siblings', async () => {
  const service = path.join(repo, 'service')
  fs.mkdirSync(service)
  const file = path.join(service, 'tracked')
  fs.writeFileSync(file, 'service')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'nested service')
  const index = path.join(repo, '.git', 'index')
  const bytes = fs.readFileSync(index)
  const modified = fs.statSync(index, { bigint: true }).mtimeNs
  const stat = fs.statSync(file)
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000))
  fs.writeFileSync(path.join(repo, 'tracked'), 'sibling edit')
  expect(await readWorkingTree(service, 'directory')).toEqual({ ok: true, lines: [], stdout: '' })
  expect(await readWorkingTree(service, 'repository')).toEqual({ ok: true, lines: [' M tracked'], stdout: ' M tracked\n' })
  fs.writeFileSync(file, 'service edit')
  expect(await readWorkingTree(service, 'directory')).toEqual({ ok: true, lines: [' M service/tracked'], stdout: ' M service/tracked\n' })
  expect(fs.readFileSync(index)).toEqual(bytes)
  expect(fs.statSync(index, { bigint: true }).mtimeNs).toBe(modified)
})

it('reports failed inspections rather than clean evidence for missing paths, non-repositories and corrupt indexes', async () => {
  const plain = tempDir('cl-status-plain-')
  for (const scope of ['directory', 'repository'] as const) {
    for (const cwd of [plain, path.join(plain, 'missing')]) {
      const result = await readWorkingTree(cwd, scope)
      expect(result).toMatchObject({ ok: false, result: { code: expect.any(Number), stdout: '', stderr: expect.any(String) } })
      if (!result.ok) expect(result.result.code).not.toBe(0)
    }
    fs.writeFileSync(path.join(repo, '.git', 'index'), 'corrupt index')
    expect(await readWorkingTree(repo, scope)).toMatchObject({ ok: false, result: { code: 128, stderr: expect.stringContaining('index') } })
  }
})
