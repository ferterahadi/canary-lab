import fs from 'fs'
import { buildRunPaths } from '../../runs/logic/runtime/run-paths'
import { locateMostRecentAgentSessionRef, parseAgentSessionRefFile, selectAgentSessionRef, type AgentSessionRef } from './agent-session-log'

// A crash can leave the persisted reference stale. Discover on every call so
// snapshots and live tails both follow the newest session for this run.
export function resolveRunAgentSessionRef(runDir: string): AgentSessionRef | null {
  const found = locateMostRecentAgentSessionRef(runDir)
  if (found) return found
  let raw: string
  try { raw = fs.readFileSync(buildRunPaths(runDir).agentSessionRefPath, 'utf-8') }
  catch { return null /* missing or unreadable reference */ }
  const parsed = raw ? parseAgentSessionRefFile(raw) : null
  return parsed ? selectAgentSessionRef(parsed) : null
}
