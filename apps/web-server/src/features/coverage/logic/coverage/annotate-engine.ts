import path from 'path'
import { pickAvailableHealAgent } from '../../../runs/logic/runtime/heal-agent-spawn'
import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import {
  AGENT_DEFAULT_CHOICE,
  type PerAgentStageChoices,
  type StageModelChoice,
} from '../../../../../../../shared/agent-models'
import { extractJsonCandidates } from '../../../agent-sessions/logic/agent-json'
import type { AgentJobRecordRef } from '../../../agent-sessions/logic/agent-jobs/types'
import { runReadOnlyAnswerAgent } from '../../../agent-sessions/logic/agent-completion'
import { resolveAvailableAgentOrder } from '../../../agent-sessions/logic/agent-selection'
import { promptPath, loadPromptTemplate, renderPromptTemplate } from '../../../../shared/prompts'
import type { PathType, ProposedMapping, Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'

/** The agent CLI session backing a coverage/summary run — pinned at spawn so the
 *  Generating screen can stream the structured AgentSessionView (R17). */
export interface CoverageAgentSession {
  agent: 'claude' | 'codex'
  sessionId: string
}

// Coverage annotate-pass (the engine's pass 1). Given the PRD requirements and
// the feature's UNTAGGED tests, infer which requirement(s) each test verifies and
// propose a `covers` tag for it. Mirrors the prd-summary agent shape (same
// spawn / timeout / parse / deterministic-fallback) — but this only ever proposes
// a MAPPING; canary writes the tag (tag-writer.ts) and compiles the ledger. The
// agent never edits a test body (plan.md: mapping, not spec-authoring).

const ANNOTATE_TEMPLATE_PATH = promptPath('coverage-annotate.md')
const ANNOTATE_SCHEMA_PATH = promptPath('coverage-annotate.schema.json')
// Idle (inactivity) window: the annotate agent is killed only after this long
// with NO activity, not on a fixed wall-clock deadline (see agent-idle-timer.ts).
const ANNOTATE_IDLE_TIMEOUT_MS = 5 * 60 * 1000

const PATH_TYPES: PathType[] = ['happy', 'sad', 'edge']

export type AnnotateAdapter = 'auto' | 'claude' | 'codex'

/** A test the engine may map — name + enough body/assertions to reason over. */
export interface AnnotateTestInput {
  name: string
  file?: string
  bodySource?: string
  assertions?: string[]
}

export interface ProposeMappingsArgs {
  requirements: Requirement[]
  /** The feature's variant dimension (D1). When present, the agent is asked to
   *  also claim which variant(s) each test exercises; claims are validated against
   *  its closed vocabulary. Absent ⇒ no variant axis (paths only). */
  variantDimension?: VariantDimension
  tests: AnnotateTestInput[]
  adapter?: AnnotateAdapter
  /** Absolute feature dir — used to show the agent resolvable spec paths to read. */
  featureDir?: string
  cwd?: string
  signal?: AbortSignal
  /** Stop scope for the spawned mapper, forwarded to the shared runner so an owner
   *  can stop it without holding its handle. Forwarded, never invented here. */
  spawnScope?: string
  /** Durable-record descriptor, forwarded to the shared runner. */
  agentJob?: { record: AgentJobRecordRef; logsDir: string }
  onOutput?: (chunk: string) => void
  /** Fired when an agent spawns with a pinned session — lets the job persist a
   *  ref the Generating screen streams via AgentSessionView (R17). */
  onSession?: (session: CoverageAgentSession) => void
  /** Per-agent model+effort choices — the engine falls back across CLIs, and
   *  each spawn takes its own agent's entry. Forward-only, like `signal`. */
  models?: PerAgentStageChoices
}

export interface ProposeMappingsDeps {
  resolveAgents?: (adapter: AnnotateAdapter) => HealAgent[]
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
// Parsing
// ---------------------------------------------------------------------------

function normalizePathTypes(value: unknown): PathType[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<PathType>()
  for (const item of value) {
    if (typeof item === 'string' && (PATH_TYPES as string[]).includes(item)) seen.add(item as PathType)
  }
  const ordered = PATH_TYPES.filter((p) => seen.has(p))
  return ordered.length ? ordered : undefined
}

/** Validate the agent's variant claims against the feature's closed vocabulary
 *  (the dimension values), lower-cased + deduped. Unknown / absent → []. */
function normalizeVariants(value: unknown, knownVariants: Set<string>): string[] {
  if (!Array.isArray(value) || knownVariants.size === 0) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const v = item.trim().toLowerCase()
    if (v && knownVariants.has(v) && !out.includes(v)) out.push(v)
  }
  return out
}

function normalizeRequirements(value: unknown, knownIds: Set<string>): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const id = item.trim()
      // Tolerate the agent echoing the tag form `@req-R3` instead of the bare id.
      const bare = id.replace(/^@req-/, '')
      if (bare && knownIds.has(bare) && !out.includes(bare)) out.push(bare)
    }
  }
  return out
}

