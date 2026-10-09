import { spawnSync } from 'node:child_process'
import process from 'node:process'

/** Run a step with inherited output and end this script with the step's exit
 *  code when it fails. `options` reaches `spawnSync` (`cwd`, `env`). */
export function runOrExit(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
