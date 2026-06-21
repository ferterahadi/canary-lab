import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pickAvailableHealAgent, type HealAgent } from '../../../runs/logic/runtime/auto-heal'
import { PRD_SUMMARY_MODELS, modelArgs } from '../../../agent-sessions/logic/agent-models'
import type { CoverageAgentSession } from '../../../coverage/logic/coverage/annotate-engine'
import { claudeSessionLogPath } from '../../../agent-sessions/logic/agent-session-log'
import { recoverClaudeFinalText } from '../../../agent-sessions/logic/agent-stream'
import { runAgentProcess, buildClaudeAgenticArgs } from '../../../agent-sessions/logic/agent-process'
import type {
  PathType,
  PrdSummary,
  Requirement,
  StrictnessLadderRung,
  StrictnessTier,
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
  title: string
  text: string
  pathTypes: PathType[]
  strictnessLadder?: StrictnessLadderRung[]
}

export type SummarizeAdapter = 'auto' | 'claude' | 'codex' | 'deterministic'

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

/** Parse raw agent stdout into requirement candidates. Returns null on garbage. */
export function parsePrdSummaryOutput(output: string): ParsedRequirement[] | null {
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
  const reqs = (parsed as { requirements?: unknown }).requirements
  if (!Array.isArray(reqs)) return null
  const out: ParsedRequirement[] = []
  for (const raw of reqs) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.title !== 'string' || typeof r.text !== 'string') continue
    if (!r.title.trim() || !r.text.trim()) continue
    out.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : undefined,
      title: r.title.trim(),
      text: r.text.trim(),
      pathTypes: normalizePathTypes(r.pathTypes),
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
      title: candidate.title,
      text: candidate.text,
      pathTypes: candidate.pathTypes,
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

// ---------------------------------------------------------------------------
// Deterministic fallback (no agent on PATH, or adapter:'deterministic')
// ---------------------------------------------------------------------------

interface RawRequirement {
  title: string
  text: string
}

/** Pull heading-anchored requirements out of one markdown doc. */
function extractRawRequirements(collection: DocsCollection): RawRequirement[] {
  const raw: RawRequirement[] = []
  for (const entry of collection.entries) {
    const lines = entry.content.split(/\r?\n/)
    const headingIdxs: number[] = []
    lines.forEach((line, i) => {
      if (/^#{1,6}\s+\S/.test(line)) headingIdxs.push(i)
    })
    if (!headingIdxs.length) {
      const firstBody = lines.find((l) => l.trim())?.trim()
      raw.push({
        title: entry.relPath.replace(/\.md$/i, ''),
        text: firstBody || entry.relPath,
      })
      continue
    }
    headingIdxs.forEach((start, n) => {
      const endLine = headingIdxs[n + 1] ?? lines.length
      const title = lines[start].replace(/^#{1,6}\s+/, '').trim()
      const body = lines
        .slice(start + 1, endLine)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ')
      raw.push({ title, text: body || title })
    })
  }
  return raw
}

export function deterministicPrdRequirements(
  collection: DocsCollection,
  previous: Requirement[],
): Requirement[] {
  const parsed: ParsedRequirement[] = extractRawRequirements(collection).map((r) => ({
    title: r.title,
    text: r.text,
    pathTypes: ['happy'],
  }))
  return reconcileRequirementIds(previous, parsed)
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildPrdSummaryPrompt(
  collection: DocsCollection,
  previous: Requirement[],
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
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key === 'docs') return docs
    if (key === 'previousRequirements') return previousJson
    return match
  })
}

// ---------------------------------------------------------------------------
// Agent resolution + default spawn runner (mirrors the evaluation-export shape)
// ---------------------------------------------------------------------------

function defaultResolveAgents(adapter: SummarizeAdapter): HealAgent[] {
  if (adapter === 'deterministic') return []
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
    activityPath: agent === 'claude' && claudeSessionId && opts.cwd ? claudeSessionLogPath(opts.cwd, claudeSessionId) : undefined,
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
        let finalOutput = agent === 'claude' ? recoverClaudeFinalText(stdout) : stdout
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

  let requirements: Requirement[] | null = null
  if (agents.length) {
    const prompt = buildPrdSummaryPrompt(args.collection, previous)
    for (const agent of agents) {
      try {
        args.onOutput?.(`[agent:${agent}] summarizing PRD\n`)
        const output = await runAgent(agent, prompt, {
          cwd: args.cwd,
          signal: args.signal,
          onOutput: args.onOutput,
          onSession: args.onSession,
        })
        const parsed = parsePrdSummaryOutput(output)
        if (parsed && parsed.length) {
          requirements = reconcileRequirementIds(previous, parsed)
          break
        }
        args.onOutput?.(`[agent:${agent}] unparseable output; trying next\n`)
      } catch (err) {
        args.onOutput?.(`[agent:${agent}] failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  if (!requirements) {
    requirements = deterministicPrdRequirements(args.collection, previous)
  }

  const summary: PrdSummary = {
    requirements,
    docsHash: args.collection.docsHash,
    sourceDocs: args.collection.entries.map((e) => e.relPath),
    generatedAt: args.now ?? new Date().toISOString(),
  }
  // Persist per-doc + per-requirement fingerprints (R3) so drift can name which
  // docs changed and coverage staleness can key on the requirements set.
  return withFingerprints(summary, args.collection.entries)
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
  let md = `# ${featureName} — Requirements\n\n`
  md += `<!-- generated by canary-lab verified-coverage; edit source docs and regenerate -->\n\n`
  const requirements: Requirement[] = []
  for (const req of summary.requirements) {
    const heading = `## ${req.id} — ${req.title}${req.deprecated ? ' (deprecated)' : ''}\n\n`
    md += heading
    const start = md.length
    md += req.text
    const end = md.length
    md += `\n\n_Paths: ${req.pathTypes.join(', ')}_\n\n`
    requirements.push({ ...req, sourceRange: { start, end } })
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
