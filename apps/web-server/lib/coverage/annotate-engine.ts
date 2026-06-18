import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pickAvailableHealAgent, type HealAgent } from '../runtime/auto-heal'
import { ANNOTATE_MODELS, modelArgs } from '../agent-models'
import { claudeSessionLogPath } from '../agent-session-log'
import { recoverClaudeFinalText } from '../agent-stream'
import { runAgentProcess, buildClaudeAgenticArgs } from '../agent-process'
import type { PathType, ProposedMapping, Requirement } from '../../../../shared/coverage/types'

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

const ANNOTATE_TEMPLATE_PATH = path.join(__dirname, '../../prompts/coverage-annotate.md')
const ANNOTATE_SCHEMA_PATH = path.join(__dirname, '../../prompts/coverage-annotate.schema.json')
// Idle (inactivity) window: the annotate agent is killed only after this long
// with NO activity, not on a fixed wall-clock deadline (see agent-idle-timer.ts).
const ANNOTATE_IDLE_TIMEOUT_MS = 5 * 60 * 1000

const PATH_TYPES: PathType[] = ['happy', 'sad', 'edge']

export type AnnotateAdapter = 'auto' | 'claude' | 'codex' | 'deterministic'

/** A test the engine may map — name + enough body/assertions to reason over. */
export interface AnnotateTestInput {
  name: string
  file?: string
  bodySource?: string
  assertions?: string[]
}

export interface ProposeMappingsArgs {
  requirements: Requirement[]
  tests: AnnotateTestInput[]
  adapter?: AnnotateAdapter
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
export function parseAnnotateOutput(output: string, knownIds: Set<string>): ProposedMapping[] | null {
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
    out.push({
      testName,
      requirements,
      pathTypes: normalizePathTypes(r.pathTypes),
      rationale: typeof r.rationale === 'string' ? r.rationale.trim() || undefined : undefined,
      confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : undefined,
      source: 'agent',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Deterministic fallback — token-overlap heuristic (no agent on PATH)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'be', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'by', 'from', 'should', 'must', 'when', 'then',
  'test', 'tests', 'verify', 'verifies', 'check', 'checks', 'via',
])

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.trim()
    if (t.length >= 3 && !STOP_WORDS.has(t)) out.add(t)
  }
  return out
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Map each test to its single best-matching requirement by token overlap.
 *  Conservative — only proposes when overlap clears the threshold. */
export function deterministicMappings(
  requirements: Requirement[],
  tests: AnnotateTestInput[],
  threshold = 0.3,
): ProposedMapping[] {
  const active = requirements.filter((r) => !r.deprecated)
  const reqTokens = active.map((r) => ({ req: r, tokens: tokenize(`${r.title} ${r.text}`) }))
  const out: ProposedMapping[] = []
  for (const test of tests) {
    const testTokens = tokenize(`${test.name} ${test.bodySource ?? ''}`)
    let best: { id: string; score: number } | null = null
    for (const { req, tokens } of reqTokens) {
      const score = overlapScore(testTokens, tokens)
      if (score > 0 && (!best || score > best.score)) best = { id: req.id, score }
    }
    if (best && best.score >= threshold) {
      out.push({
        testName: test.name,
        file: test.file,
        requirements: [best.id],
        pathTypes: ['happy'],
        rationale: `token overlap ${Math.round(best.score * 100)}% with requirement ${best.id}`,
        confidence: Math.round(best.score * 100) / 100,
        source: 'deterministic',
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildAnnotatePrompt(
  requirements: Requirement[],
  tests: AnnotateTestInput[],
  templatePath: string = ANNOTATE_TEMPLATE_PATH,
): string {
  const template = fs.readFileSync(templatePath, 'utf-8').trim()
  const active = requirements.filter((r) => !r.deprecated)
  const reqJson = JSON.stringify(
    active.map((r) => ({ id: r.id, title: r.title, text: r.text, pathTypes: r.pathTypes })),
    null,
    2,
  )
  const testJson = JSON.stringify(
    tests.map((t) => ({
      testName: t.name,
      file: t.file,
      body: t.bodySource?.slice(0, 2000),
      assertions: t.assertions,
    })),
    null,
    2,
  )
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key === 'requirements') return reqJson
    if (key === 'tests') return testJson
    return match
  })
}

// ---------------------------------------------------------------------------
// Agent resolution + default spawn runner (mirrors prd-summary)
// ---------------------------------------------------------------------------

function defaultResolveAgents(adapter: AnnotateAdapter): HealAgent[] {
  if (adapter === 'deterministic') return []
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
        if (opts.signal?.aborted) throw new Error('coverage annotate cancelled')
        if (idled) throw new Error(`coverage annotate agent idle for ${ANNOTATE_IDLE_TIMEOUT_MS}ms`)
        if (code !== 0) {
          throw new Error(`coverage annotate agent failed with ${signal ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`)
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

  if (agents.length) {
    const prompt = buildAnnotatePrompt(args.requirements, args.tests)
    for (const agent of agents) {
      try {
        args.onOutput?.(`[agent:${agent}] inferring coverage mappings\n`)
        const output = await runAgent(agent, prompt, {
          cwd: args.cwd,
          signal: args.signal,
          onOutput: args.onOutput,
          onSession: args.onSession,
        })
        const parsed = parseAnnotateOutput(output, knownIds)
        if (parsed) return parsed // [] is a valid answer (nothing maps)
        args.onOutput?.(`[agent:${agent}] unparseable output; trying next\n`)
      } catch (err) {
        args.onOutput?.(`[agent:${agent}] failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  return deterministicMappings(args.requirements, args.tests)
}
