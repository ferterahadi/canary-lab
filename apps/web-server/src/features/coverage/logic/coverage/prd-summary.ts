import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pickAvailableHealAgent, type HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { PRD_SUMMARY_MODELS, modelArgs } from '../../../agent-sessions/logic/agent-models'
import type { CoverageAgentSession } from './annotate-engine'
import { recoverAgentAnswer, agentActivityPath } from '../../../agent-sessions/logic/agent-producer'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../agent-sessions/logic/agent-process'
import type { PrdSummary, Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'
import { type DocsCollection } from './docs-collection'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'
import { ParsedRequirement, assembleSummary, parsePrdSummaryOutput, parseVariantDimension, reconcileRequirementIds } from './prd-summary-parse'

export { assembleSummary, parsePrdSummaryOutput, parseVariantDimension, reconcileRequirementIds } from './prd-summary-parse'
export type { ParsedRequirement } from './prd-summary-parse'
export { PRD_SUMMARY_JSON, PRD_SUMMARY_MD, readPrdSummary, renderPrdSummaryMarkdown, writePrdSummary } from './prd-summary-render'

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
  onOutput?: (chunk: string) => void
  /** Fired when an agent spawns with a pinned session (R17 — see annotate-engine). */
  onSession?: (session: CoverageAgentSession) => void
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
  onOutput?: (chunk: string) => void
  onSession?: (session: CoverageAgentSession) => void
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
    previousRequirements: previousJson,
    previousVariantDimension: previousDimensionJson,
  })
}

// ---------------------------------------------------------------------------
// Agent resolution + default spawn runner (mirrors the evaluation-export shape)
// ---------------------------------------------------------------------------

function defaultResolveAgents(adapter: SummarizeAdapter): HealAgent[] {
  const preferred = adapter === 'claude' || adapter === 'codex'
    ? pickAvailableHealAgent(adapter)
    : pickAvailableHealAgent()
  const agents = [
    preferred,
    pickAvailableHealAgent('claude'),
    pickAvailableHealAgent('codex'),
  ].filter((a): a is HealAgent => a === 'claude' || a === 'codex')
  return [...new Set(agents)]
}

function codexArgs(outputPath: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    ...modelArgs(PRD_SUMMARY_MODELS.codex),
    '--output-last-message',
    outputPath,
    '--output-schema',
    PRD_SUMMARY_SCHEMA_PATH,
    '-',
  ]
}

function defaultRunAgent(agent: HealAgent, prompt: string, opts: RunAgentOpts): Promise<string> {
  const outputDir = agent === 'codex'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'canary-prd-summary-'))
    : undefined
  const outputPath = outputDir ? path.join(outputDir, 'last-message.txt') : undefined
  // Pin a claude session id so the CLI's JSONL session log is locatable and
  // AgentSessionView can tail it (the live view comes from that JSONL, not stdout).
  const claudeSessionId = agent === 'claude' ? crypto.randomUUID() : undefined
  // Agentic spawn via the shared runner. claude: stream-json for liveness +
  // answer recovery (display is the JSONL tail); codex: `exec` reads the prompt
  // from stdin (`-`) and writes the final message to --output-last-message.
  const args = agent === 'claude'
    // `readOnly` matches what the codex arm below already declares with
    // `--sandbox read-only`: this agent reads docs and answers with JSON, so it
    // has no business holding a write tool on either arm.
    ? buildClaudeAgenticArgs(prompt, { model: PRD_SUMMARY_MODELS.claude, sessionId: claudeSessionId, readOnly: true })
    : codexArgs(outputPath!)
  opts.onSession?.(agent === 'claude' ? { agent: 'claude', sessionId: claudeSessionId! } : { agent: 'codex', sessionId: '' })

  let idled = false
  const handle = runAgentProcess({
    command: agent,
    args,
    cwd: opts.cwd,
    stdin: agent === 'codex' ? prompt : undefined,
    onChunk: (text) => opts.onOutput?.(text),
    idleMs: PRD_SUMMARY_IDLE_TIMEOUT_MS,
    activityPath: agentActivityPath(agent, opts.cwd, claudeSessionId),
    onIdle: () => { idled = true },
    spawnScope: opts.spawnScope,
  })

  const onAbort = (): void => handle.stop()
  if (opts.signal?.aborted) handle.stop()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })
  const detach = (): void => opts.signal?.removeEventListener('abort', onAbort)
  const rmOutputDir = (): void => { if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true }) }

  return handle.done.then(
    ({ code, signal, stdout, stderr }) => {
      detach()
      try {
        if (opts.signal?.aborted) throw new Error('prd summary cancelled')
        if (idled) throw new Error(`prd summary agent idle for ${PRD_SUMMARY_IDLE_TIMEOUT_MS}ms`)
        if (code !== 0) {
          throw new Error(`prd summary agent failed with ${signal ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`)
        }
        // codex's --output-last-message file is the authoritative final answer;
        // claude's stdout is stream-json envelopes → recover the final message.
        // Read it BEFORE rmOutputDir() (in finally) clears the temp dir.
        let finalOutput = recoverAgentAnswer(agent, stdout)
        if (outputPath && fs.existsSync(outputPath)) {
          const fromFile = fs.readFileSync(outputPath, 'utf-8')
          if (fromFile.trim()) finalOutput = fromFile
        }
        return finalOutput
      } finally {
        rmOutputDir()
      }
    },
    (err: Error) => {
      detach()
      rmOutputDir()
      throw new Error(`prd summary agent failed: ${err.message}`)
    },
  )
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Summarize a docs collection into a `PrdSummary`. Tries the configured
 * agent(s); on no-agent / parse-failure / error it falls back to deterministic
 * heading extraction. Either way ids are reconciled against `previous` so the
 * spine survives. The `%` and strictness are computed later from runs — this
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
          onOutput: args.onOutput,
          onSession: args.onSession,
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
