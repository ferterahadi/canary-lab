import { execFileSync } from 'child_process'

/** Whether `command` resolves on PATH (`where` on Windows, `which` elsewhere).
 *  The one lookup for the CLI's client detection and the editor launcher. Agent
 *  binaries resolve through `agent-binary.ts` instead, which keeps its own
 *  lookup on purpose. */
export function commandAvailable(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(lookup, [command], { stdio: 'ignore' })
    return true
  } catch {
    // A non-zero exit or a missing lookup binary both mean "not on PATH".
    return false
  }
}
