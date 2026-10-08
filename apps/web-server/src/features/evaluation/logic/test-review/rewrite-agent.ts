import ts from 'typescript'
import type { RunDetail } from '../../../../../../../shared/run-detail'
import { pickAvailableHealAgent } from '../../../runs/logic/runtime/heal-agent-spawn'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import { AGENT_DEFAULT_CHOICE, type StageModelChoice } from '../../../../../../../shared/agent-models'
import { runReadOnlyAnswerAgent } from '../../../agent-sessions/logic/agent-completion'
import { resolveAvailableAgentOrder } from '../../../agent-sessions/logic/agent-selection'
import { extractJsonCandidates } from '../../../agent-sessions/logic/agent-json'
import { promptPath } from '../../../../shared/prompts'
import { createFlowcharts } from './flowchart'
import { buildTestReviewPacket } from './packet'
import { applyEvaluationTextSlotRewrite, buildEvaluationLlmPrompt, deterministicEvaluationRewrite, evaluationTextSlots, normalizeEvaluationRewrite } from './rewrite'
import type { AssertionHtmlOptions, EvaluationRewrite, EvaluationRewriteAgentOptions, EvaluationTextSlot } from './types'
import { errorMessage } from '../../../../../../../shared/lib/error-message'

export async function generateEvaluationRewriteWithAgent(
  detail: RunDetail,
  adapter: AssertionHtmlOptions['audienceAdapter'],
  cwd?: string,
  options: EvaluationRewriteAgentOptions = {},
): Promise<EvaluationRewrite | null> {
  const agents = resolveEvaluationAgents(adapter)
  if (!agents.length) return null
  const packet = buildTestReviewPacket(detail)
  const fallback = deterministicEvaluationRewrite(packet)
  const prompt = buildEvaluationRewritePrompt(packet, fallback)
  const failures: string[] = []
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]
    const nextAgent = agents[i + 1]
    const recordFailure = (reason: string) => {
      failures.push(`${agent}: ${reason}`)
      // Surface WHY this agent dropped out — otherwise the live log just shows
      // one agent start, then the next, with no explanation for the handoff.
      const handoff = nextAgent ? ` — falling back to ${nextAgent}` : ''
      options.onOutput?.(`[agent:${agent}] rewrite failed: ${reason}${handoff}\n`)
    }
    const models = options.models?.[agent] ?? AGENT_DEFAULT_CHOICE
    try {
      options.onOutput?.(`[agent:${agent}] starting localized rewrite (model: ${evaluationAgentModel(models) ?? 'agent default'})\n`)
      const output = await runEvaluationAgent(agent, prompt, cwd, options.onOutput, options.signal, options.onSession, models)
      const rewrite = resolveRewriteOutput(output, packet, fallback)
      if (rewrite) {
        options.onOutput?.(`[agent:${agent}] localized rewrite completed\n`)
        return rewrite
      }
      recordFailure(`unparseable output: ${previewAgentOutput(output)}`)
    } catch (err) {
      recordFailure(errorMessage(err))
    }
  }
  throw new Error(`evaluation rewrite failed with all available agents: ${failures.join(' | ')}`)
}

export const EVALUATION_REWRITE_TEMPLATE_PATH = promptPath('evaluation-rewrite.md')

export const EVALUATION_REWRITE_SCHEMA_PATH = promptPath('evaluation-rewrite.schema.json')

export function resolveEvaluationAgents(adapter: AssertionHtmlOptions['audienceAdapter']): HealAgent[] {
  if (adapter === 'deterministic') return []
  return resolveAvailableAgentOrder(adapter === 'claude' || adapter === 'codex' ? adapter : undefined, pickAvailableHealAgent)
}

export function evaluationAgentModel(models: StageModelChoice): string | null {
  return models.model
}

