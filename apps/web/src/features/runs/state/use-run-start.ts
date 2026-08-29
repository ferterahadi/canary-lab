import { useCallback, useState } from 'react'
import * as api from '@/shared/api/client'
import type { AgentModelsConfig, AgentStagePlans, ModelAgentKind, RepoCollisionChoice } from '@/shared/api/client'
import { EMPTY_AGENT_MODELS } from '@shared/agent-models'
import type { RunStartModels } from './RunsContext'

// The run-start flow, lifted out of App so its branching (models gate →
// collision → isolate/queue prompt, branch-mismatch recovery, silent-failure
// guard) is exercised on its own instead of buried in the 800-line shell. The
// hook owns the three dialog states it drives (the models gate + the collision
// prompt + the start-error) and takes its side-effects — starting a run,
// selecting the started run — as injected deps, so a test can drive the whole
// flow with stubs.

/** A same-repo collision (409) awaiting the user's isolate-vs-queue choice. */
export interface CollisionPrompt {
  feature: string
  env?: string
  /** Required, not optional: `handleStartRun` is the only producer and always
   *  resolves a mode, so the retry cannot silently downgrade a boot to a test
   *  run — and there is no untestable fallback to carry. */
  mode: 'test' | 'boot'
  info: RepoCollisionChoice
  /** Whether ports are injectable — lets the dialog offer the durable portify
   *  fix alongside worktree/queue. Best-effort (undefined if the probe failed). */
  portsConfigured?: boolean
  /** The models-gate answer, carried so the isolate/queue retry keeps it. */
  models?: RunStartModels
}

/** A non-collision start failure (404 feature gone, 400 bad env, 5xx, network,
 *  or a branch mismatch), surfaced as a dialog so Run never dead-ends silently.
 *  Holds the params so the dialog's Retry can replay the start. */
export interface StartError {
  feature: string
  env?: string
  mode: 'test' | 'boot'
  error: unknown
  /** The models-gate answer, carried so a replay doesn't re-ask the gate. */
  models?: RunStartModels
}

/** A test run parked on the models gate ("use defaults or customize?") —
 *  produced only when the workspace armed `askModelsOnLaunch`. Boot runs skip
 *  it (they spawn no heal/commit agents), hence the narrowed mode. */
export interface RunModelsPrompt {
  feature: string
  env?: string
  mode: 'test'
  /** The heal agent's vocabulary — the gate's rows show this agent's models. */
  agent: ModelAgentKind
  /** The saved defaults the gate resolves and previews. */
  agentModels: AgentModelsConfig
}

