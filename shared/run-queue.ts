/** A read-time snapshot of admission, never an execution verdict. */
export interface RunQueueDiagnostics {
  checkedAt: string
  reason: 'repo-collision' | 'run-limit' | 'memory' | 'cpu' | 'ready'
  activeRuns: Array<{ runId: string; feature: string; cost: number }>
  conflictingRunId?: string
  candidateCost: number
  usedSlots: number
  slotBudget: number
  maxConcurrentRuns: number | null
  freeMemBytes: number
}
