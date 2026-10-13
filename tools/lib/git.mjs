import { execFileSync } from 'node:child_process'

/** `git <args>` stdout, trimmed; throws on a non-zero exit. `opts` reaches
 *  `execFileSync` (e.g. `stdio: 'inherit'` for a command the user watches). */
export function git(args, opts = {}) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim()
}
