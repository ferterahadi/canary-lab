import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pickAvailableHealAgent, type HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { PRD_SUMMARY_MODELS, modelArgs } from '../../../agent-sessions/logic/agent-models'
import type { CoverageAgentSession } from '../../../coverage/logic/coverage/annotate-engine'
import { recoverAgentAnswer, agentActivityPath } from '../../../agent-sessions/logic/agent-producer'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../agent-sessions/logic/agent-process'
import type {
  PathType,
  PrdSummary,
  Requirement,
  StrictnessLadderRung,
  StrictnessTier,
  VariantDimension,
  VariantNA,
} from '../../../../../../../shared/coverage/types'
import {
  docsDirFor,
  type DocsCollection,
} from '../../../coverage/logic/coverage/docs-collection'
import { withFingerprints } from '../../../coverage/logic/coverage/fingerprints'

// PRD summarization: turn a feature's source docs into structured requirements
// with STABLE ids. Modeled on the evaluation-export agent pattern
// (lib/test-review-export.ts) — same spawn/timeout/parse shape — but the id
// spine is enforced by canary in code (reconcileRequirementIds), NOT trusted to
// the agent, because renumbering breaks every inline @requirement annotation.

const PRD_SUMMARY_TEMPLATE_PATH = path.join(__dirname, '../../../../../prompts/prd-summary.md')
const PRD_SUMMARY_SCHEMA_PATH = path.join(__dirname, '../../../../../prompts/prd-summary.schema.json')
// Idle (inactivity) window: the summary agent is killed only after this long
// with NO activity, not on a fixed wall-clock deadline (see agent-idle-timer.ts).
const PRD_SUMMARY_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Generated artifact filenames under docs/. */
export const PRD_SUMMARY_JSON = '_prd-summary.json'
export const PRD_SUMMARY_MD = '_prd-summary.md'

const PATH_TYPES: PathType[] = ['happy', 'sad', 'edge']
const TIERS: StrictnessTier[] = [1, 2, 3, 4]

/** The agent's per-requirement shape before canary assigns stable ids. */
export interface ParsedRequirement {
  /** The agent's echoed id (a previous id it believes survives). May be absent. */
  id?: string
  kind?: 'functional' | 'non-functional'
  title: string
  text: string
  happyPath?: string
  unhappyPath?: string
  pathTypes: PathType[]
  variants?: string[]
  variantsNA?: VariantNA[]
  strictnessLadder?: StrictnessLadderRung[]
}

function normalizeKind(value: unknown): 'functional' | 'non-functional' | undefined {
  return value === 'functional' || value === 'non-functional' ? value : undefined
}

/** Normalize a token to a variant value: lower-case, trimmed, single token. */
function normalizeVariantValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  return v ? v : undefined
}

/** Parse the agent's top-level `variantDimension`. Requires a non-empty name and
 *  at least TWO values — a one-value "dimension" carries no breadth and is
 *  dropped (it would just be a noisy variant-agnostic requirement). */
function normalizeVariantDimension(value: unknown): VariantDimension | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { name?: unknown; values?: unknown }
  const name = normalizeVariantValue(raw.name)
  if (!name || !Array.isArray(raw.values)) return undefined
  const values: string[] = []
  for (const item of raw.values) {
    const v = normalizeVariantValue(item)
    if (v && !values.includes(v)) values.push(v)
  }
  return values.length >= 2 ? { name, values } : undefined
}

/** Normalize a requirement's `variants`, dropping anything outside the feature's
 *  declared dimension (the controlled vocabulary). Returns undefined when the
 *  requirement spans fewer than 2 declared values — there's no breadth to track. */
function normalizeRequirementVariants(value: unknown, dimension: VariantDimension | undefined): string[] | undefined {
  if (!dimension || !Array.isArray(value)) return undefined
  const allowed = new Set(dimension.values)
  const out: string[] = []
  for (const item of value) {
    const v = normalizeVariantValue(item)
    if (v && allowed.has(v) && !out.includes(v)) out.push(v)
  }
  return out.length >= 2 ? out : undefined
}

/** Normalize a requirement's `variantsNA` — variants it nominally spans but that
 *  have no testable surface. Each must be one of the requirement's declared
 *  `variants` and carry a non-empty reason; anything else is dropped. */
