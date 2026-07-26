// The run's pointer to whichever agent CLI session log belongs to it.
//
// The UI's structured historical replay reads the agent's own JSONL rather
// than our PTY byte capture, so `<runDir>/agent-session.json` is what makes an
// old heal cycle re-readable at all. Getting it wrong is invisible during the
// run and only shows up later as a blank agent view.
//
// Split out of orchestrator.ts: this is path bookkeeping over two files, with
// none of the run loop's state, which is what lets it be tested directly
// instead of only by driving a live heal cycle.

import fs from 'fs'
import path from 'path'
import { readPriorSessionId, readPriorSessionIdFromValue } from './auto-heal'
import {
  locateClaudeSessionLog,
  locateCodexSessionLog,
  locateLatestSessionLogForAgent,
  parseAgentSessionRefFile,
  renderAgentSessionContext,
  type AgentSessionRef,
  type AgentSessionRefFile,
} from '../../../agent-sessions/logic/agent-session-log'

export type AgentSessionAgent = 'claude' | 'codex'

export interface AgentSessionRefPaths {
  runDir: string
  agentSessionRefPath: string
  agentSessionIdPath: string
}

export class AgentSessionRefStore {
  // In-memory mirror of `agentSessionRefPath`. `undefined` means we haven't
  // read disk yet; `null` means we read and the file is missing or invalid.
  // This store is the only writer, so once seeded we trust the cache and
  // update it in lockstep with `write`.
  private cached: AgentSessionRefFile | null | undefined = undefined

  constructor(private readonly paths: AgentSessionRefPaths) {}

  read(): AgentSessionRefFile | null {
    if (this.cached !== undefined) return this.cached
    try {
      this.cached = parseAgentSessionRefFile(fs.readFileSync(this.paths.agentSessionRefPath, 'utf-8'))
    } catch {
      this.cached = null
    }
    return this.cached
  }

  write(ref: AgentSessionRef): void {
    const existing = this.read() ?? { sessions: {} }
    const next: AgentSessionRefFile = {
      activeAgent: ref.agent,
      sessions: { ...existing.sessions, [ref.agent]: ref },
    }
    try {
      fs.mkdirSync(path.dirname(this.paths.agentSessionRefPath), { recursive: true })
      fs.writeFileSync(this.paths.agentSessionRefPath, JSON.stringify(next, null, 2))
      fs.writeFileSync(this.paths.agentSessionIdPath, ref.sessionId)
      this.cached = next
    } catch { /* best-effort */ }
  }

  // Point the run at the agent CLI's own JSONL session log.
  //
  // - claude: the log path is fully determined by runDir + sessionId, so we
  //   just verify the file exists at the predicted location.
  // - codex: the first launch has no `--session-id` flag, so we discover by
  //   matching cwd + timestamp; locateCodexSessionLog does the directory scan.
  //   After discovery, persist the id for future `codex resume <id>`.
  //
  // Silently skips when the agent never spawned (manual mode, no failure) or
  // when the locator can't find the file (race, user moved it).
  persistActive(active: {
    agent: AgentSessionAgent
    sessionId?: string
    startedAt?: string
  }): void {
    let ref: AgentSessionRef | null = null
    if (active.agent === 'claude' && active.sessionId) {
      const logPath = locateClaudeSessionLog(this.paths.runDir, active.sessionId)
      if (logPath) ref = { agent: 'claude', sessionId: active.sessionId, logPath }
    } else if (active.agent === 'codex' && active.startedAt) {
      const found = locateCodexSessionLog(this.paths.runDir, active.startedAt)
      if (found) ref = found
    }
    if (!ref) return
    this.write(ref)
  }

  // The id to resume, if this agent already ran in this run dir. Falls back to
  // the flat id file written by older runs, then to scanning the agent's own
  // session directory — a resume that silently starts a fresh conversation
  // loses everything the prior cycle learned.
  priorSessionId(agent: AgentSessionAgent): string | null {
    const refFile = this.read()
    const typed = refFile?.sessions[agent]
    if (typed) return readPriorSessionIdFromValue(typed.sessionId)

    if (!refFile) {
      const direct = readPriorSessionId(this.paths.agentSessionIdPath)
      if (direct) return direct
    }

    const found = locateLatestSessionLogForAgent(agent, this.paths.runDir)
    if (found) {
      this.write(found)
      return found.sessionId
    }
    return null
  }

  // Rendered transcript of what the OTHER agent did in this run, so a handoff
  // between claude and codex doesn't start from nothing.
  crossAgentContext(targetAgent: AgentSessionAgent): string | undefined {
    const previous = this.findPriorRef(targetAgent)
    if (!previous) return undefined
    return renderAgentSessionContext(previous) || undefined
  }

  findPriorRef(targetAgent: AgentSessionAgent): AgentSessionRef | null {
    const otherAgent: AgentSessionAgent = targetAgent === 'claude' ? 'codex' : 'claude'
    const other = this.read()?.sessions[otherAgent]
    if (other) return other
    return locateLatestSessionLogForAgent(otherAgent, this.paths.runDir)
  }
}
