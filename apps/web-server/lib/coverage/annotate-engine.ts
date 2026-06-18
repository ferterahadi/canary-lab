import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { pickAvailableHealAgent, type HealAgent } from '../runtime/auto-heal'
import { ANNOTATE_MODELS, modelArgs } from '../agent-models'
import { makeClaudeStreamSink } from './agent-stream'
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
const ANNOTATE_TIMEOUT_MS = 180_000

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
  // the Generating screen can stream it (R17). `-p` still writes the session log.
  const claudeSessionId = agent === 'claude' ? crypto.randomUUID() : undefined
  // Stream-json gives a live token stream on stdout (R: live agent output) — the
  // sink renders readable text to onOutput as the model writes and recovers the
  // final answer. `--session-id` still pins the on-disk session for the timeline.
  const args = agent === 'claude'
    ? [...modelArgs(ANNOTATE_MODELS.claude), '--output-format=stream-json', '--include-partial-messages', '--verbose', '--session-id', claudeSessionId!, '-p', prompt]
    : codexArgs(outputPath!)
  opts.onSession?.(agent === 'claude' ? { agent: 'claude', sessionId: claudeSessionId! } : { agent: 'codex', sessionId: '' })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const claudeSink = agent === 'claude' ? makeClaudeStreamSink(opts.onOutput) : null
    const child = spawn(agent, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const cleanup = () => {
      opts.signal?.removeEventListener('abort', abort)
      if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true })
    }
    const finish = (err?: Error, output?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      if (err) reject(err)
      else resolve(output ?? '')
    }
    const abort = () => {
      child.kill('SIGTERM')
      finish(new Error('coverage annotate cancelled'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error(`coverage annotate agent timed out after ${ANNOTATE_TIMEOUT_MS}ms`))
    }, ANNOTATE_TIMEOUT_MS)
    if (opts.signal?.aborted) {
      abort()
      return
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk) => {
      const t = chunk.toString('utf-8')
      stdout += t
      // claude: parse the stream-json + stream readable text; codex: raw passthrough.
      if (claudeSink) claudeSink.push(t)
      else opts.onOutput?.(t)
    })
    child.stderr.on('data', (chunk) => {
      const t = chunk.toString('utf-8')
      stderr += t
      opts.onOutput?.(t)
    })
    child.on('error', (error) => finish(new Error(`coverage annotate agent failed: ${error.message}`)))
    child.on('close', (code, sig) => {
      if (code !== 0) {
        finish(new Error(`coverage annotate agent failed with ${sig ?? `exit code ${code}`}${stderr ? `\n${stderr}` : ''}`))
        return
      }
      let finalOutput = claudeSink ? claudeSink.finalText() : stdout
      if (outputPath && fs.existsSync(outputPath)) {
        const fromFile = fs.readFileSync(outputPath, 'utf-8')
        if (fromFile.trim()) finalOutput = fromFile
      }
      finish(undefined, finalOutput)
    })
    if (agent === 'codex') child.stdin.end(prompt)
    else child.stdin.end()
  })
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
