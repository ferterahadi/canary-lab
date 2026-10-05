import type { PerAgentStageChoices, StageModelChoice } from '../../../../../../../shared/agent-models'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import type { AgentJobRecordRef } from '../../../agent-sessions/logic/agent-jobs/types'

/** Pinned at spawn so coverage consumers can follow the agent's session. */
export interface CoverageAgentSession {
  agent: 'claude' | 'codex'
  sessionId: string
}

export interface CoverageAgentRunOptions {
  cwd?: string
  signal?: AbortSignal
  spawnScope?: string
  agentJob?: { record: AgentJobRecordRef; logsDir: string }
  onSession?: (session: CoverageAgentSession) => void
  models?: StageModelChoice
}

export type CoverageAgentRunner = (agent: HealAgent, prompt: string, options: CoverageAgentRunOptions) => Promise<string>

// An empty mapping array is a valid answer; truthiness must not decide acceptance.
type Answer<T> = { accepted: true; value: T } | { accepted: false; progress: string; failure?: string }

interface AttemptOptions<T> extends Omit<CoverageAgentRunOptions, 'models'> {
  agents: HealAgent[]
  prompt: string
  models?: PerAgentStageChoices
  runAgent: CoverageAgentRunner
  validate(output: string): Answer<T>
  onOutput?: (chunk: string) => void
  activity: string
  cancellationMessage: string
  failurePrefix: string
  noAnswerMessage: string
}

export async function runCoverageAgentAttempts<T>(options: AttemptOptions<T>): Promise<T> {
  const checkCancellation = (): void => {
    if (options.signal?.aborted) throw new Error(`${options.failurePrefix}: ${options.cancellationMessage}`)
  }
  checkCancellation()
  let lastFailure: string | undefined
  for (const agent of options.agents) {
    checkCancellation()
    try {
      options.onOutput?.(`[agent:${agent}] ${options.activity}\n`)
      checkCancellation()
      // Await the runner rather than racing the abort signal: coverage must not
      // finish cancellation before process closure and terminal job persistence.
      const output = await options.runAgent(agent, options.prompt, {
        cwd: options.cwd,
        signal: options.signal,
        spawnScope: options.spawnScope,
        agentJob: options.agentJob,
        onSession: options.onSession,
        models: options.models?.[agent],
      })
      checkCancellation()
      const answer = options.validate(output)
      if (answer.accepted) return answer.value
      options.onOutput?.(`[agent:${agent}] ${answer.progress}\n`)
      if (answer.failure !== undefined) lastFailure = answer.failure
    } catch (error) {
      checkCancellation()
      lastFailure = error instanceof Error ? error.message : String(error)
      options.onOutput?.(`[agent:${agent}] failed: ${lastFailure}\n`)
    }
  }
  checkCancellation()
  throw new Error(lastFailure ? `${options.failurePrefix}: ${lastFailure}` : options.noAnswerMessage)
}
