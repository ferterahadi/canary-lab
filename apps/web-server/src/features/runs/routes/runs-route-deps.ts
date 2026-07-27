
import fs from 'fs'
import path from 'path'
import type { RunStore, RestartHealResult, RestartRunResult, StartRunOutcome } from '../logic/run-store'
import type { ExecutionType } from '../../../../../../shared/verification'
import type { ExternalHealBroker } from '../logic/heal/external-heal-broker'
import { type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { ExternalHealAgentRequest } from './runs-route-support'

export { compareActiveRuns } from './runs-route-support'
export type { ExternalHealAgentRequest } from './runs-route-support'

export interface RunsRouteDeps {
  featuresDir: string
  projectRoot?: string
  /** Single source of truth for run state. Routes read + mutate exclusively
   *  through this — no direct manifest/index file access. */
  store: RunStore
  // Factory: given a feature name + optional healAgent override, build + start
  // an orchestrator. Returns the orchestrator synchronously after `start()` is
  // in flight (the factory awaits the initial spawn but not test completion).
  // When `healAgent.kind === 'external'`, the orchestrator must be configured
  // with externalHeal=true and the external-heal broker claim should be
  // bootstrapped before the orchestrator's heal-loop entry condition triggers.
  startRun(
    feature: string,
    env?: string,
    healAgent?: ExternalHealAgentRequest,
    isolation?: 'worktree' | 'queue',
    executionType?: ExecutionType,
  ): Promise<StartRunOutcome>
  /** Cancel a run still waiting in the admission queue (no orchestrator yet).
   *  Returns true when it was queued and is now aborted. */
  cancelQueuedRun?(runId: string): boolean
  /** Whether a worktree's owning run/benchmark is still active (non-terminal),
   *  so the cleanup UI can refuse to remove a worktree in use. Wired in the
   *  server factory where both the run + benchmark stores are in scope. */
  isWorktreeOwnerActive?(kind: 'run' | 'benchmark', id: string): boolean
  broker?: Pick<ExternalHealBroker, 'claim'>
  workspaceEvents?: WorkspaceEventPublisher
  restartHeal?(runId: string, text: string): Promise<RestartHealResult>
  restartRun?(runId: string): Promise<RestartRunResult>
}