function normalizeRequirementVariantsNA(
  value: unknown,
  declared: string[] | undefined,
): VariantNA[] | undefined {
  if (!Array.isArray(value) || !declared || !declared.length) return undefined
  const allowed = new Set(declared)
  const seen = new Set<string>()
  const out: VariantNA[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as { variant?: unknown; reason?: unknown }
    const variant = normalizeVariantValue(raw.variant)
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
    if (variant && reason && allowed.has(variant) && !seen.has(variant)) {
      seen.add(variant)
      out.push({ variant, reason })
    }
  }
  return out.length ? out : undefined
}

function normalizeProse(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export type SummarizeAdapter = 'auto' | 'claude' | 'codex'

export interface SummarizePrdArgs {
  collection: DocsCollection
  /** Prior summary, if any — its requirement ids are preserved. */
  previous?: PrdSummary | null
  adapter?: SummarizeAdapter
  cwd?: string
  signal?: AbortSignal
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
  onOutput?: (chunk: string) => void
  onSession?: (session: CoverageAgentSession) => void
}

// ---------------------------------------------------------------------------
// Normalization of agent / fallback output
// ---------------------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizePathTypes(value: unknown): PathType[] {
  if (!Array.isArray(value)) return ['happy']
  const seen = new Set<PathType>()
  for (const item of value) {
    if (typeof item === 'string' && (PATH_TYPES as string[]).includes(item)) {
      seen.add(item as PathType)
    }
  }
  // Order canonically; default to happy when the agent gave nothing usable.
  const ordered = PATH_TYPES.filter((p) => seen.has(p))
  return ordered.length ? ordered : ['happy']
}

function normalizeLadder(value: unknown): StrictnessLadderRung[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rungs: StrictnessLadderRung[] = []
  const seenTiers = new Set<StrictnessTier>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const rung = item as { tier?: unknown; description?: unknown }
    const tier = rung.tier
    if (typeof tier !== 'number' || !(TIERS as number[]).includes(tier)) continue
    if (seenTiers.has(tier as StrictnessTier)) continue
    if (typeof rung.description !== 'string' || !rung.description.trim()) continue
    seenTiers.add(tier as StrictnessTier)
    rungs.push({ tier: tier as StrictnessTier, description: rung.description.trim() })
  }
  rungs.sort((a, b) => a.tier - b.tier)
  return rungs.length ? rungs : undefined
}

function parseTopLevelObject(output: string): Record<string, unknown> | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const text = (fenced ?? output).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Parse the agent's top-level `variantDimension` (D1) from the output, if any.
 *  Separate from `parsePrdSummaryOutput` so the latter keeps its array contract;
 *  pass the result back in to validate each requirement's `variants`. */
export function parseVariantDimension(output: string): VariantDimension | undefined {
  const parsed = parseTopLevelObject(output)
  return parsed ? normalizeVariantDimension(parsed.variantDimension) : undefined
}

/** Parse raw agent stdout into requirement candidates. Returns null on garbage.
 *  `variantDimension` (when supplied) is the closed vocabulary a requirement's
 *  `variants` is validated against. */
export function parsePrdSummaryOutput(
  output: string,
  variantDimension?: VariantDimension,
): ParsedRequirement[] | null {
  const parsed = parseTopLevelObject(output)
  if (!parsed) return null
  const reqs = parsed.requirements
  if (!Array.isArray(reqs)) return null
  const out: ParsedRequirement[] = []
  for (const raw of reqs) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.title !== 'string' || typeof r.text !== 'string') continue
    if (!r.title.trim() || !r.text.trim()) continue
    const variants = normalizeRequirementVariants(r.variants, variantDimension)
    out.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : undefined,
      kind: normalizeKind(r.kind),
      title: r.title.trim(),
      text: r.text.trim(),
      happyPath: normalizeProse(r.happyPath),
      unhappyPath: normalizeProse(r.unhappyPath),
      pathTypes: normalizePathTypes(r.pathTypes),
      variants,
      variantsNA: normalizeRequirementVariantsNA(r.variantsNA, variants),
      strictnessLadder: normalizeLadder(r.strictnessLadder),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The id spine — deterministic, canary-owned. Highest-risk invariant.
// ---------------------------------------------------------------------------

