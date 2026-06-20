// Template-based log compression — a dependency-free take on the idea behind
// Headroom's log compressor. Instead of only collapsing *byte-identical*
// consecutive lines, we collapse lines that share a TEMPLATE: the line with its
// volatile metadata (timestamps, durations, plain numbers) masked out. A
// boot/retry loop that logs "waiting for db (attempt 1)" … "(attempt 312)"
// shares one template and collapses to a single representative + `(×312)`.
//
// This is the over-budget alternative to head+tail truncation: collapsing
// repeated noise keeps full temporal coverage of the log, which beats dropping
// the middle. The full, uncompressed source is always still on disk and pointed
// at, so the collapse is reversible (Headroom's CCR principle, our pointers).
//
// What we mask vs. protect — the rule is "mask *when/how-long* metadata, never
// *who/where/which* identity":
//   - MASK: timestamps, durations, plain numbers. Different values here usually
//     mean the SAME event-type logged again (jitter), so masking enables the
//     collapse we want. For durations/numbers we also surface a min–max range
//     so a buried outlier (a latency spike, a status code) isn't hidden.
//   - PROTECT (kept verbatim → distinct values stay distinct → never collapse):
//     UUIDs, IPs, hex literals. These are the identifiers the agent traces a
//     specific case by; collapsing them would both merge distinct entities and
//     drop the IDs. We protect them BEFORE masking so the generic-number mask
//     can't shred an IP's octets either.
//
// Safety: lines containing an error keyword (error/fail/exception/…) are keyed
// by their RAW text, so two such lines differing only in a masked token
// (`ERROR upstream returned 500` vs `… 404`) never merge — they collapse only
// when byte-identical. Highest-signal lines stay verbatim.

export interface TemplateCompressResult {
  /** The compressed log text. */
  text: string
  /** How many lines were removed by collapsing (sum of count-1 per template). */
  collapsedLines: number
}

const ERROR_RE = /\b(error|errors|fail|failed|failure|exception|fatal|panic|traceback|unhandled|assert|assertion)\b/i

// Identity tokens kept VERBATIM in the template. Combined into one pass so
// matches are stashed in positional order (uuid | ipv4[:port] | 0x-hex).
const IDENTITY_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b|\b0x[0-9a-fA-F]+\b/g

// Metadata maskers. Number mask MUST run after duration so "12ms" becomes
// <dur>, not <n> + "ms".
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g
const DUR_RE = /\b\d+(?:\.\d+)?(?:ms|s|m|h|us|ns|µs)\b/g
const NUM_RE = /\b\d+(?:\.\d+)?\b/g

// A marker that no masker matches (NUL — not a word char or digit, and never
// present in real log text, unlike spaces which logs use for alignment).
// Protected tokens are replaced with it and restored in positional order.
const MARK = '\x00'

const DUR_UNIT_MS: Record<string, number> = {
  ns: 1e-6, 'µs': 1e-3, us: 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000,
}

export function durationToMs(token: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|us|ns|µs)$/.exec(token)
  return m ? parseFloat(m[1]) * DUR_UNIT_MS[m[2]] : NaN
}

interface Masked { template: string; durations: string[]; numbers: number[] }

function maskLine(line: string): Masked {
  const durations: string[] = []
  const numbers: number[] = []
  const protectedToks: string[] = []

  // 1. Protect identity tokens (verbatim in the template).
  let t = line.replace(IDENTITY_RE, (m) => { protectedToks.push(m); return MARK })
  // 2. Mask metadata.
  t = t.replace(TS_RE, '<ts>')
  t = t.replace(DUR_RE, (tok) => { durations.push(tok); return '<dur>' })
  t = t.replace(NUM_RE, (tok) => { numbers.push(parseFloat(tok)); return '<n>' })
  // 3. Restore protected tokens in original order.
  let k = 0
  t = t.replace(/\x00/g, () => protectedToks[k++])

  return { template: t, durations, numbers }
}

/** Mask the volatile metadata of a single line to produce its template key. */
export function lineTemplate(line: string): string {
  return maskLine(line).template
}

interface Stat {
  count: number
  hasDur: boolean; durMinMs: number; durMaxMs: number; durMinRaw: string; durMaxRaw: string
  hasNum: boolean; numMin: number; numMax: number
}

function newStat(): Stat {
  return {
    count: 0,
    hasDur: false, durMinMs: 0, durMaxMs: 0, durMinRaw: '', durMaxRaw: '',
    hasNum: false, numMin: 0, numMax: 0,
  }
}

function recordDurations(s: Stat, durations: string[]): void {
  for (const d of durations) {
    const ms = durationToMs(d)
    if (!s.hasDur || ms < s.durMinMs) { s.durMinMs = ms; s.durMinRaw = d }
    if (!s.hasDur || ms > s.durMaxMs) { s.durMaxMs = ms; s.durMaxRaw = d }
    s.hasDur = true
  }
}

function recordNumbers(s: Stat, numbers: number[]): void {
  for (const n of numbers) {
    if (!s.hasNum || n < s.numMin) s.numMin = n
    if (!s.hasNum || n > s.numMax) s.numMax = n
    s.hasNum = true
  }
}

// `(×N)`, plus a min–max range when a masked duration or number actually varied
// across the collapsed lines — so a buried outlier stays visible.
function countSuffix(s: Stat): string {
  let suffix = `  (×${s.count}`
  if (s.hasDur && s.durMaxMs !== s.durMinMs) suffix += `; ${s.durMinRaw}–${s.durMaxRaw}`
  if (s.hasNum && s.numMax !== s.numMin) suffix += `; ${s.numMin}–${s.numMax}`
  return `${suffix})`
}

/**
 * Collapse lines that repeat under the same template. A template seen at least
 * `minRepeat` times keeps only its FIRST occurrence (annotated with `(×N)` and,
 * when a masked duration/number varied, a min–max range) and drops the rest, in
 * order. Blank lines, identity tokens, and error-keyword lines are never merged
 * across differing content.
 */
export function compressLogByTemplate(text: string, minRepeat = 3): TemplateCompressResult {
  const lines = text.split('\n')
  const stats = new Map<string, Stat>()
  const keys: Array<string | null> = []

  for (const line of lines) {
    if (line.trim().length === 0) { keys.push(null); continue }
    let key: string
    let masked: Masked | null = null
    if (ERROR_RE.test(line)) {
      key = line // raw text → only byte-identical error lines collapse
    } else {
      masked = maskLine(line)
      key = masked.template
    }
    keys.push(key)
    const s = stats.get(key) ?? newStat()
    s.count++
    if (masked) {
      recordDurations(s, masked.durations)
      recordNumbers(s, masked.numbers)
    }
    stats.set(key, s)
  }

  const seen = new Set<string>()
  const out: string[] = []
  let collapsedLines = 0
  for (let i = 0; i < lines.length; i++) {
    const key = keys[i]
    if (key === null) { out.push(lines[i]); continue }
    const s = stats.get(key)!
    if (s.count < minRepeat) { out.push(lines[i]); continue }
    if (seen.has(key)) { collapsedLines++; continue }
    seen.add(key)
    out.push(`${lines[i]}${countSuffix(s)}`)
  }

  return { text: out.join('\n'), collapsedLines }
}
