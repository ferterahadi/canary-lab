import type { FlightManifest } from '../../types'
import type { StageContext } from '../../conductor'

// One StageContext test double for every stage suite.
//
// Seventeen stage tests each hand-rolled this object with the same six members.
// When `setAgentActivity` was added to `StageContext`, all seventeen went stale
// at once — and nothing failed, because CI typechecks only what is reachable
// from the CLI and that excludes test files. They were still *running* green:
// every stage under test that calls `ctx.setAgentActivity` was reaching a
// property that did not exist on the double.
//
// So the fix is not seventeen copies of one more no-op line. Everything inert
// lives here, and a suite supplies only the parts that carry its state. The next
// member added to `StageContext` is one edit, and a suite that needs to observe
// it overrides it.

export interface StageContextStubOptions {
  /** The manifest snapshot under test — usually a closure over mutable state. */
  manifest: () => FlightManifest
  flightDir: string
  patchFlight: StageContext['patchFlight']
  /** Override only to ASSERT on them. Default to no-ops, because a stage
   *  writing to its display log is not what most of these suites are testing. */
  appendLog?: StageContext['appendLog']
  setProgress?: StageContext['setProgress']
  setAgentActivity?: StageContext['setAgentActivity']
  addAgentSession?: StageContext['addAgentSession']
  /** Override to drive the pause/abort paths. */
  signal?: AbortSignal
}

export function stageContextStub(opts: StageContextStubOptions): StageContext {
  return {
    manifest: opts.manifest,
    flightDir: opts.flightDir,
    signal: opts.signal ?? new AbortController().signal,
    appendLog: opts.appendLog ?? ((): void => {}),
    setProgress: opts.setProgress ?? ((): void => {}),
    setAgentActivity: opts.setAgentActivity ?? ((): void => {}),
    addAgentSession: opts.addAgentSession ?? ((): void => {}),
    patchFlight: opts.patchFlight,
  }
}
