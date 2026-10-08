import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as git from './git-repo'
import { repositoryWatchPaths } from './repository-watch-paths'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { git as command } from '../../../../tools/test-helpers/git-repo'

const tempDir = trackTempDirs('cl-watch-paths-')

let root: string
let repo: string
beforeEach(() => {
  root = tempDir()
  repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  command(repo, 'init', '-b', 'main'); command(repo, 'config', 'user.email', 'test@example.com'); command(repo, 'config', 'user.name', 'Test')
  fs.mkdirSync(path.join(repo, 'service')); fs.mkdirSync(path.join(repo, 'ignored'))
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\ncache/\n*.log\n')
  fs.writeFileSync(path.join(repo, 'service', 'tracked'), 'original')
  fs.writeFileSync(path.join(repo, 'ignored', 'tracked'), 'tracked exception')
  command(repo, 'add', '.'); command(repo, 'add', '-f', 'ignored/tracked'); command(repo, 'commit', '-m', 'fixture')
  fs.writeFileSync(path.join(repo, 'ignored', 'noise'), 'ignored')
  fs.writeFileSync(path.join(repo, 'debug.log'), 'ignored file')
  fs.mkdirSync(path.join(repo, 'cache')); fs.writeFileSync(path.join(repo, 'cache', 'noise'), 'ignored tree')
})
afterEach(() => { vi.restoreAllMocks() })

it('uses Git ignores while retaining tracked exceptions and directory replacement hints', async () => {
  const run = vi.spyOn(git, 'runGit')
  const watches = await repositoryWatchPaths(repo, 'repository')
  const content = watches[0]
  expect(content.path).toBe(repo)
  for (const name of [null, '', '.gitignore', 'service/tracked', 'new', 'ignored', 'ignored/tracked']) expect(content.accepts(name)).toBe(true)
  for (const name of ['ignored/noise', 'debug.log', 'cache', 'cache/noise', '.git/objects/hash']) expect(content.accepts(name)).toBe(false)
  const parent = watches[1]
  expect(parent.path).toBe(root)
  expect(parent.accepts(null)).toBe(true); expect(parent.accepts('repo')).toBe(true); expect(parent.accepts('other')).toBe(false)
  const metadata = watches.find((watch) => watch.path === path.join(repo, '.git'))!
  expect(metadata.accepts(null)).toBe(true); expect(metadata.accepts('HEAD')).toBe(true); expect(metadata.accepts('objects')).toBe(false)
  expect(watches.find((watch) => watch.path.endsWith('/refs'))!.accepts('heads/new')).toBe(true)
  expect(run).toHaveBeenCalledTimes(5)
  expect(run.mock.calls.some(([, args]) => args.includes('status'))).toBe(false)
})

it('keeps directory scope and resolves symlink aliases only for watch identity', async () => {
  const alias = path.join(root, 'alias'); fs.symlinkSync(path.join(repo, 'service'), alias)
  const watches = await repositoryWatchPaths(alias, 'directory')
  expect(watches[0].path).toBe(path.join(repo, 'service'))
  expect(watches[0].accepts('tracked')).toBe(true)
  expect(watches[0].accepts('new')).toBe(true)
})

it('watches linked worktree metadata and shared references, including a refs directory created later', async () => {
  const worktree = path.join(root, 'worktree')
  command(repo, 'worktree', 'add', '-b', 'linked', worktree)
  const watches = await repositoryWatchPaths(worktree, 'repository')
  const gitDir = command(repo, '-C', worktree, 'rev-parse', '--absolute-git-dir')
  expect(watches.map((watch) => watch.path)).toContain(gitDir)
  expect(watches.map((watch) => watch.path)).toContain(path.join(repo, '.git'))
  expect(watches.find((watch) => watch.path === gitDir)!.accepts('refs')).toBe(true)
})

it('rejects missing/non-repository targets and preserves Git diagnostics or a stable fallback', async () => {
  await expect(repositoryWatchPaths(path.join(root, 'missing'), 'directory')).rejects.toThrow()
  await expect(repositoryWatchPaths(root, 'repository')).rejects.toThrow('not a git repository')
  vi.spyOn(git, 'runGit').mockResolvedValue({ code: 1, stdout: '', stderr: '' })
  await expect(repositoryWatchPaths(repo, 'directory')).rejects.toThrow('Unable to locate repository metadata')
})

it.each(['--ignored', '--cached'])('observes conservatively when %s discovery fails', async (failedArgument) => {
  const real = git.runGit
  vi.spyOn(git, 'runGit').mockImplementation((cwd, args) => args.includes(failedArgument)
    ? Promise.resolve({ code: 128, stdout: '', stderr: 'unreadable index' }) : real(cwd, args))
  const watches = await repositoryWatchPaths(repo, 'repository')
  expect(watches[0].accepts('ignored/noise')).toBe(true)
  expect(watches[0].accepts('ignored/tracked')).toBe(true)
})

it('observes shared refs when a linked worktree has no private refs directory', async () => {
  const worktree = path.join(root, 'worktree')
  command(repo, 'worktree', 'add', '-b', 'linked', worktree)
  const gitDir = command(repo, '-C', worktree, 'rev-parse', '--absolute-git-dir')
  fs.rmSync(path.join(gitDir, 'refs'), { recursive: true, force: true })
  const watches = await repositoryWatchPaths(worktree, 'repository')
  expect(watches.some((watch) => watch.path === path.join(gitDir, 'refs'))).toBe(false)
  expect(watches.find((watch) => watch.path === gitDir)!.accepts('refs')).toBe(true)
})

it('uses real watches and readers without modifying the index, and rebuilds observation after directory replacement', async () => {
  const { createRepositoryObserver } = await import('./repository-observer')
  const publish = vi.fn()
  const log = vi.fn()
  const observer = createRepositoryObserver({ events: { publish }, log })
  const service = path.join(repo, 'service')
  try {
    expect(await observer.readWorkingTree(service, 'directory', { flightId: 'flight' })).toMatchObject({ ok: true, lines: [] })
    expect(await observer.readRepo({ name: 'service', localPath: service }, { feature: 'checkout', repo: 'service' }, {})).toMatchObject({ currentBranch: 'main' })
    const index = fs.readFileSync(path.join(repo, '.git', 'index'))
    fs.renameSync(service, path.join(repo, 'moved'))
    fs.mkdirSync(service); fs.writeFileSync(path.join(service, 'tracked'), 'replacement')
    await expect.poll(() => publish.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0)
    expect(await observer.readWorkingTree(service, 'directory', { flightId: 'flight' })).toMatchObject({ ok: true, lines: [' M service/tracked'] })
    publish.mockClear()
    fs.writeFileSync(path.join(service, 'tracked'), 'original')
    await expect.poll(() => publish.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0)
    expect(await observer.readWorkingTree(service, 'directory', { flightId: 'flight' })).toMatchObject({ ok: true, lines: [] })
    expect(fs.readFileSync(path.join(repo, '.git', 'index'))).toEqual(index)
    expect(log).not.toHaveBeenCalled()
  } finally { observer.dispose() }
})
