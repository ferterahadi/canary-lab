import { spawnSync } from 'child_process'

export interface ProcessTreeTarget {
  pid?: number
  kill(signal?: NodeJS.Signals): unknown
}

interface ProcessTreeSignalDeps {
  platform?: NodeJS.Platform
  killGroup?: typeof process.kill
  taskkill?: (args: string[]) => void
}

/** A pid that is safe to negate into a Unix process-group id or pass to
 *  taskkill. pid 1 and below can target the caller's whole session instead of
 *  the child tree, so they must always fall back to the handle itself. */
export function canSignalProcessGroup(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

/** Signal one process and everything it spawned. Unix callers must have started
 *  the child detached so its pid is also its process-group id. Windows has no
 *  negative-pid group signal, so taskkill /T is the native tree boundary. */
export function signalProcessTree(
  target: ProcessTreeTarget,
  signal: NodeJS.Signals | number,
  opts: { detachedProcessGroup: boolean },
  deps: ProcessTreeSignalDeps = {},
): void {
  const platform = deps.platform ?? process.platform
  const pid = target.pid
  if (canSignalProcessGroup(pid)) {
    if (platform === 'win32') {
      try {
        const taskkill = deps.taskkill ?? ((args: string[]) => {
          const result = spawnSync('taskkill', args, { stdio: 'ignore' })
          if (result.error) throw result.error
          if (result.status !== 0) throw new Error(`taskkill exited ${result.status}`)
        })
        taskkill(['/pid', String(pid), '/T', ...(signal === 'SIGKILL' || signal === 9 ? ['/F'] : [])])
        return
      } catch { /* fall through to the direct child */ }
    } else if (opts.detachedProcessGroup) {
      try {
        const killGroup = deps.killGroup ?? process.kill
        killGroup(-pid, signal)
        return
      } catch { /* fall through to the direct child */ }
    }
  }
  try { target.kill(typeof signal === 'string' ? signal : undefined) } catch { /* already dead */ }
}

/** Whether any member of a detached Unix process group is still alive. A false
 *  result is also the safe answer for an invalid pid: there is no group we are
 *  authorised to probe. */
export function processGroupAlive(
  pid: number | undefined,
  killGroup: typeof process.kill = process.kill,
): boolean {
  if (!canSignalProcessGroup(pid)) return false
  try {
    killGroup(-pid, 0)
    return true
  } catch {
    return false
  }
}
