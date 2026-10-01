import { execFileSync } from 'child_process'
import fs from 'fs'

/** Run git in `cwd` and return its trimmed stdout. A failure throws with git's
 *  stderr in the message rather than printing it into the test output. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export interface InitGitRepoOptions {
  /** The initial branch; git's own default when absent. */
  branch?: string
  /** `'all'` commits whatever is already in the directory; `'empty'` makes an
   *  empty root commit so HEAD resolves before any file exists. */
  commit?: 'all' | 'empty'
}

/** A real repository with a committer identity and one root commit, so the
 *  code under test runs against git itself rather than a fake of it. */
export function initGitRepo(dir: string, { branch, commit = 'all' }: InitGitRepoOptions = {}): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', ...(branch ? ['-b', branch] : []))
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  if (commit === 'all') {
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '--no-verify', '-m', 'init')
  } else {
    git(dir, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'init')
  }
  return dir
}
