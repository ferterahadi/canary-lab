import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  parsePorcelainWorktrees,
  classifyWorktreePath,
  isUnder,
  listWorktrees,
} from './worktree-inventory'

describe('parsePorcelainWorktrees', () => {
  it('parses branch and detached records, short-naming refs', () => {
    const stdout = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/logs/benchmarks/b1/worktrees/arm-A/app',
      'HEAD abcdef1234567890000000000000000000000000',
      'detached',
      '',
    ].join('\n')
    expect(parsePorcelainWorktrees(stdout)).toEqual([
      { path: '/repo', ref: 'main' },
      { path: '/repo/logs/benchmarks/b1/worktrees/arm-A/app', ref: 'abcdef1' },
    ])
  })

  it('handles a trailing record without a blank line', () => {
    const stdout = 'worktree /a\nHEAD 9999999999999999999999999999999999999999\nbranch refs/heads/dev'
    expect(parsePorcelainWorktrees(stdout)).toEqual([{ path: '/a', ref: 'dev' }])
  })

  it('falls back to "detached" when a record has neither branch nor HEAD', () => {
    expect(parsePorcelainWorktrees('worktree /lonely\n')).toEqual([{ path: '/lonely', ref: 'detached' }])
  })
})

describe('classifyWorktreePath', () => {
  const logs = '/ws/logs'
  it('classifies run worktrees', () => {
    expect(classifyWorktreePath(logs, '/ws/logs/runs/2026-01-01T00-abcd/worktrees/app'))
      .toEqual({ ownerKind: 'run', ownerId: '2026-01-01T00-abcd', slot: null })
  })
  it('classifies benchmark worktrees with their slot', () => {
    expect(classifyWorktreePath(logs, '/ws/logs/benchmarks/bench-x/worktrees/arm-B/app'))
      .toEqual({ ownerKind: 'benchmark', ownerId: 'bench-x', slot: 'arm-B' })
    expect(classifyWorktreePath(logs, '/ws/logs/benchmarks/bench-x/worktrees/inspect/app'))
      .toEqual({ ownerKind: 'benchmark', ownerId: 'bench-x', slot: 'inspect' })
  })
  it('classifies portify worktrees with their slot', () => {
    expect(classifyWorktreePath(logs, '/ws/logs/portify/portify-1/worktrees/g0-app'))
      .toEqual({ ownerKind: 'portify', ownerId: 'portify-1', slot: 'g0-app' })
    expect(classifyWorktreePath(logs, '/ws/logs/portify/portify-1'))
      .toEqual({ ownerKind: 'portify', ownerId: 'portify-1', slot: null })
    // worktrees segment but no repo segment → null slot (the `seg[3] ?? null` arm).
    expect(classifyWorktreePath(logs, '/ws/logs/portify/portify-1/worktrees'))
      .toEqual({ ownerKind: 'portify', ownerId: 'portify-1', slot: null })
  })
  it('marks paths outside the logs layout as unknown', () => {
    expect(classifyWorktreePath(logs, '/somewhere/else'))
      .toEqual({ ownerKind: 'unknown', ownerId: null, slot: null })
  })
  it('marks an unrecognized dir under logs as unknown', () => {
    expect(classifyWorktreePath(logs, '/ws/logs/scratch/app'))
      .toEqual({ ownerKind: 'unknown', ownerId: null, slot: null })
  })
  it('treats runs/benchmarks/portify roots without an id as unknown', () => {
    expect(classifyWorktreePath(logs, '/ws/logs/runs'))
      .toEqual({ ownerKind: 'unknown', ownerId: null, slot: null })
    expect(classifyWorktreePath(logs, '/ws/logs/benchmarks'))
      .toEqual({ ownerKind: 'unknown', ownerId: null, slot: null })
    expect(classifyWorktreePath(logs, '/ws/logs/portify'))
      .toEqual({ ownerKind: 'unknown', ownerId: null, slot: null })
  })
  it('gives a benchmark a null slot when the path has no worktrees segment', () => {
    expect(classifyWorktreePath(logs, '/ws/logs/benchmarks/b1'))
      .toEqual({ ownerKind: 'benchmark', ownerId: 'b1', slot: null })
    expect(classifyWorktreePath(logs, '/ws/logs/benchmarks/b1/worktrees'))
      .toEqual({ ownerKind: 'benchmark', ownerId: 'b1', slot: null })
  })
})

