import { runCoverageAgentAttempts, type CoverageAgentSession, type CoverageAgentRunOptions, type CoverageAgentRunner } from './coverage-agent-attempts'
import path from 'path'
import { resolveAgentsFor } from '../../../runs/pick-heal-agent'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import type { PerAgentStageChoices } from '../../../../../../../shared/agent-models'
import { runReadOnlyAnswerAgent } from '../../../agent-sessions/logic/agent-completion'
import type { AgentJobRecordRef } from '../../../agent-sessions/logic/agent-jobs/types'
import type { PrdSummary, Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'
import { type DocsCollection } from './docs-collection'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'
import { readDocumentSelection } from './document-resolution'
import { assembleSummary, parsePrdSummaryOutput, parseVariantDimension } from './prd-summary-parse'

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
  runAgent?: CoverageAgentRunner
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
  return resolveAgentsFor(adapter)
}

function defaultRunAgent(agent: HealAgent, prompt: string, opts: CoverageAgentRunOptions): Promise<string> {
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

  const { requirements, dimension } = await runCoverageAgentAttempts({
    ...args,
    agents,
    prompt: agents.length ? buildPrdSummaryPrompt(args.collection, previous, args.previous?.variantDimension) : '',
    runAgent,
    activity: 'summarizing PRD',
    cancellationMessage: 'prd summary cancelled',
    failurePrefix: 'PRD summary failed',
    noAnswerMessage: 'PRD summary requires the claude or codex agent — none produced a usable result. Ensure claude or codex is on PATH.',
    validate(output) {
      const dimension = parseVariantDimension(output)
      const requirements = parsePrdSummaryOutput(output, dimension)
      return requirements?.length
        ? { accepted: true, value: { requirements, dimension } }
        : { accepted: false, progress: 'unparseable output; trying next' }
    },
  })

  // Reconcile ids + stamp fingerprints (R3) through the shared assembler so the
  // offloaded path produces a byte-identical summary shape.
  return assembleSummary(args.collection, args.previous ?? null, requirements, dimension, args.now)
}
