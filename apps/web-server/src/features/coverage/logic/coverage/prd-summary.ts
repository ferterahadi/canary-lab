import path from 'path'
import { pickAvailableHealAgent } from '../../../runs/logic/runtime/heal-agent-spawn'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import {
  AGENT_DEFAULT_CHOICE,
  type PerAgentStageChoices,
  type StageModelChoice,
} from '../../../../../../../shared/agent-models'
import type { CoverageAgentSession } from './annotate-engine'
import { runReadOnlyAnswerAgent } from '../../../agent-sessions/logic/agent-completion'
import { resolveAvailableAgentOrder } from '../../../agent-sessions/logic/agent-selection'
import type { AgentJobRecordRef } from '../../../agent-sessions/logic/agent-jobs/types'
import type { PrdSummary, Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'
import { type DocsCollection } from './docs-collection'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'
import { readDocumentSelection } from './document-resolution'
import { ParsedRequirement, assembleSummary, parsePrdSummaryOutput, parseVariantDimension, reconcileRequirementIds } from './prd-summary-parse'

// PRD summarization: turn a feature's source docs into structured requirements
// with STABLE ids. Modeled on the evaluation-export agent pattern
// (lib/test-review-export.ts) — same spawn/timeout/parse shape — but the id
// spine is enforced by canary in code (reconcileRequirementIds), NOT trusted to
// the agent, because renumbering breaks every inline @requirement annotation.

const PRD_SUMMARY_TEMPLATE_PATH = promptPath('prd-summary.md')

const PRD_SUMMARY_SCHEMA_PATH = promptPath('prd-summary.schema.json')

// Idle (inactivity) window: the summary agent is killed only after this long
// with NO activity, not on a fixed wall-clock deadline (see agent-idle-timer.ts).
const PRD_SUMMARY_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export type SummarizeAdapter = 'auto' | 'claude' | 'codex'

export interface SummarizePrdArgs {
  collection: DocsCollection
  /** Prior summary, if any — its requirement ids are preserved. */
  previous?: PrdSummary | null
  adapter?: SummarizeAdapter
  cwd?: string
  signal?: AbortSignal
  /** Stop scope for the spawned distiller — forwarded to the shared runner so an
   *  owner (a flight stage's teardown) can stop this agent without holding its
   *  handle. Forwarded, never invented here: this engine has two caller classes,
   *  and the standalone coverage job deliberately passes none. */
  spawnScope?: string
  /** Durable-record descriptor + where records live, forwarded to the shared
   *  runner. Same forward-only rule as `signal` and `spawnScope`. */
  agentJob?: { record: AgentJobRecordRef; logsDir: string }
  onOutput?: (chunk: string) => void
  /** Fired when an agent spawns with a pinned session (R17 — see annotate-engine). */
  onSession?: (session: CoverageAgentSession) => void
  /** Per-agent model+effort choices for this launch — the engine falls back
   *  across CLIs, and each spawn takes its own agent's entry (a claude effort
   *  is not codex vocabulary). Forward-only, like `signal` and `spawnScope`. */
  models?: PerAgentStageChoices
  /** Injectable ISO timestamp for deterministic tests. */
  now?: string
}

export interface SummarizePrdDeps {
  resolveAgents?: (adapter: SummarizeAdapter) => HealAgent[]
  runAgent?: (agent: HealAgent, prompt: string, opts: RunAgentOpts) => Promise<string>
}

interface RunAgentOpts {
  cwd?: string
  signal?: AbortSignal
  spawnScope?: string
  agentJob?: { record: AgentJobRecordRef; logsDir: string }
  onOutput?: (chunk: string) => void
  onSession?: (session: CoverageAgentSession) => void
  /** Resolved model+effort for this launch; absent → agent default. */
  models?: StageModelChoice
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildPrdSummaryPrompt(
  collection: DocsCollection,
  previous: Requirement[],
  previousVariantDimension?: VariantDimension,
  templatePath: string = PRD_SUMMARY_TEMPLATE_PATH,
): string {
  // Agentic: list the resolvable file paths and make the agent READ them with its
  // tools, rather than inlining the bodies (which lets the model shortcut to a
  // one-shot answer and leaves the AgentSessionView timeline empty). The server
  // still reads the collection itself for fingerprints + the deterministic fallback.
  const docs = collection.entries.length
    ? collection.entries.map((e) => `- ${path.join(collection.docsDir, e.relPath)}`).join('\n')
    : '(no documents)'
  const previousJson = previous.length
    ? JSON.stringify(
        previous.map((r) => ({ id: r.id, title: r.title, deprecated: r.deprecated })),
        null,
        2,
      )
    : '(none — this is the first summary)'
  const previousDimensionJson = previousVariantDimension
    ? JSON.stringify(previousVariantDimension, null, 2)
    : '(none — infer the dimension from the documents, if any)'
  return renderPromptTemplate(loadPromptTemplate(templatePath), {
    docs,
    sourceScope: (() => {
      const selection = readDocumentSelection(path.dirname(collection.docsDir))
      return selection ? JSON.stringify({ intent: selection.intent, sources: selection.sources.filter((source) => collection.entries.some((entry) => entry.relPath === source.relPath)).map(({ relPath, reason }) => ({ doc: relPath, relevance: reason })) }, null, 2) : '(Use the feature scope explicitly stated in the supplied documents.)'
    })(),
    previousRequirements: previousJson,
    previousVariantDimension: previousDimensionJson,
  })
}

// ---------------------------------------------------------------------------
// Agent resolution + default spawn runner (mirrors the evaluation-export shape)
// ---------------------------------------------------------------------------

function defaultResolveAgents(adapter: SummarizeAdapter): HealAgent[] {
  return resolveAvailableAgentOrder(adapter === 'claude' || adapter === 'codex' ? adapter : undefined, pickAvailableHealAgent)
}

function defaultRunAgent(agent: HealAgent, prompt: string, opts: RunAgentOpts): Promise<string> {
  // This agent reads docs and answers with JSON, so it has no business holding
  // a write tool on either arm.
  return runReadOnlyAnswerAgent({
    ...opts,
    agent,
    prompt,
    idleMs: PRD_SUMMARY_IDLE_TIMEOUT_MS,
    outputDirectoryPrefix: 'canary-prd-summary-',
    outputSchemaPath: PRD_SUMMARY_SCHEMA_PATH,
    errorLabel: 'prd summary agent',
    cancellationMessage: 'prd summary cancelled',
    cancellationMode: 'after-close',
  })
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Summarize a docs collection into a `PrdSummary`. Tries the configured
 * agent(s); no usable agent answer is an error. Requirement ids are reconciled
 * against `previous` so the spine survives. The `%` and strictness are computed later from runs — this
 * only produces the requirement model.
 */
export async function summarizePrd(
  args: SummarizePrdArgs,
  deps: SummarizePrdDeps = {},
): Promise<PrdSummary> {
  const previous = args.previous?.requirements ?? []
  const resolveAgents = deps.resolveAgents ?? defaultResolveAgents
  const runAgent = deps.runAgent ?? defaultRunAgent
  const agents = resolveAgents(args.adapter ?? 'auto')

  let parsedReqs: ParsedRequirement[] | null = null
  let parsedDimension: VariantDimension | undefined
  let lastFailure: string | undefined
  if (agents.length) {
    const prompt = buildPrdSummaryPrompt(args.collection, previous, args.previous?.variantDimension)
    for (const agent of agents) {
      try {
        args.onOutput?.(`[agent:${agent}] summarizing PRD\n`)
        const output = await runAgent(agent, prompt, {
          cwd: args.cwd,
          signal: args.signal,
          spawnScope: args.spawnScope,
          agentJob: args.agentJob,
          onOutput: args.onOutput,
          onSession: args.onSession,
          models: args.models?.[agent],
        })
        const dimension = parseVariantDimension(output)
        const parsed = parsePrdSummaryOutput(output, dimension)
        if (parsed && parsed.length) {
          parsedReqs = parsed
          parsedDimension = dimension
          break
        }
        args.onOutput?.(`[agent:${agent}] unparseable output; trying next\n`)
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err)
        args.onOutput?.(`[agent:${agent}] failed: ${lastFailure}\n`)
      }
    }
  }

  if (!parsedReqs) {
    // LLM-only: no agent on PATH, or every agent failed / returned unparseable
    // output. We never fabricate requirements from headings — that produced
    // phantom requirements (goals/context/architecture) and tanked coverage.
    // If an agent actually ran and threw, surface that real cause (e.g. an
    // expired OAuth session) rather than the misleading "is on PATH" hint.
    throw new Error(
      lastFailure
        ? `PRD summary failed: ${lastFailure}`
        : 'PRD summary requires the claude or codex agent — none produced a usable result. Ensure claude or codex is on PATH.',
    )
  }

  // Reconcile ids + stamp fingerprints (R3) through the shared assembler so the
  // offloaded path produces a byte-identical summary shape.
  return assembleSummary(args.collection, args.previous ?? null, parsedReqs, parsedDimension, args.now)
}
