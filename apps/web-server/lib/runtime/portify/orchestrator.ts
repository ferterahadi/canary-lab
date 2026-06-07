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
}
