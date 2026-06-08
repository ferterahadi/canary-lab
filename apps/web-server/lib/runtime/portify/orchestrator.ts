import type { PortifyManifest, PortifyRepoState, PortifyVerification } from './types'

// Sequences the port-ification lifecycle and owns the manifest as the source of
// truth, persisting on every transition (the poll/WS push point). All I/O is
// injected so the lifecycle + retry loop are unit-testable.
//
// run() resolves when the workflow reaches a state that awaits the USER:
// `ready-to-commit` (success), `failed` (gave up), or `aborted`. The commit and
// cancel actions are driven separately by the runner (which holds the worktree
// handle), since they happen after run() returns.

export interface PortifyOrchestratorDeps {
  manifest: PortifyManifest
  persist: (m: PortifyManifest) => void
  now: () => string
  isAborted?: () => boolean
  /** Create the branch + worktree off HEAD in every repo. Returns repo states. */
  setup: () => Promise<PortifyRepoState[]>
  /** Run the agent for this attempt; `failureDetail` is set on retries. */
  runAgent: (attempt: number, failureDetail?: string) => Promise<void>
  /** Resume the agent session with the user's review feedback (revise pass). */
  runFeedbackAgent: (feedback: string) => Promise<void>
  /** Unified diff of the agent's edits so far. */
  captureDiff: () => Promise<string>
  /** Boot twice on different ports; require both healthy. */
  verify: () => Promise<PortifyVerification>
  /** Guard: the change must not touch test files. */
  checkTestsUntouched: () => Promise<{ ok: boolean; offending: string[] }>
  /** Best-effort teardown (remove worktree + branch). Runs on failed/aborted only. */
  cleanup?: () => Promise<void>
}

export class PortifyOrchestrator {
  constructor(private readonly deps: PortifyOrchestratorDeps) {}

  async run(): Promise<PortifyManifest> {
    const d = this.deps
    let m: PortifyManifest = { ...d.manifest, status: 'planning' }
    d.persist(m)

    const finalizeAborted = async (): Promise<PortifyManifest> => {
      // Tear down BEFORE marking terminal so the workflow isn't reported done
      // while its worktree/branch/config are still being cleaned up.
      await d.cleanup?.()
      m = { ...m, status: 'aborted', endedAt: d.now() }
      d.persist(m)
      return m
    }

    try {
      const repos = await d.setup()
      if (d.isAborted?.()) return await finalizeAborted()
      m = { ...m, repos }
      d.persist(m)

      let lastFailure: string | undefined
      let diff: string | undefined
      let verification: PortifyVerification | undefined

      for (let attempt = 1; attempt <= m.maxAttempts; attempt++) {
        if (d.isAborted?.()) return await finalizeAborted()
        m = { ...m, status: 'editing', attempt }
        d.persist(m)

        await d.runAgent(attempt, lastFailure)
        if (d.isAborted?.()) return await finalizeAborted()

        diff = await d.captureDiff()
        m = { ...m, status: 'verifying', diff }
        d.persist(m)

        verification = await d.verify()
        if (d.isAborted?.()) return await finalizeAborted()

        if (verification.ok) {
          const tests = await d.checkTestsUntouched()
          if (!tests.ok) {
            // Treat a test edit as a verification failure and feed it back.
            lastFailure = `You modified test files (${tests.offending.join(', ')}). Revert them — this change must be ports-only.`
            verification = { ok: false, instances: verification.instances, failureDetail: lastFailure }
            m = { ...m, verification }
            d.persist(m)
            continue
          }
          m = { ...m, status: 'ready-to-commit', diff, verification }
          d.persist(m)
          return m
        }

        lastFailure = verification.failureDetail
        m = { ...m, verification }
        d.persist(m)
      }

      await d.cleanup?.()
      m = {
        ...m,
        status: 'failed',
        diff,
        verification,
        endedAt: d.now(),
        error: `verification did not pass after ${m.maxAttempts} attempt(s)`,
      }
      d.persist(m)
    } catch (err) {
      await d.cleanup?.()
      if (d.isAborted?.()) {
        m = { ...m, status: 'aborted', endedAt: d.now() }
      } else {
        m = { ...m, status: 'failed', endedAt: d.now(), error: err instanceof Error ? err.message : String(err) }
      }
      d.persist(m)
    }

    return m
  }

  // A user-driven revise pass, invoked after run() has parked at
  // `ready-to-commit`. The agent resumes its session, applies the human's
  // feedback, and the stack is re-verified. Unlike run()'s retry loop this
  // NEVER goes terminal: it always re-parks at `ready-to-commit` (worktree
  // preserved) carrying the latest verification — `verification.ok` gates
  // whether the diff may be committed. `feedbackRounds` is its own budget,
  // unbounded and independent of `attempt`/`maxAttempts`. `current` is the
  // live manifest the caller read from the store (the source of truth after
  // run() returned).
  async revise(current: PortifyManifest, feedback: string): Promise<PortifyManifest> {
    const d = this.deps
    if (d.isAborted?.()) return current

    let m: PortifyManifest = {
      ...current,
      status: 'editing',
      feedbackRounds: (current.feedbackRounds ?? 0) + 1,
      error: undefined,
    }
    d.persist(m)

    try {
      await d.runFeedbackAgent(feedback)
      if (d.isAborted?.()) return m

      const diff = await d.captureDiff()
      m = { ...m, status: 'verifying', diff }
      d.persist(m)

      let verification = await d.verify()
      if (d.isAborted?.()) return m

      if (verification.ok) {
        const tests = await d.checkTestsUntouched()
        if (!tests.ok) {
          verification = {
            ok: false,
            instances: verification.instances,
            failureDetail: `You modified test files (${tests.offending.join(', ')}). Revert them — this change must be ports-only.`,
          }
        }
      }

      m = { ...m, status: 'ready-to-commit', diff, verification }
      d.persist(m)
      return m
    } catch (err) {
      if (d.isAborted?.()) return m
      // Don't tear down on a revise error — re-park at ready-to-commit so the
      // user can give more feedback or commit the last good diff.
      m = { ...m, status: 'ready-to-commit', error: err instanceof Error ? err.message : String(err) }
      d.persist(m)
      return m
    }
  }
}
