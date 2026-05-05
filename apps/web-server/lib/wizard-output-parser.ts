// Pure parsers for wizard agent output. Stage-1 emits a JSON test plan
// between literal `<plan-output>` / `</plan-output>` markers; stage-2 emits
// each generated file in a `<file path="...">…</file>` block. Both helpers
// are tolerant of agent chatter before/after the markers and return a typed
// failure rather than throwing — the route layer turns failures into 4xx /
// status='error' transitions.

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export interface PlanStep {
  coverageType?: string
  step: string
  actions: string[]
  expectedOutcome: string
}

const PLAN_OPEN = '<plan-output>'
const PLAN_CLOSE = '</plan-output>'

export function extractPlan(stream: string): ParseResult<PlanStep[]> {
  const open = stream.indexOf(PLAN_OPEN)
  if (open < 0) return { ok: false, error: 'plan-output marker not found' }
  const close = stream.indexOf(PLAN_CLOSE, open + PLAN_OPEN.length)
  if (close < 0) return { ok: false, error: 'plan-output close marker not found' }
  const body = stream.slice(open + PLAN_OPEN.length, close).trim()
  if (!body) return { ok: false, error: 'plan-output body empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    return { ok: false, error: `plan JSON parse failed: ${(e as Error).message}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'plan must be a JSON array' }
  const out: PlanStep[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown> | null
    if (!item || typeof item !== 'object') return { ok: false, error: `plan[${i}] is not an object` }
    const step = item.step
    const coverageType = item.coverageType
    const actions = item.actions
    const expectedOutcome = item.expectedOutcome
    if (coverageType !== undefined && typeof coverageType !== 'string') {
      return { ok: false, error: `plan[${i}].coverageType must be a string` }
    }
    if (typeof step !== 'string' || !step.trim()) return { ok: false, error: `plan[${i}].step missing` }
    if (!Array.isArray(actions) || !actions.every((a) => typeof a === 'string')) {
      return { ok: false, error: `plan[${i}].actions must be string[]` }
    }
    if (typeof expectedOutcome !== 'string') return { ok: false, error: `plan[${i}].expectedOutcome missing` }
    out.push({ coverageType, step, actions: actions as string[], expectedOutcome })
  }
  return { ok: true, value: out }
}

export interface GeneratedFile {
  path: string
  content: string
}

// Block matcher that tolerates triple-backtick fences inside the file body —
// we only require `<file path="…">` … `</file>` to bookend each file and
// that paths be relative + free of `..` segments. Uses matchAll for cleaner
// iteration than RegExp state.
const FILE_BLOCK_RE = /<file\s+path="([^"]+)"\s*>([\s\S]*?)<\/file>/g

export function extractGeneratedFiles(stream: string): ParseResult<GeneratedFile[]> {
  const out: GeneratedFile[] = []
  for (const match of stream.matchAll(FILE_BLOCK_RE)) {
    const filePath = match[1].trim()
    if (!filePath) return { ok: false, error: 'file path empty' }
    if (filePath.startsWith('/') || filePath.includes('..')) {
      return { ok: false, error: `file path "${filePath}" must be relative without ..` }
    }
    let content = match[2]
    // Strip the very first leading newline (cosmetic — the agent typically
    // writes `<file path="x">\n<code>\n</file>`).
    if (content.startsWith('\n')) content = content.slice(1)
    // Trim a single trailing newline too, but preserve any deliberate blank
    // line at end of file.
    if (content.endsWith('\n')) content = content.slice(0, -1)
    out.push({ path: filePath, content })
  }
  if (out.length === 0) return { ok: false, error: 'no <file> blocks found' }
  return { ok: true, value: out }
}
