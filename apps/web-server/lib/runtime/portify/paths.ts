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
  }
}