export interface UseRunStartDeps {
  selectedFeature: string | null
  startRun: (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot', models?: RunStartModels) => Promise<string>
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
  modelsPrompt: RunModelsPrompt | null
  setModelsPrompt: (p: RunModelsPrompt | null) => void
  /** `forFeature` overrides the current selection — the demo chooser starts the
   *  sample suite's run without waiting for `setSelectedFeature` to land, which
   *  a same-tick call would otherwise miss (this hook closes over the selection). */
  handleStartRun: (env?: string, mode?: 'test' | 'boot', forFeature?: string | null) => Promise<void>
  /** The models gate's confirm: null = use defaults (send nothing). */
  resolveModelsPrompt: (models: AgentStagePlans | null) => Promise<void>
  resolveCollision: (isolation: 'worktree' | 'queue') => Promise<void>
  /** The error dialog's Retry: replays the exact failed start (same feature,
   *  same models-gate answer) instead of re-deriving from current selection. */
  retryStartError: () => Promise<void>
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
  const [modelsPrompt, setModelsPrompt] = useState<RunModelsPrompt | null>(null)

  // The actual start + its failure branching, shared by the gate's confirm and
  // the error-dialog replays so none of them re-enters the models gate.
  const begin = useCallback(async (
    feature: string,
    env: string | undefined,
    isolation: 'worktree' | 'queue' | undefined,
    mode: 'test' | 'boot',
    models: RunStartModels | undefined,
  ): Promise<void> => {
    // Concurrent runs are allowed: different apps run in parallel on distinct
    // allocated ports; the backend admits or queues as resources allow. A
    // same-repo collision comes back as a 409 — prompt to isolate or queue, then
    // re-issue with the choice (preserving the boot/test mode).
    try {
      const runId = await startRun(feature, env, isolation, mode, models)
      // Boot sessions are managed in the global Services overlay, never column 3.
      if (mode !== 'boot') onRunStarted(runId)
    } catch (err) {
      const collision = api.asRepoCollision(err)
      if (collision) {
        // The one case where hardcoded ports actually clash — check whether ports
        // are injectable so the dialog can offer the durable fix. Best-effort.
        let portsConfigured: boolean | undefined
        try { portsConfigured = (await api.benchmarkPreflight(feature, env)).portsConfigured } catch { /* ignore */ }
        setCollisionPrompt({ feature, env, mode, info: collision, portsConfigured, models })
        return
      }
      setStartError({ feature, env, mode, error: err, models })
    }
  }, [startRun, onRunStarted])

  const handleStartRun = useCallback(async (
    env?: string,
    mode: 'test' | 'boot' = 'test',
    forFeature?: string | null,
  ): Promise<void> => {
    const feature = forFeature ?? selectedFeature
    if (!feature) return
    // The models gate (2.2.0): when the workspace armed askModelsOnLaunch, a
    // test run parks on "use defaults or customize?" before starting. Boot runs
    // skip it — they spawn no heal/commit agents. Config unreachable → start
    // with defaults rather than dead-ending the Run button on a probe.
    if (mode !== 'boot') {
      let config: api.ProjectConfig | null = null
      try { config = await api.getProjectConfig() } catch { /* gate is best-effort */ }
      if (config?.askModelsOnLaunch === true) {
        setModelsPrompt({
          feature,
          env,
          mode,
          agent: config.healAgent === 'codex' ? 'codex' : 'claude',
          agentModels: config.agentModels ?? EMPTY_AGENT_MODELS,
        })
        return
      }
    }
    await begin(feature, env, undefined, mode, undefined)
  }, [selectedFeature, begin])

  const resolveModelsPrompt = useCallback(async (models: AgentStagePlans | null): Promise<void> => {
    const prompt = modelsPrompt
    setModelsPrompt(null)
    if (!prompt) return
    // The gate's grid is scoped to the run stages, so the plans carry at most
    // heal + commit; null (the defaults card) sends nothing and the server
    // resolves the saved config itself.
    await begin(prompt.feature, prompt.env, undefined, prompt.mode, models ?? undefined)
  }, [modelsPrompt, begin])

  const resolveCollision = useCallback(async (isolation: 'worktree' | 'queue'): Promise<void> => {
    const prompt = collisionPrompt
    setCollisionPrompt(null)
    if (!prompt) return
    // Deliberately NOT via `begin`: a failure of the isolated retry goes
    // straight to startError — re-classifying it as a collision would loop the
    // user back into the prompt they just answered.
    try {
      const runId = await startRun(prompt.feature, prompt.env, isolation, prompt.mode, prompt.models)
      if (prompt.mode !== 'boot') onRunStarted(runId)
    } catch (err) {
      setStartError({ feature: prompt.feature, env: prompt.env, mode: prompt.mode, error: err, models: prompt.models })
    }
  }, [collisionPrompt, startRun, onRunStarted])

  const retryStartError = useCallback(async (): Promise<void> => {
    const se = startError
    if (!se) return
    setStartError(null)
    await begin(se.feature, se.env, undefined, se.mode, se.models)
  }, [startError, begin])

  // Branch-mismatch recovery (from the RunStartErrorDialog). Both throw on
  // failure so the dialog surfaces it inline and stays open; on success they
  // clear the error and replay the original start — through `begin`, so the
  // models-gate answer is kept and the user isn't asked twice. `begin`'s own
  // catch re-populates startError if the replay hits a fresh failure.
  const switchBranchesAndRun = useCallback(async (): Promise<void> => {
    const se = startError
    const mismatch = se && api.asBranchMismatch(se.error)
    if (!se || !mismatch) return
    for (const repo of mismatch.repos) {
      await api.checkoutRepoBranch(se.feature, repo.name, repo.expected)
    }
    setStartError(null)
    await begin(se.feature, se.env, undefined, se.mode, se.models)
  }, [startError, begin])

  const pinCurrentAndRun = useCallback(async (): Promise<void> => {
    const se = startError
    if (!se) return
    await api.pinFeatureBranchesToCurrent(se.feature)
    setStartError(null)
    await begin(se.feature, se.env, undefined, se.mode, se.models)
  }, [startError, begin])

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
    modelsPrompt,
    setModelsPrompt,
    handleStartRun,
    resolveModelsPrompt,
    resolveCollision,
    retryStartError,
    switchBranchesAndRun,
    pinCurrentAndRun,
    handleStartVerification,
  }
}