function maxIdNumber(ids: Iterable<string>): number {
  let max = 0
  for (const id of ids) {
    const m = /^R(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

/**
 * Assign stable ids to a freshly-parsed requirement list, preserving the ids of
 * surviving requirements. Survivorship is decided by, in priority order:
 *   1. an echoed id that matches a previous requirement,
 *   2. an exact normalized-title match to an unused previous requirement.
 * Anything else gets a fresh `R<n>` beyond every existing id. Previous
 * requirements that survive nothing are carried over as `deprecated` (kept, not
 * deleted) so dangling `@requirement` annotations still resolve.
 */
export function reconcileRequirementIds(
  previous: Requirement[],
  parsed: ParsedRequirement[],
): Requirement[] {
  const prevById = new Map(previous.map((r) => [r.id, r]))
  const prevByTitle = new Map<string, Requirement>()
  for (const r of previous) {
    const key = normalizeTitle(r.title)
    if (!prevByTitle.has(key)) prevByTitle.set(key, r)
  }
  const usedPrevIds = new Set<string>()
  const assignedIds = new Set<string>(prevById.keys())
  let counter = maxIdNumber(prevById.keys())

  const freshId = (): string => {
    let id: string
    do {
      counter += 1
      id = `R${counter}`
    } while (assignedIds.has(id))
    assignedIds.add(id)
    return id
  }

  const out: Requirement[] = []
  for (const candidate of parsed) {
    let id: string | undefined
    if (candidate.id && prevById.has(candidate.id) && !usedPrevIds.has(candidate.id)) {
      id = candidate.id
    } else {
      const titleMatch = prevByTitle.get(normalizeTitle(candidate.title))
      if (titleMatch && !usedPrevIds.has(titleMatch.id)) id = titleMatch.id
    }
    let survivedFrom: Requirement | undefined
    if (id) {
      usedPrevIds.add(id)
      survivedFrom = prevById.get(id)
    } else {
      id = freshId()
    }

    out.push({
      id,
      kind: candidate.kind ?? survivedFrom?.kind,
      title: candidate.title,
      text: candidate.text,
      happyPath: candidate.happyPath ?? survivedFrom?.happyPath,
      unhappyPath: candidate.unhappyPath ?? survivedFrom?.unhappyPath,
      pathTypes: candidate.pathTypes,
      // Variants are freshly re-extracted each regen; fall back to a survivor's
      // set only when this pass proposed none (parallels the ladder).
      variants: candidate.variants ?? survivedFrom?.variants,
      variantsNA: candidate.variantsNA ?? survivedFrom?.variantsNA,
      // The strictness ladder is per-domain and stable; preserve a survivor's
      // existing ladder when the regen doesn't re-propose one (parallels id
      // preservation — agents shouldn't have to re-derive it every time).
      strictnessLadder: candidate.strictnessLadder ?? survivedFrom?.strictnessLadder,
    })
  }

  // Carry over un-matched previous requirements as deprecated so their ids — and
  // any annotations pointing at them — keep resolving.
  for (const prev of previous) {
    if (usedPrevIds.has(prev.id)) continue
    out.push({ ...prev, deprecated: true })
  }
  return out
}

/**
 * Assemble a `PrdSummary` from freshly-parsed requirements: reconcile ids against
 * `previous` (the stable spine), stamp docs hash / source-doc list / timestamp,
 * and persist per-doc + per-requirement fingerprints. The single home for turning
 * a `ParsedRequirement[]` into a stored summary — shared by the internal
 * agent-backed `summarizePrd` and the offloaded `applyExternalSummary`, so the
 * id-spine invariant (R: never trust the agent to renumber) holds on both paths.
 */
export function assembleSummary(
  collection: DocsCollection,
  previous: PrdSummary | null,
  parsed: ParsedRequirement[],
  variantDimension?: VariantDimension,
  now?: string,
): PrdSummary {
  const requirements = reconcileRequirementIds(previous?.requirements ?? [], parsed)
  // Preserve a prior dimension when this pass didn't re-declare one (stability,
  // like requirement ids) — but a freshly-declared dimension always wins.
  const dimension = variantDimension ?? previous?.variantDimension
  const summary: PrdSummary = {
    requirements,
    ...(dimension ? { variantDimension: dimension } : {}),
    docsHash: collection.docsHash,
    sourceDocs: collection.entries.map((e) => e.relPath),
    generatedAt: now ?? new Date().toISOString(),
  }
  return withFingerprints(summary, collection.entries)
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
  const template = fs.readFileSync(templatePath, 'utf-8').trim()
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
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key === 'docs') return docs
    if (key === 'previousRequirements') return previousJson
    if (key === 'previousVariantDimension') return previousDimensionJson
    return match
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
    ? buildClaudeAgenticArgs(prompt, { model: PRD_SUMMARY_MODELS.claude, sessionId: claudeSessionId })
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
  if (agents.length) {
    const prompt = buildPrdSummaryPrompt(args.collection, previous, args.previous?.variantDimension)
    for (const agent of agents) {
      try {
        args.onOutput?.(`[agent:${agent}] summarizing PRD\n`)
        const output = await runAgent(agent, prompt, {
          cwd: args.cwd,
          signal: args.signal,
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
        args.onOutput?.(`[agent:${agent}] failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  if (!parsedReqs) {
    // LLM-only: no agent on PATH, or every agent failed / returned unparseable
    // output. We never fabricate requirements from headings — that produced
    // phantom requirements (goals/context/architecture) and tanked coverage.
    throw new Error(
      'PRD summary requires the claude or codex agent — none produced a usable result. Ensure claude or codex is on PATH.',
    )
  }

  // Reconcile ids + stamp fingerprints (R3) through the shared assembler so the
  // offloaded path produces a byte-identical summary shape.
  return assembleSummary(args.collection, args.previous ?? null, parsedReqs, parsedDimension, args.now)
}

// ---------------------------------------------------------------------------
// Render + storage (the sidecar JSON + human-readable markdown in docs/)
// ---------------------------------------------------------------------------

/**
 * Render the summary to markdown and compute each requirement's `sourceRange`
 * (char offsets of its body in the rendered text) so the UI can highlight PRD
 * spans. Returns the markdown and a requirements copy carrying the ranges.
 */
export function renderPrdSummaryMarkdown(
  summary: PrdSummary,
  featureName: string,
): { markdown: string; requirements: Requirement[] } {
  // Requirements-driven, no problem-statement preamble: the doc opens straight
  // into the feature's expectations, grouped functional → non-functional, each
  // an "it should …" statement with its happy / unhappy paths spelled out.
  let md = `# ${featureName} — Requirements\n\n`
  md += `<!-- generated by canary-lab verified-coverage; edit source docs and regenerate -->\n\n`

  const requirements: Requirement[] = []
  const sections: Array<{ heading: string; kind: 'functional' | 'non-functional' }> = [
    { heading: 'Functional requirements', kind: 'functional' },
    { heading: 'Non-functional requirements', kind: 'non-functional' },
  ]

  for (const section of sections) {
    // Requirements default to functional when unclassified (older summaries /
    // deterministic fallback), so they always land in a section.
    const inSection = summary.requirements.filter(
      (r) => (r.kind ?? 'functional') === section.kind,
    )
    if (inSection.length === 0) continue
    md += `## ${section.heading}\n\n`
    inSection.forEach((req, i) => {
      md += `### ${i + 1}. ${req.id} — ${req.title}${req.deprecated ? ' (deprecated)' : ''}\n\n`
      const start = md.length
      md += req.text
      const end = md.length
      md += '\n\n'
      if (req.happyPath) md += `- **Happy path:** ${req.happyPath}\n`
      if (req.unhappyPath) md += `- **Unhappy path:** ${req.unhappyPath}\n`
      md += `- _Paths: ${req.pathTypes.join(', ')}_\n`
      if (req.variants && req.variants.length) {
        md += `- _${summary.variantDimension?.name ?? 'Variants'}: ${req.variants.join(', ')}_\n`
      }
      if (req.variantsNA && req.variantsNA.length) {
        md += `- _N/A: ${req.variantsNA.map((n) => `${n.variant} (${n.reason})`).join('; ')}_\n`
      }
      md += '\n'
      requirements.push({ ...req, sourceRange: { start, end } })
    })
  }
  return { markdown: md.trimEnd() + '\n', requirements }
}

export function writePrdSummary(
  featureDir: string,
  featureName: string,
  summary: PrdSummary,
): PrdSummary {
  const docsDir = docsDirFor(featureDir)
  fs.mkdirSync(docsDir, { recursive: true })
  const { markdown, requirements } = renderPrdSummaryMarkdown(summary, featureName)
  const withRanges: PrdSummary = { ...summary, requirements }
  fs.writeFileSync(path.join(docsDir, PRD_SUMMARY_JSON), JSON.stringify(withRanges, null, 2) + '\n')
  fs.writeFileSync(path.join(docsDir, PRD_SUMMARY_MD), markdown)
  return withRanges
}

export function readPrdSummary(featureDir: string): PrdSummary | null {
  const file = path.join(docsDirFor(featureDir), PRD_SUMMARY_JSON)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as PrdSummary
  } catch {
    return null
  }
}