/** The agent's full answer: what it mapped, plus what it read and explicitly
 *  could not map. The second half is what makes the first half checkable — see
 *  `accountedFor` in the orchestrator. */
export interface AnnotateAnswer {
  mappings: ProposedMapping[]
  /** Test names the agent declared unmappable (read, no requirement applies). */
  unmappable: string[]
}

/** Parse raw agent stdout into the full answer. Returns null on garbage. Drops
 *  mappings that point at unknown requirement ids (no inventing the spine). */
export function parseAnnotateAnswer(
  output: string,
  knownIds: Set<string>,
  knownVariants: Set<string> = new Set(),
): AnnotateAnswer | null {
  // First candidate carrying a `mappings` array — prose asides with braces
  // (inline code, placeholders) can't shadow the real answer. `unmappable` is
  // read off THAT SAME object, so the two halves can never come from different
  // candidates and disagree about what was examined.
  const envelope = extractJsonCandidates(output).find(
    (c): c is { mappings: unknown[]; unmappable?: unknown } =>
      !!c && typeof c === 'object' && Array.isArray((c as { mappings?: unknown }).mappings),
  )
  if (!envelope) return null
  const unmappable: string[] = []
  if (Array.isArray(envelope.unmappable)) {
    for (const raw of envelope.unmappable) {
      if (!raw || typeof raw !== 'object') continue
      const name = (raw as { testName?: unknown }).testName
      if (typeof name === 'string' && name.trim()) unmappable.push(name.trim())
    }
  }
  return { mappings: parseMappingRows(envelope.mappings, knownIds, knownVariants), unmappable }
}

/** Mappings only — the long-standing surface, kept for the parse-level suites. */
export function parseAnnotateOutput(
  output: string,
  knownIds: Set<string>,
  knownVariants: Set<string> = new Set(),
): ProposedMapping[] | null {
  return parseAnnotateAnswer(output, knownIds, knownVariants)?.mappings ?? null
}