describe('isUnder', () => {
  it('treats the dir itself and descendants as inside', () => {
    expect(isUnder('/a/b', '/a')).toBe(true)
    expect(isUnder('/a', '/a')).toBe(true)
  })
  it('rejects siblings and escapes', () => {
    expect(isUnder('/a-sibling', '/a')).toBe(false)
    expect(isUnder('/a/../b', '/a')).toBe(false)
  })
})

describe('listWorktrees', () => {
  const logsDir = '/ws/logs'

  it('keeps only worktrees under logsDir, skipping the main worktree, and dedupes', async () => {
    const git = async (cwd: string) => ({
      code: 0,
      stdout: [
        `worktree ${cwd}`, // main worktree (the repo root) — excluded
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        `worktree ${logsDir}/benchmarks/b1/worktrees/arm-A/app`,
        'HEAD abcdef1234567890000000000000000000000000',
        'detached',
        '',
        `worktree /outside/repo/wt`, // outside logsDir — excluded
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        '',
      ].join('\n'),
      stderr: '',
    })
    const entries = await listWorktrees({
      logsDir,
      sourceRoots: ['/ws/app', '/ws/app'], // duplicate source → result still deduped by path
      now: 0,
      git,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      path: `${logsDir}/benchmarks/b1/worktrees/arm-A/app`,
      sourceRoot: '/ws/app',
      ref: 'abcdef1',
      ownerKind: 'benchmark',
      ownerId: 'b1',
      slot: 'arm-A',
      exists: false, // dir doesn't exist on disk in this test → prunable
      bytes: 0,
      ageMs: null,
    })
  })

  it('skips a source repo whose git command fails', async () => {
    const git = async () => ({ code: 128, stdout: '', stderr: 'not a git repo' })
    expect(await listWorktrees({ logsDir, sourceRoots: ['/ws/broken'], now: 0, git })).toEqual([])
  })

  it('defaults to the real runGit when no git runner is injected', async () => {
    // A non-git temp dir → `git worktree list` exits non-zero → the source is
    // skipped. Exercises the `opts.git ?? runGit` default without a real repo.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-nogit-'))
    expect(await listWorktrees({ logsDir, sourceRoots: [tmp], now: 0 })).toEqual([])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('with a real on-disk worktree', () => {
    afterEach(() => vi.restoreAllMocks())

    it('reports exists/bytes/ageMs for a worktree dir present on disk', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-inv-'))
      const wtPath = path.join(tmp, 'runs', 'r1', 'worktrees', 'app')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.writeFileSync(path.join(wtPath, 'file.txt'), 'hello')
      const git = async () => ({
        code: 0,
        stdout: [`worktree ${wtPath}`, 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', ''].join('\n'),
        stderr: '',
      })
      const now = fs.statSync(wtPath).mtimeMs + 5000
      const entries = await listWorktrees({ logsDir: tmp, sourceRoots: ['/ws/app'], now, git })
      expect(entries).toHaveLength(1)
      expect(entries[0].exists).toBe(true)
      expect(entries[0].bytes).toBeGreaterThan(0)
      expect(entries[0].ageMs).toBe(5000)
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('falls back to null age when statSync throws on an existing dir', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true)
      vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('stat boom') })
      const wtPath = `${logsDir}/runs/r1/worktrees/app`
      const git = async () => ({
        code: 0,
        stdout: [`worktree ${wtPath}`, 'HEAD 1111111111111111111111111111111111111111', 'detached', ''].join('\n'),
        stderr: '',
      })
      const entries = await listWorktrees({ logsDir, sourceRoots: ['/ws/app'], now: 0, git })
      expect(entries).toHaveLength(1)
      expect(entries[0].exists).toBe(true)
      expect(entries[0].ageMs).toBeNull()
    })
  })
})
