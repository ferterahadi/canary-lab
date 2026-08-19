// The dependency surface every flights route module is constructed with.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { type FlightStore } from '../logic/store'
import { type StageAdapters } from '../logic/conductor'
import { PlanFeaturesStore } from '../logic/plan-features'
import type { FlightAgentSpawner } from '../logic/stages/context'
import { type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import type { GettingStartedSessionStore } from '../../config/logic/getting-started-session'

export interface FlightRouteDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
  /** Stage adapters the conductor drives (Phase 3 builds the real set; tests
   *  inject stubs). */
  adapters: StageAdapters
  /** Shared store (so WS + restart-reconcile see the same instance). Omitted
   *  in tests → a fresh file-backed store over logsDir. */
  flightStore?: FlightStore
  /** Shared plan-features store (boot reconcile owns it). Omitted in tests →
   *  a fresh file-backed store over logsDir. */
  planStore?: PlanFeaturesStore
  /** Test seam for the plan-features agent spawn. */
  planAgent?: FlightAgentSpawner
  workspaceEvents?: WorkspaceEventPublisher
  gettingStarted?: GettingStartedSessionStore
}