// Idle (inactivity) window: the rewrite agent is killed only after this long
// with NO activity, not on a fixed wall-clock deadline (see agent-idle-timer.ts).
export const EVALUATION_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export function runEvaluationAgent(
  agent: HealAgent,
  prompt: string,
  cwd?: string,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
  onSession?: (session: { agent: HealAgent; sessionId: string }) => void,
  models: StageModelChoice = AGENT_DEFAULT_CHOICE,
): Promise<string> {
  // Read-only on both arms: this agent rewrites the wording of a finished run's
  // report, and a report that could edit the evidence it describes would not be
  // evidence.
  return runReadOnlyAnswerAgent({
    agent,
    prompt,
    models,
    cwd,
    signal,
    idleMs: EVALUATION_IDLE_TIMEOUT_MS,
    outputDirectoryPrefix: 'canary-evaluation-rewrite-',
    outputSchemaPath: EVALUATION_REWRITE_SCHEMA_PATH,
    errorLabel: 'evaluation rewrite agent',
    cancellationMessage: 'evaluation rewrite cancelled',
    onSession,
    onTick: (idleMs) => {
      if (idleMs >= 10_000) onOutput?.(`[agent:${agent}] still running; waiting for CLI output (${Math.floor(idleMs / 1000)}s idle)\n`)
    },
  })
}

export function previewAgentOutput(output: string): string {
  const text = output.replace(/\s+/g, ' ').trim()
  if (!text) return '<empty output>'
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

/** The full localized-rewrite prompt for one run — packet + text slots + the
 *  flowchart walk, rendered from evaluation-rewrite.md. One home so the
 *  internal agent spawn and the flight's external hand-off send identical
 *  instructions. */
export function buildEvaluationRewritePrompt(packet: ReturnType<typeof buildTestReviewPacket>, fallback: EvaluationRewrite): string {
  const flowcharts = createFlowcharts(packet, fallback)
  const textSlots = evaluationTextSlots(fallback)
  return buildEvaluationLlmPrompt({
    packet,
    textSlots,
    flowcharts: flowcharts.map((flowchart) => ({
      testName: flowchart.testName,
      steps: flowchart.steps.map((step) => step.detail ? `${step.title}: ${step.detail}` : step.title),
    })),
  })
}

/** Resolve a producer's raw answer into a normalized rewrite: the slot form
 *  wins (it keeps the case roster intact by construction), else the full
 *  envelope is normalized against the packet — which is where a wrong case
 *  count dies. One parse chain for the internal spawn loop and the flight's
 *  external consume, so both producers are judged identically. */
export function resolveRewriteOutput(
  output: string,
  packet: ReturnType<typeof buildTestReviewPacket>,
  fallback: EvaluationRewrite,
): EvaluationRewrite | undefined {
  const slotRewrite = parseEvaluationTextSlotRewrite(output)
  if (slotRewrite) return applyEvaluationTextSlotRewrite(fallback, slotRewrite)
  return normalizeEvaluationRewrite(parseEvaluationRewrite(output), packet) ?? undefined
}

export function parseEvaluationRewrite(output: string): EvaluationRewrite | undefined {
  // First candidate carrying a `cases` array — the rewrite envelope's anchor —
  // so brace-bearing prose around the answer can't shadow it.
  for (const c of extractJsonCandidates(output)) {
    if (c && typeof c === 'object' && Array.isArray((c as { cases?: unknown }).cases)) {
      return c as EvaluationRewrite
    }
  }
  return undefined
}

export function parseEvaluationTextSlotRewrite(output: string): EvaluationTextSlot[] | undefined {
  for (const c of extractJsonCandidates(output)) {
    if (!c || typeof c !== 'object') continue
    const parsed = c as { slots?: unknown }
    if (!Array.isArray(parsed.slots)) continue
    const slots = parsed.slots.flatMap((slot): EvaluationTextSlot[] => {
      if (!slot || typeof slot !== 'object') return []
      const item = slot as Partial<EvaluationTextSlot>
      if (typeof item.id !== 'string' || typeof item.text !== 'string') return []
      return [{ id: item.id, text: item.text }]
    })
    return slots.length ? slots : undefined
  }
  return undefined
}
