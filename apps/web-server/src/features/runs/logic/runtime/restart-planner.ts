import path from 'path'
import type { ServiceSpec } from './orchestrator'

// Pure path-prefix matching: given the absolute paths the heal agent claims to
// have changed (from a `.restart` signal body), determine which services need
// restart.
//
// Behaviour:
// - `filesChanged` empty → caller falls back to "restart all" (legacy
//   semantics). This module returns `{ toRestart: [], toKeep: services }` so
//   the orchestrator knows nothing matched but the caller decides.
// - `filesChanged` non-empty → match each path against each service's `cwd`
//   prefix. A service is restarted if any changed file lives under its cwd.
// - `filesChanged` non-empty but nothing matches → return empty `toRestart`
//   AND empty `toKeep` would be wrong (services are still running). Caller
//   surfaces a warning. We return `{ toRestart: [], toKeep: services }` and
//   set `noMatch: true` so the orchestrator can distinguish from the empty
//   list case.

export interface RestartPlan {
  toRestart: string[]
  toKeep: string[]
  /** True iff `filesChanged` was non-empty but no service matched. */
  noMatch: boolean
}

export function planRestart(
  filesChanged: readonly string[],
  services: readonly ServiceSpec[],
): RestartPlan {
  if (filesChanged.length === 0) {
    return { toRestart: [], toKeep: services.map((s) => s.safeName), noMatch: false }
  }

  const resolvedFiles = filesChanged.map((f) => path.resolve(f))
  const toRestart: string[] = []
  const toKeep: string[] = []

  for (const svc of services) {
    const svcCwd = path.resolve(svc.cwd)
    const matches = resolvedFiles.some((f) => isUnder(f, svcCwd))
    if (matches) toRestart.push(svc.safeName)
    else toKeep.push(svc.safeName)
  }

  return {
    toRestart,
    toKeep,
    noMatch: toRestart.length === 0,
  }
}

function isUnder(file: string, dir: string): boolean {
  if (file === dir) return true
  const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep
  return file.startsWith(withSep)
}
