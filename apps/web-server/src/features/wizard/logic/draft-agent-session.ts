import fs from 'fs'
import { locateCodexSessionLog, type AgentKind, type AgentSessionRef } from '../../agent-sessions/logic/agent-session-log'

export function resolveDraftStageSessionRef(input: {
  ref?: AgentSessionRef
  agent?: AgentKind
  draftDir: string
  spawnedAt?: string
  homeDir?: string
}): AgentSessionRef | null {
  if (input.ref?.logPath && fs.existsSync(input.ref.logPath)) {
    return isSessionFresh(input.ref.logPath, input.spawnedAt) ? input.ref : null
  }

  const agent = input.ref?.agent ?? input.agent
  if (agent !== 'codex' || !input.spawnedAt) return null
  return locateCodexSessionLog(input.draftDir, input.spawnedAt, input.homeDir)
}

function isSessionFresh(logPath: string, spawnedAt?: string): boolean {
  if (!spawnedAt) return true
  const spawnedMs = Date.parse(spawnedAt)
  if (!Number.isFinite(spawnedMs)) return false
  try {
    const stat = fs.statSync(logPath)
    return stat.mtimeMs >= spawnedMs - 1000
  } catch {
    return false
  }
}
