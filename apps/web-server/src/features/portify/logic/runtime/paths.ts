import path from 'path'

// Per-workflow directory layout under `<logs>/portify/`. Mirrors benchmark/paths.

export interface PortifyPaths {
  dir: string
  manifestPath: string
  /** The agent's captured output (for live visibility + the AgentSessionView). */
  agentLogPath: string
  /** Service logs from the verification double-boot, keyed by instance + service. */
  verifyLogDir: string
  /** Snapshot of the feature config BEFORE the agent edits it — lets startup
   *  reclaim restore the config after a crash (the in-memory copy is gone). */
  originalConfigPath: string
  /** Overlay capture persisted whenever the workflow parks at `ready-to-save`
   *  with a PASSING verification. A parked review must survive a server
   *  restart: the worktrees live in server memory, so without this snapshot a
   *  restart turns an already-verified diff into an unanswerable checkpoint
   *  (save → 409). `save()` falls back to this file when the live state is
   *  gone; startup reclaim keeps such workflows parked instead of aborting. */
  pendingOverlayPath: string
}

export function portifyRoot(logsDir: string): string {
  return path.join(logsDir, 'portify')
}

export function portifyIndexPath(logsDir: string): string {
  return path.join(portifyRoot(logsDir), 'index.json')
}

export function portifyDir(logsDir: string, workflowId: string): string {
  return path.join(portifyRoot(logsDir), workflowId)
}

export function buildPortifyPaths(dir: string): PortifyPaths {
  return {
    dir,
    manifestPath: path.join(dir, 'portify.json'),
    agentLogPath: path.join(dir, 'agent.log'),
    verifyLogDir: path.join(dir, 'verify'),
    originalConfigPath: path.join(dir, 'original-config.snapshot'),
    pendingOverlayPath: path.join(dir, 'pending-overlay.json'),
  }
}