function parseMappingRows(
  rows: unknown[],
  knownIds: Set<string>,
  knownVariants: Set<string>,
): ProposedMapping[] {
  const out: ProposedMapping[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const testName = typeof r.testName === 'string' ? r.testName.trim() : ''
    if (!testName) continue
    const requirements = normalizeRequirements(r.requirements, knownIds)
    if (!requirements.length) continue // no usable linkage → not a mapping
    const variants = normalizeVariants(r.variants, knownVariants)
    out.push({
      testName,
      requirements,
      pathTypes: normalizePathTypes(r.pathTypes),
      ...(variants.length ? { variants } : {}),
      rationale: typeof r.rationale === 'string' ? r.rationale.trim() || undefined : undefined,
      confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : undefined,
      source: 'agent',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildAnnotatePrompt(
  requirements: Requirement[],
  tests: AnnotateTestInput[],
  featureDir?: string,
  variantDimension?: VariantDimension,
  templatePath: string = ANNOTATE_TEMPLATE_PATH,
): string {
  const active = requirements.filter((r) => !r.deprecated)
  const reqJson = JSON.stringify(
    active.map((r) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      pathTypes: r.pathTypes,
      ...(r.variants && r.variants.length ? { variants: r.variants } : {}),
    })),
    null,
    2,
  )
  // The variant block tells the agent the feature's dimension + the closed value
  // set to claim from. Absent ⇒ a clear "no variant axis" instruction so the
  // agent doesn't invent one.
  const variantBlock = variantDimension
    ? `This feature has a **${variantDimension.name}** variant dimension. For each test, also report which `
      + `${variantDimension.name}(s) it exercises in a \`variants\` array, choosing ONLY from: `
      + `${variantDimension.values.join(', ')}. A requirement listing multiple ${variantDimension.name}s is only `
      + `fully covered when every one is exercised by some test — so be precise about which a test actually hits `
      + `(read the endpoint / fixture). Omit \`variants\` for a test that is not ${variantDimension.name}-specific.`
    : 'This feature has no variant dimension — do NOT emit a `variants` field.'
  // Agentic: list each test's name + resolvable file path so the agent READS the
  // real body with its tools, instead of inlining a truncated body (which lets the
  // model shortcut to one-shot and leaves the AgentSessionView timeline empty).
  const testJson = JSON.stringify(
    tests.map((t) => ({
      testName: t.name,
      file: t.file && featureDir ? path.join(featureDir, t.file) : t.file,
      assertions: t.assertions,
    })),
    null,
    2,
  )
  return renderPromptTemplate(loadPromptTemplate(templatePath), {
    requirements: reqJson,
    tests: testJson,
    variantInstructions: variantBlock,
  })
}

// ---------------------------------------------------------------------------
// Agent resolution + default spawn runner (mirrors prd-summary)
// ---------------------------------------------------------------------------

function defaultResolveAgents(adapter: AnnotateAdapter): HealAgent[] {
  return resolveAvailableAgentOrder(adapter === 'claude' || adapter === 'codex' ? adapter : undefined, pickAvailableHealAgent)
}

function defaultRunAgent(agent: HealAgent, prompt: string, opts: RunAgentOpts): Promise<string> {
  // The annotator returns the edits it wants as data for canary to apply, so it
  // must not be able to reach into the spec files itself.
  return runReadOnlyAnswerAgent({
    ...opts,
    agent,
    prompt,
    idleMs: ANNOTATE_IDLE_TIMEOUT_MS,
    outputDirectoryPrefix: 'canary-coverage-annotate-',
    outputSchemaPath: ANNOTATE_SCHEMA_PATH,
    errorLabel: 'coverage annotate agent',
    cancellationMessage: 'coverage annotate cancelled',
    cancellationMode: 'after-close',
  })
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Tests the agent's answer failed to account for — named in neither `mappings`
 * nor `unmappable`.
 *
 * This is the harness-side half of letting the agent fan out. Once subagents do
 * the reading, canary can no longer see which tests were actually examined, and
 * a silent omission reads downstream exactly like a considered "no requirement
 * applies". Requiring every test in one list or the other turns that silence
 * into a detectable failure.
 */
export function missingFromRoster(tests: AnnotateTestInput[], answer: AnnotateAnswer): string[] {
  const accounted = new Set<string>([...answer.mappings.map((m) => m.testName), ...answer.unmappable])
  return tests.map((t) => t.name).filter((name) => !accounted.has(name))
}

/**
 * Propose `covers` mappings for the given (untagged) tests. Tries the configured
 * agent(s); no usable agent answer is an error, never a guessed mapping.
 * Mappings pointing at unknown requirement ids are dropped at parse time.
 */
export async function proposeCoverageMappings(
  args: ProposeMappingsArgs,
  deps: ProposeMappingsDeps = {},
): Promise<ProposedMapping[]> {
  if (!args.tests.length) return []
  const knownIds = new Set(args.requirements.filter((r) => !r.deprecated).map((r) => r.id))
  if (!knownIds.size) return []

  const resolveAgents = deps.resolveAgents ?? defaultResolveAgents
  const runAgent = deps.runAgent ?? defaultRunAgent
  const agents = resolveAgents(args.adapter ?? 'auto')
  const knownVariants = new Set(args.variantDimension?.values ?? [])

  let lastFailure: string | undefined
  if (agents.length) {
    // ONE agent is spawned, always. The prompt tells it how to divide the
    // reading (group by spec file, one read-only subagent per group) and it
    // dispatches its own subagents — the fan-out is the agent's to run, not
    // canary's. Canary spawning a fleet itself would duplicate, worse, an
    // orchestration the agent already does (a portify agent dispatched an
    // `Explore` subagent unprompted), while giving up the agent's context and
    // its harness's own permission model. Canary keeps only the roster check
    // below, which the agent cannot do for itself.
    const prompt = buildAnnotatePrompt(args.requirements, args.tests, args.featureDir, args.variantDimension)
    for (const agent of agents) {
      try {
        args.onOutput?.(`[agent:${agent}] inferring coverage mappings\n`)
        const output = await runAgent(agent, prompt, {
          cwd: args.cwd,
          signal: args.signal,
          spawnScope: args.spawnScope,
          agentJob: args.agentJob,
          onOutput: args.onOutput,
          onSession: args.onSession,
          models: args.models?.[agent],
        })
        const answer = parseAnnotateAnswer(output, knownIds, knownVariants)
        if (answer) {
          // The roster check — the price of letting the agent own the fan-out.
          // A test missing from BOTH halves was never accounted for, and the
          // ledger would score it uncovered on the agent's silence rather than
          // on evidence. Indistinguishable, downstream, from a subagent that
          // died. So an incomplete answer is not an answer.
          const missing = missingFromRoster(args.tests, answer)
          if (!missing.length) return answer.mappings // [] is a valid answer (nothing maps)
          args.onOutput?.(
            `[agent:${agent}] answer skipped ${missing.length}/${args.tests.length} test(s) `
            + `(e.g. ${missing.slice(0, 3).join(', ')}); trying next\n`,
          )
          lastFailure = `agent accounted for only ${args.tests.length - missing.length} of ${args.tests.length} tests`
        } else {
          args.onOutput?.(`[agent:${agent}] unparseable output; trying next\n`)
        }
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err)
        args.onOutput?.(`[agent:${agent}] failed: ${lastFailure}\n`)
      }
    }
  }

  // LLM-only: no agent on PATH, or every agent failed / returned unparseable
  // output. We never guess mappings by token overlap — that mis-links tests.
  // If an agent actually ran and threw, surface that real cause (e.g. an
  // expired OAuth session) rather than the misleading "is on PATH" hint.
  throw new Error(
    lastFailure
      ? `Coverage mapping failed: ${lastFailure}`
      : 'Coverage mapping requires the claude or codex agent — none produced a usable result. Ensure claude or codex is on PATH.',
  )
}
