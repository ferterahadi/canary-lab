import { useCallback, useState } from 'react'
import * as api from '@/shared/api/client'
import type { RepoCollisionChoice } from '@/shared/api/client'

// The run-start flow, lifted out of App so its branching (collision → isolate/
// queue prompt, branch-mismatch recovery, silent-failure guard) is exercised on
// its own instead of buried in the 800-line shell. The hook owns the two dialog
// states it drives (the collision prompt + the start-error) and takes its
// side-effects — starting a run, selecting the started run — as injected deps,
// so a test can drive the whole flow with stubs.

/** A same-repo collision (409) awaiting the user's isolate-vs-queue choice. */
export interface CollisionPrompt {
  feature: string
  env?: string
  mode?: 'test' | 'boot'
  info: RepoCollisionChoice
  /** Whether ports are injectable — lets the dialog offer the durable portify
   *  fix alongside worktree/queue. Best-effort (undefined if the probe failed). */
  portsConfigured?: boolean
}

/** A non-collision start failure (404 feature gone, 400 bad env, 5xx, network,
 *  or a branch mismatch), surfaced as a dialog so Run never dead-ends silently.
 *  Holds the params so the dialog's Retry can replay the start. */
export interface StartError {
  feature: string
  env?: string
  mode: 'test' | 'boot'
  error: unknown
}

export interface UseRunStartDeps {
  selectedFeature: string | null
  startRun: (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot') => Promise<string>
  startVerification: (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string },
  ) => Promise<string>
  /** Select a freshly-started run into the detail pane (skipped for boot runs). */
  onRunStarted: (runId: string) => void
}

export interface UseRunStart {
  collisionPrompt: CollisionPrompt | null
  setCollisionPrompt: (p: CollisionPrompt | null) => void
  startError: StartError | null
  setStartError: (e: StartError | null) => void
  /** `forFeature` overrides the current selection — the demo chooser starts the
   *  sample suite's run without waiting for `setSelectedFeature` to land, which
   *  a same-tick call would otherwise miss (this hook closes over the selection). */
  handleStartRun: (env?: string, mode?: 'test' | 'boot', forFeature?: string | null) => Promise<void>
  resolveCollision: (isolation: 'worktree' | 'queue') => Promise<void>
  switchBranchesAndRun: () => Promise<void>
  pinCurrentAndRun: () => Promise<void>
  handleStartVerification: (input: {
    configId?: string
    targetUrls?: Record<string, string>
    playwrightEnvsetId?: string
  }) => Promise<void>
}

export function useRunStart({ selectedFeature, startRun, startVerification, onRunStarted }: UseRunStartDeps): UseRunStart {
  const [collisionPrompt, setCollisionPrompt] = useState<CollisionPrompt | null>(null)
  const [startError, setStartError] = useState<StartError | null>(null)

  const handleStartRun = useCallback(async (
    env?: string,
    mode: 'test' | 'boot' = 'test',
    forFeature?: string | null,
  ): Promise<void> => {
    const feature = forFeature ?? selectedFeature
    if (!feature) return
    // Concurrent runs are allowed: different apps run in parallel on distinct
    // allocated ports; the backend admits or queues as resources allow. A
    // same-repo collision comes back as a 409 — prompt to isolate or queue, then
    // re-issue with the choice (preserving the boot/test mode).
    try {
      const runId = await startRun(feature, env, undefined, mode)
      // Boot sessions are managed in the global Services overlay, never column 3.
      if (mode !== 'boot') onRunStarted(runId)
    } catch (err) {
      const collision = api.asRepoCollision(err)
      if (collision) {
        // The one case where hardcoded ports actually clash — check whether ports
        // are injectable so the dialog can offer the durable fix. Best-effort.
        let portsConfigured: boolean | undefined
        try { portsConfigured = (await api.benchmarkPreflight(feature, env)).portsConfigured } catch { /* ignore */ }
        setCollisionPrompt({ feature, env, mode, info: collision, portsConfigured })
        return
      }
      setStartError({ feature, env, mode, error: err })
    }
  }, [selectedFeature, startRun, onRunStarted])

  const resolveCollision = useCallback(async (isolation: 'worktree' | 'queue'): Promise<void> => {
    const prompt = collisionPrompt
    setCollisionPrompt(null)
    if (!prompt) return
    try {
      const runId = await startRun(prompt.feature, prompt.env, isolation, prompt.mode)
      if (prompt.mode !== 'boot') onRunStarted(runId)
    } catch (err) {
      setStartError({ feature: prompt.feature, env: prompt.env, mode: prompt.mode ?? 'test', error: err })
    }
  }, [collisionPrompt, startRun, onRunStarted])

  // Branch-mismatch recovery (from the RunStartErrorDialog). Both throw on
  // failure so the dialog surfaces it inline and stays open; on success they
  // clear the error and replay the original start. handleStartRun's own catch
  // re-populates startError if the replay hits a fresh failure.
  const switchBranchesAndRun = useCallback(async (): Promise<void> => {
    const se = startError
    const mismatch = se && api.asBranchMismatch(se.error)
    if (!se || !mismatch) return
    for (const repo of mismatch.repos) {
      await api.checkoutRepoBranch(se.feature, repo.name, repo.expected)
    }
    setStartError(null)
    await handleStartRun(se.env, se.mode)
  }, [startError, handleStartRun])

  const pinCurrentAndRun = useCallback(async (): Promise<void> => {
    const se = startError
    if (!se) return
    await api.pinFeatureBranchesToCurrent(se.feature)
    setStartError(null)
    await handleStartRun(se.env, se.mode)
  }, [startError, handleStartRun])

  const handleStartVerification = useCallback(async (input: {
    configId?: string
    targetUrls?: Record<string, string>
    playwrightEnvsetId?: string
  }): Promise<void> => {
    if (!selectedFeature) return
    const runId = await startVerification(selectedFeature, input)
    onRunStarted(runId)
  }, [selectedFeature, startVerification, onRunStarted])

  return {
    collisionPrompt,
    setCollisionPrompt,
    startError,
    setStartError,
    handleStartRun,
    resolveCollision,
    switchBranchesAndRun,
    pinCurrentAndRun,
    handleStartVerification,
  }
}
