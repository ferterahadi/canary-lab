export type AgentSessionIdentity =
  | { kind: 'discovery-repair'; taskId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'benchmark'; benchmarkId: string }
  | { kind: 'portify'; workflowId: string }
  | { kind: 'coverage'; jobId: string }
  | { kind: 'evaluation'; taskId: string }
  | { kind: 'flight'; flightId: string; stage: string }
  | { kind: 'flight-plan'; taskId: string }

/** Identity excludes liveness so switching to history keeps the same session. */
export function sourceIdentityKey(source: AgentSessionIdentity): string {
  switch (source.kind) {
    case 'discovery-repair': return `discovery-repair:${source.taskId}`
    case 'run': return `run:${source.runId}`
    case 'benchmark': return `benchmark:${source.benchmarkId}`
    case 'portify': return `portify:${source.workflowId}`
    case 'coverage': return `coverage:${source.jobId}`
    case 'evaluation': return `evaluation:${source.taskId}`
    case 'flight': return `flight:${source.flightId}:${source.stage}`
    case 'flight-plan': return `flight-plan:${source.taskId}`
  }
}

export function sourceCacheKey(source: AgentSessionIdentity & { live?: boolean }): string {
  return `${sourceIdentityKey(source)}:${source.live ? '1' : '0'}`
}
