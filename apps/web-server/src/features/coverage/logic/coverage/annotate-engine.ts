import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pickAvailableHealAgent, type HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { ANNOTATE_MODELS, modelArgs } from '../../../agent-sessions/logic/agent-models'
import { recoverAgentAnswer, agentActivityPath } from '../../../agent-sessions/logic/agent-producer'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../agent-sessions/logic/agent-process'
import type { PathType, ProposedMapping, Requirement, VariantDimension } from '../../../../../../../shared/coverage/types'

/** The agent CLI session backing a coverage/summary run — pinned at spawn so the
 *  Generating screen can stream the structured AgentSessionView (R17). */
export interface CoverageAgentSession {
  agent: 'claude' | 'codex'
  sessionId: string
}

export type { ProposedMapping }

// Coverage annotate-pass (the engine's pass 1). Given the PRD requirements and
// the feature's UNTAGGED tests, infer which requirement(s) each test verifies and
// propose a `covers` tag for it. Mirrors the prd-summary agent shape (same
// spawn / timeout / parse / deterministic-fallback) — but this only ever proposes
// a MAPPING; canary writes the tag (tag-writer.ts) and compiles the ledger. The
// agent never edits a test body (plan.md: mapping, not spec-authoring).

const ANNOTATE_TEMPLATE_PATH = path.join(__dirname, '../../../../../prompts/coverage-annotate.md')
const ANNOTATE_SCHEMA_PATH = path.join(__dirname, '../../../../../prompts/coverage-annotate.schema.json')
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
  onOutput?: (chunk: string) => void
  /** Fired when an agent spawns with a pinned session — lets the job persist a
   *  ref the Generating screen streams via AgentSessionView (R17). */
  onSession?: (session: CoverageAgentSession) => void
}

export interface ProposeMappingsDeps {
  resolveAgents?: (adapter: AnnotateAdapter) => HealAgent[]
  runAgent?: (agent: HealAgent, prompt: string, opts: RunAgentOpts) => Promise<string>
}

interface RunAgentOpts {
  cwd?: string
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  onSession?: (session: CoverageAgentSession) => void
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

/** Parse raw agent stdout into proposed mappings. Returns null on garbage. Drops
 *  mappings that point at unknown requirement ids (no inventing the spine). */
export function parseAnnotateOutput(
  output: string,
  knownIds: Set<string>,
  knownVariants: Set<string> = new Set(),
): ProposedMapping[] | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const text = (fenced ?? output).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const rows = (parsed as { mappings?: unknown }).mappings
  if (!Array.isArray(rows)) return null
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
  const template = fs.readFileSync(templatePath, 'utf-8').trim()
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
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key === 'requirements') return reqJson
    if (key === 'tests') return testJson
    if (key === 'variantInstructions') return variantBlock
    return match
  })
}

// ---------------------------------------------------------------------------
// Agent resolution + default spawn runner (mirrors prd-summary)
// ---------------------------------------------------------------------------

function defaultResolveAgents(adapter: AnnotateAdapter): HealAgent[] {
  const preferred = adapter === 'claude' || adapter === 'codex'
    ? pickAvailableHealAgent(adapter)
    : pickAvailableHealAgent()
  const agents = [preferred, pickAvailableHealAgent('claude'), pickAvailableHealAgent('codex')]
    .filter((a): a is HealAgent => a === 'claude' || a === 'codex')
  return [...new Set(agents)]
}

function codexArgs(outputPath: string): string[] {
  return [
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
    ...modelArgs(ANNOTATE_MODELS.codex),
    '--output-last-message', outputPath,
    '--output-schema', ANNOTATE_SCHEMA_PATH,
    '-',
  ]
}

function defaultRunAgent(agent: HealAgent, prompt: string, opts: RunAgentOpts): Promise<string> {
  const outputDir = agent === 'codex'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'canary-coverage-annotate-'))
    : undefined
  const outputPath = outputDir ? path.join(outputDir, 'last-message.txt') : undefined
  // Pin a session id for claude so the CLI's JSONL session log is locatable and
  // AgentSessionView can tail it (the live view comes from that JSONL, not stdout).
  const claudeSessionId = agent === 'claude' ? crypto.randomUUID() : undefined
  // Agentic spawn via the shared runner. claude: stream-json for liveness +
  // answer recovery (display is the JSONL tail); codex: `exec` reads the prompt
  // from stdin (`-`) and writes the final message to --output-last-message.
  const args = agent === 'claude'
    ? buildClaudeAgenticArgs(prompt, { model: ANNOTATE_MODELS.claude, sessionId: claudeSessionId })
    : codexArgs(outputPath!)
  opts.onSession?.(agent === 'claude' ? { agent: 'claude', sessionId: claudeSessionId! } : { agent: 'codex', sessionId: '' })

  let idled = false
  const handle = runAgentProcess({
    command: agent,
    args,
    cwd: opts.cwd,
    stdin: agent === 'codex' ? prompt : undefined,
    onChunk: (text) => opts.onOutput?.(text),
    idleMs: ANNOTATE_IDLE_TIMEOUT_MS,
    activityPath: agentActivityPath(agent, opts.cwd, claudeSessionId),
    onIdle: () => { idled = true },
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
        if (opts.signal?.aborted) throw new Error('coverage annotate cancelled')
        if (idled) throw new Error(`coverage annotate agent idle for ${ANNOTATE_IDLE_TIMEOUT_MS}ms`)
        if (code !== 0) {
          throw new Error(`coverage annotate agent failed with ${signal ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`)
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
      throw new Error(`coverage annotate agent failed: ${err.message}`)
    },
  )
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Propose `covers` mappings for the given (untagged) tests. Tries the configured
 * agent(s); on no-agent / parse-failure / error it falls back to the deterministic
 * token-overlap heuristic so the engine always returns SOMETHING actionable.
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

  if (agents.length) {
    const prompt = buildAnnotatePrompt(args.requirements, args.tests, args.featureDir, args.variantDimension)
    for (const agent of agents) {
      try {
        args.onOutput?.(`[agent:${agent}] inferring coverage mappings\n`)
        const output = await runAgent(agent, prompt, {
          cwd: args.cwd,
          signal: args.signal,
          onOutput: args.onOutput,
          onSession: args.onSession,
        })
        const parsed = parseAnnotateOutput(output, knownIds, knownVariants)
        if (parsed) return parsed // [] is a valid answer (nothing maps)
        args.onOutput?.(`[agent:${agent}] unparseable output; trying next\n`)
      } catch (err) {
        args.onOutput?.(`[agent:${agent}] failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  // LLM-only: no agent on PATH, or every agent failed / returned unparseable
  // output. We never guess mappings by token overlap — that mis-links tests.
  throw new Error(
    'Coverage mapping requires the claude or codex agent — none produced a usable result. Ensure claude or codex is on PATH.',
  )
}
