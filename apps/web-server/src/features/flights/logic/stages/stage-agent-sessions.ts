import fs from 'fs'
import path from 'path'
import { writeWorkflowAgentRef } from '../../../agent-sessions/logic/agent-session-log'
import type { StageContext } from '../conductor'
import type { FlightStageAgentSession, FlightStageKey } from '../types'

/** Preserve one immutable ref before a stage's mutable live sidecar is reused.
 *  The existing REST + WebSocket readers can then replay every session without
 *  learning a second reference format. */
export function recordStageAgentSession({
  ctx,
  stage,
  cwd,
  session,
  describe,
}: {
  ctx: StageContext
  stage: FlightStageKey
  cwd: string
  session: { agent: 'claude' | 'codex'; sessionId: string; spawnedAt: string }
  describe: (sequence: number) => Pick<FlightStageAgentSession, 'label' | 'phase' | 'pass'>
}): void {
  const owner = ctx.manifest().stages.find((candidate) => candidate.key === stage)
  const sequence = (owner?.agentSessions?.length ?? 0) + 1
  const sidecar = `${stage}-session-${String(sequence).padStart(3, '0')}`
  const sessionDir = path.join(ctx.flightDir, sidecar)
  writeWorkflowAgentRef(sessionDir, {
    agent: session.agent,
    cwd,
    spawnedAt: session.spawnedAt,
    sessionId: session.sessionId,
  })
  // writeWorkflowAgentRef is deliberately best-effort. Do not persist a
  // pointer the viewer can never resolve when that write failed.
  if (!fs.existsSync(path.join(sessionDir, 'agent-session.json'))) return
  ctx.addAgentSession({
    sidecar,
    startedAt: session.spawnedAt,
    ...describe(sequence),
  })
}
