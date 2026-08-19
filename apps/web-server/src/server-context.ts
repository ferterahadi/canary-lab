import type { FastifyInstance } from 'fastify'
import type { TestsDraftRouteDeps } from './features/wizard/routes/tests-draft'
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
import type { BackupRecord } from './features/runs/logic/runtime/env-switcher/types'
import type { GettingStartedSessionStore } from './features/config/logic/getting-started-session'

/**
 * The inputs `createServer` takes.
 *
 * Declared here rather than in `server.ts` because of the direction of the
 * dependency, not for tidiness. `server.ts` is the composition root: it imports
 * all ten feature registrars, and each of those imports `ServerContext` from
 * this file. When this file also reached back into `server.ts` for this one
 * type, that closed the loop — server → features → server-context → server —
 * and welded every server feature into a single 16-module strongly-connected
 * component. Ten features that are supposed to be independent were mutually
 * reachable, which is what makes "change one thing, recompile and re-reason
 * about everything" the normal experience.
 *
 * The edge was type-only, so nothing failed at runtime and nothing in CI
 * objected; `tools/check-import-cycles.mjs` now holds the line.
 *
 * `server.ts` re-exports this so `createServer`'s published surface is
 * unchanged.
 */
export interface CreateServerOptions {
  projectRoot: string
  featuresDir?: string
  logsDir?: string
  journalPath?: string
  // Override the wizard agent spawners — tests inject sync stubs.
  testsDraftDepsOverride?: Partial<TestsDraftRouteDeps>
  // Override the pty factory used by the wizard runner. Production uses
  // the real node-pty factory; tests skip this branch by passing
  // `testsDraftDepsOverride` instead.
  ptyFactory?: PtyFactory
  // Host hook invoked after a port change is persisted via the Project
  // Settings dialog. The host (canary-lab ui) relaunches on the new port and
  // shuts this process down. Absent in tests / non-CLI embeddings.
  onPortChange?: (port: number) => void | Promise<void>
}

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
  /**
   * The raw createServer options. Features read the test seams from here
   * (ptyFactory override, testsDraftDepsOverride, onPortChange); the derived
   * paths below are the resolved forms and should be preferred.
   */
  options: CreateServerOptions

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
  gettingStarted: GettingStartedSessionStore
  externalHealBroker: ExternalHealBroker

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
