// A RunContext built for driving the heal loops directly, plus the RunLoopHost
// handle they call back into.
//
// The loops used to be reachable only through a live `RunOrchestrator`, which is
// why their cancel/abort arms were once written off as untestable races. Since
// the split they are plain functions over an explicit context, so a test can set
// `ctx.stopped` from inside a mocked collaborator and land in any window it
// likes — deterministically, with no timing involved.
import path from 'path'
import { vi } from 'vitest'
import { createRunContext, type RunContext } from '../run-context'
import type { RunLoopHost } from '../run-heal-loop'
import type { OrchestratorOptions } from '../run-orchestrator-types'
import type { RunStateSink } from '../run-state-sink'
import type { FeatureConfig } from '../../../../../../../../shared/launcher/types'

/** Records every write instead of touching disk. Implements the whole
 *  `RunStateSink` surface so a caller that reaches for a method this fixture
 *  forgot fails loudly at the type level rather than at runtime. */
export function fakeStateSink(): RunStateSink & { patches: Record<string, unknown>[] } {
  const patches: Record<string, unknown>[] = []
  const sink: RunStateSink = {
    bootstrap: vi.fn(),
    setStatus: vi.fn(),
    finalize: vi.fn(),
    setServiceStatus: vi.fn(),
    recordHeartbeat: vi.fn(),
    recordLifecycleEvent: vi.fn(),
    recordJournalChange: vi.fn(),
    patchManifest: vi.fn((_runId, patch) => { patches.push(patch as Record<string, unknown>) }),
  }
  return Object.assign(sink, { patches })
}

export interface TestRunContextOptions {
  root: string
  feature?: Partial<FeatureConfig>
  opts?: Partial<OrchestratorOptions>
  /** Applied after construction — the run-state fields are mutable by design. */
  state?: Partial<RunContext>
}

export function makeHealLoopContext(o: TestRunContextOptions): {
  ctx: RunContext
  events: Array<{ event: string; payload: unknown }>
  sink: ReturnType<typeof fakeStateSink>
} {
  const feature: FeatureConfig = {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(o.root, 'features', 'demo'),
    repos: [],
    ...o.feature,
  } as FeatureConfig
  const events: Array<{ event: string; payload: unknown }> = []
  const sink = fakeStateSink()
  const ctx = createRunContext(
    {
      feature,
      runId: 'r-heal-loop',
      runDir: path.join(o.root, 'logs', 'runs', 'r-heal-loop'),
      ptyFactory: () => { throw new Error('no pty in these tests') },
      runStateSink: sink,
      ...o.opts,
    } as OrchestratorOptions,
    ((event: string, payload: unknown) => { events.push({ event, payload }); return true }) as RunContext['emit'],
  )
  Object.assign(ctx, o.state ?? {})
  return { ctx, events, sink }
}

/** A RunLoopHost whose three callbacks are spies with sane default returns. */
export function makeLoopHost(over: Partial<RunLoopHost> = {}): RunLoopHost {
  return {
    restart: vi.fn(async () => ({ restarted: [], kept: [], startedBecauseMissing: [] })),
    rerun: vi.fn(async () => {}),
    recordBootFailureHealWait: vi.fn(),
    ...over,
  } as unknown as RunLoopHost
}
