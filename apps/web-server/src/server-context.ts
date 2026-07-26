import type { FastifyInstance } from 'fastify'
import type { ExternalHealBroker } from './features/runs/logic/heal/external-heal-broker'
import type { OrchestratorRegistry, RunStore } from './features/runs/logic/run-store'
import type { BenchmarkRunStore } from './features/benchmark/logic/runtime/store'
import type { PortifyRunStore } from './features/portify/logic/runtime/store'
import type { CoverageJobRunStore } from './features/coverage/logic/coverage/jobs/store'
import type { FlightRunStore } from './features/flights/logic/store'
import type { PlanFeaturesStore } from './features/flights/logic/plan-features'
import type { DirtySpecStore } from './features/runs/logic/dirty-specs/store'
import type { WorkspaceEventBus } from './shared/workspace-events'
import type { UpdateJobStore } from './features/version/logic/update-job'
import type { VersionState } from './features/version/logic/version-state'
import type { PaneBroker } from './features/runs/logic/pane-broker'
import type { PtyFactory } from './features/runs/logic/runtime/pty-spawner'
import type { WizardAgentRegistry } from './features/wizard/logic/wizard-agent-registry'
import type { BackupRecord } from './features/runs/logic/runtime/env-switcher/types'

/**
 * What `createServer` builds before any feature registers, and what every
 * feature's `register(app, ctx)` may read.
 *
 * These are the stores and buses whose *lifetime is the process*: one instance,
 * constructed and reconciled once at boot, shared by whichever features need
 * them. Anything a single feature owns end-to-end does not belong here — build
 * it inside that feature's `register`.
 */
export interface ServerContext {
  /** Resolved once in createServer; features must not re-derive them. */
  projectRoot: string
  featuresDir: string
  logsDir: string
  journalPath: string

  registry: OrchestratorRegistry
  runStore: RunStore
  benchmarkStore: BenchmarkRunStore
  portifyStore: PortifyRunStore
  coverageJobStore: CoverageJobRunStore
  flightStore: FlightRunStore
  planStore: PlanFeaturesStore
  dirtySpecStore: DirtySpecStore
  updateStore: UpdateJobStore
  versionState: VersionState
  workspaceEvents: WorkspaceEventBus
  externalHealBroker: ExternalHealBroker
  wizardAgents: WizardAgentRegistry

  /**
   * How PTY-backed agent processes get spawned. Injected by tests; shared by
   * every feature that launches an agent (runs, wizard, benchmark, portify),
   * which is why it is built once here rather than per feature.
   */
  ptyFactory: PtyFactory

  /** Live per-run pane brokers, keyed by run id. */
  brokers: Map<string, PaneBroker>
  /** Runs holding an applied envset, so it can be reverted on exit. */
  activeEnvsets: Map<string, BackupRecord[]>
}

/**
 * A feature's entry point. `createServer` calls these in order and knows
 * nothing else about the feature — adding or removing one should not require
 * editing anything but the call list.
 */
export type FeatureRegistrar = (app: FastifyInstance, ctx: ServerContext) => Promise<void> | void
