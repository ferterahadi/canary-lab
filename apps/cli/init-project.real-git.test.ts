import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A SECOND suite because `init-project.test.ts` mocks `child_process` module-wide
// (vi.mock is per-file), and a mocked git can only prove the argv we passed — not
// that the repo it produced is one portify's worktrees can actually read. The
// invariant under test is a property of real git, so this file uses real git.
import { commitScaffold } from './init-project'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-init-git-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('commitScaffold (real git)', () => {
  // The failure this exists to prevent: a scaffolded workspace had `git init` but no
  // commit, so every portify died with `409 repo "<x>" has uncommitted changes` —
  // worktrees only see committed files. Asserting "a commit exists" is not enough;
  // a LEFTOVER dirty file reproduces the same 409, so the clean tree is the assertion
  // that matters.
  it('leaves the repo with one commit and a clean tree', () => {
    const dir = mkTmp()
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nlogs/\n')
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')
    fs.mkdirSync(path.join(dir, 'flight-app'))
    fs.writeFileSync(path.join(dir, 'flight-app', 'server.ts'), 'export {}\n')

    commitScaffold(dir)

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()
    expect(status).toBe('')
    const log = execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString().trim()
    expect(log.split('\n')).toHaveLength(1)
    // The scaffolded product repo must be IN that commit — it is the path portify
    // hands to `git worktree add`, and an untracked one is invisible there.
    const tracked = execFileSync('git', ['ls-files'], { cwd: dir }).toString()
    expect(tracked).toContain('flight-app/server.ts')
  })

  // Committing without a configured `user.email` normally aborts. An init running
  // unattended (the demo, CI, a fresh machine) has no global git identity, and this
  // used to be the difference between a usable workspace and a 409 later.
  it('commits with no global git identity configured', () => {
    const dir = mkTmp()
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    // Empty strings shadow any real global identity for this repo only, which is the
    // state a machine that never ran `git config --global user.email` is in.
    execFileSync('git', ['config', 'user.email', ''], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', ''], { cwd: dir, stdio: 'ignore' })
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')

    commitScaffold(dir)

    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).toBe('')
  })

  // The swallow arm. `git init` is allowed to fail (git absent, or a refusing
  // filesystem) and init still finishes — so this must not throw for the caller,
  // which invokes it unconditionally.
  it('swallows when the directory is not a git repository', () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n')

    expect(() => commitScaffold(dir)).not.toThrow()
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
  })
})
