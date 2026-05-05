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

export type WizardSessionKind = 'claude' | 'codex'

export interface WizardSessionRef {
  kind: WizardSessionKind
  id: string
}

const SESSION_RE = /\[\[canary-lab:wizard-session agent=(claude|codex) id=([^\]\s]+)\]\]/

export function extractWizardSessionRef(stream: string): WizardSessionRef | null {
  const match = SESSION_RE.exec(stream)
  if (!match) return null
  return { kind: match[1] as WizardSessionKind, id: match[2] }
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

export interface GeneratedSpecOutput {
  files: GeneratedFile[]
  devDependencies: string[]
}

// Block matcher that tolerates triple-backtick fences inside the file body —
// we only require `<file path="…">` … `</file>` to bookend each file and
// that paths be relative + free of `..` segments. Uses matchAll for cleaner
// iteration than RegExp state.
const FILE_BLOCK_RE = /<file\s+path="([^"]+)"\s*>([\s\S]*?)<\/file>/g
const DEV_DEPS_BLOCK_RE = /<dev-dependencies\s*>([\s\S]*?)<\/dev-dependencies>/g
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i

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

export function extractDevDependencies(stream: string): ParseResult<string[]> {
  const matches = [...stream.matchAll(DEV_DEPS_BLOCK_RE)]
  if (matches.length === 0) return { ok: true, value: [] }
  if (matches.length > 1) return { ok: false, error: 'multiple dev-dependencies blocks found' }

  const body = matches[0][1].trim()
  if (!body) return { ok: false, error: 'dev-dependencies body empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    return { ok: false, error: `dev-dependencies JSON parse failed: ${(e as Error).message}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'dev-dependencies must be a JSON array' }

  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const value = parsed[i]
    if (typeof value !== 'string') return { ok: false, error: `devDependencies[${i}] must be a string` }
    const name = value.trim()
    if (!name) return { ok: false, error: `devDependencies[${i}] is empty` }
    if (!PACKAGE_NAME_RE.test(name)) return { ok: false, error: `invalid package name "${name}"` }
    if (seen.has(name)) return { ok: false, error: `duplicate dev dependency "${name}"` }
    seen.add(name)
    out.push(name)
  }
  return { ok: true, value: out }
}

export function extractGeneratedSpecOutput(stream: string): ParseResult<GeneratedSpecOutput> {
  const files = extractGeneratedFiles(stream)
  if (!files.ok) return files
  const devDependencies = extractDevDependencies(stream)
  if (!devDependencies.ok) return devDependencies
  return { ok: true, value: { files: files.value, devDependencies: devDependencies.value } }
}
