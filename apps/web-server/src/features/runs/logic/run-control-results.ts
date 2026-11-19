export type PauseResult =
  | { ok: true; failureCount: number }
  | { ok: false; reason: 'already-healing' | 'no-playwright-running' | 'no-failures-yet' }

/** Who ended an in-flight heal, when it was not the user. The default (no
 *  ending) is the user's Stop heal; each variant records a distinct reason so
 *  the run's Overview, Heal Agent timeline and lifecycle never read an agent's
 *  conclusion or an agent that went away as "stopped by you". */
export type HealEnding =
  | { kind: 'agent-ended'; reason: string; client: string }
  | { kind: 'agent-disconnected'; client: string; lastHeartbeatAt: string }

export type CancelHealResult =
  | { ok: true }
  | { ok: false; reason: 'not-healing' | 'no-agent-running' }

export type InterjectResult =
  | { ok: true }
  | { ok: false; reason: 'no-agent-running' }

export type AdoptSpecEditsResult =
  | { ok: true; adopted: string[]; rerun: 'signalled' | 'not-waiting-for-signal' | 'signal-already-pending' }
  | { ok: false; reason: 'tests-running' | 'nothing-to-adopt' | 'snapshot-failed' | 'review-changed' }

export type RestoreSpecEditsResult =
  | { ok: true; restored: string[] }
  | { ok: false; reason: 'tests-running' | 'nothing-to-restore' | 'restore-failed' | 'review-changed' }
