import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveRepoIdentity, resolveRepoPath, resolveRepoPaths, sameRepoSet } from './repo-identity'

let root: string
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-identity-'))) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

it('preserves home expansion without expanding named users', () => {
  expect(resolveRepoPath('~')).toBe(os.homedir())
  expect(resolveRepoPath('~/app')).toBe(path.join(os.homedir(), 'app'))
  expect(resolveRepoPath('~cache')).toBe('~cache')
  expect(resolveRepoIdentity('~', 'required')).toBe(fs.realpathSync(os.homedir()))
  expect(resolveRepoIdentity('~cache', 'best-effort')).toBe(path.resolve('~cache'))
})

it.each(['required', 'best-effort'] as const)('resolves aliases, relative spellings and separators in %s mode', (mode) => {
  const alias = path.join(root, 'alias')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo); fs.symlinkSync(repo, alias, 'dir')
  for (const target of [repo, alias, `${alias}/`, path.relative(process.cwd(), alias), path.join(alias, '..', 'repo')]) {
    expect(resolveRepoIdentity(target, mode)).toBe(repo)
  }
})

it('keeps different subdirectories and real Git worktrees distinct', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial')
  const worktree = path.join(root, 'worktree')
  git('worktree', 'add', '--detach', worktree, 'HEAD')
  const dirs = [path.join(root, 'service-a'), path.join(root, 'service-b')]
  dirs.forEach((dir) => fs.mkdirSync(dir))
  expect(new Set([root, worktree, ...dirs].map((dir) => resolveRepoIdentity(dir, 'required'))).size).toBe(4)
  expect(sameRepoSet([root], [worktree])).toBe(false)
  expect(sameRepoSet([dirs[0]], [dirs[1]])).toBe(false)
})

it('preserves missing paths and dangling symlinks only in best-effort mode', () => {
  const missing = path.join(root, 'missing')
  const dangling = path.join(root, 'dangling')
  fs.symlinkSync(missing, dangling)
  for (const target of [missing, dangling]) {
    expect(resolveRepoIdentity(target, 'best-effort')).toBe(target)
    expect(() => resolveRepoIdentity(target, 'required')).toThrow()
  }
})

it('does not resolve a missing suffix through its existing symlink parent', () => {
  const alias = path.join(root, 'alias')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo); fs.symlinkSync(repo, alias)
  expect(resolveRepoIdentity(path.join(alias, 'missing'), 'best-effort')).toBe(path.join(alias, 'missing'))
})

it('propagates the original resolution error in required mode and falls back otherwise', () => {
  const denied = Object.assign(new Error('unreadable'), { code: 'EACCES' })
  vi.spyOn(fs, 'realpathSync').mockImplementation(() => { throw denied })
  expect(() => resolveRepoIdentity(root, 'required')).toThrow(denied)
  expect(resolveRepoIdentity(root, 'best-effort')).toBe(root)
})

it('observes changes on each call and does not introduce a directory-type guard', () => {
  const file = path.join(root, 'file')
  const alias = path.join(root, 'alias')
  fs.writeFileSync(file, 'fixture'); fs.symlinkSync(root, alias)
  expect(resolveRepoIdentity(alias, 'required')).toBe(root)
  fs.unlinkSync(alias); fs.symlinkSync(file, alias)
  expect(resolveRepoIdentity(alias, 'required')).toBe(file)
})

it('compares identities without changing order or duplicate multiplicity', () => {
  const repo = path.join(root, 'repo')
  const alias = path.join(root, 'alias')
  fs.mkdirSync(repo)
  fs.symlinkSync(repo, alias, 'dir')
  const missing = path.join(root, 'missing')
  const original = [missing, repo, repo]
  expect(sameRepoSet(original, [alias, missing, repo])).toBe(true)
  expect(original).toEqual([missing, repo, repo])
  expect(sameRepoSet([repo, repo], [alias])).toBe(false)
  expect(sameRepoSet([repo], [missing])).toBe(false)
  expect(sameRepoSet(['~'], [os.homedir()])).toBe(true)
  expect(sameRepoSet(['~/missing-repo'], [path.join(os.homedir(), 'missing-repo')])).toBe(true)
  expect(sameRepoSet([], [])).toBe(true)
})

it('resolves a repository list in order with duplicate aliases and no input changes', () => {
  const repo = path.join(root, 'repo')
  const alias = path.join(root, 'alias')
  fs.mkdirSync(repo); fs.symlinkSync(repo, alias)
  const input = [alias, '~', repo, '']
  expect(resolveRepoPaths(input)).toEqual({ ok: true, paths: [repo, fs.realpathSync(os.homedir()), repo, fs.realpathSync(process.cwd())] })
  expect(input).toEqual([alias, '~', repo, ''])
  expect(resolveRepoPaths([])).toEqual({ ok: true, paths: [] })
  const file = path.join(root, 'file')
  fs.writeFileSync(file, '')
  expect(resolveRepoPaths([file])).toEqual({ ok: true, paths: [file] })
})
it('returns the first original failing path without processing later paths', () => {
  const first = path.join(root, 'missing-1')
  const second = path.join(root, 'missing-2')
  const spy = vi.spyOn(fs, 'realpathSync')
  expect(resolveRepoPaths([root, first, second])).toEqual({ ok: false, path: first })
  expect(spy).not.toHaveBeenCalledWith(second)
})
