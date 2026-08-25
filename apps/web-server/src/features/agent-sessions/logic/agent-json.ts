// Pull JSON out of an agent's final answer text. One home for every producer
// (coverage annotate, PRD summary, evaluation rewrite, flight stages) — the
// per-caller copies all sliced first-`{`→last-`}`, which breaks the moment the
// agent's prose contains a brace before the answer (e.g. inline code like
// `async () => {}`), silently discarding a valid answer.
//
// Candidate order (first = most likely the real answer):
//   1. fenced ```json blocks, LAST first — when a transcript carries several,
//      the agent's real answer is the final fence; earlier ones are usually
//      reasoning/examples.
//   2. balanced top-level `{…}` objects found anywhere in the text, LARGEST
//      first — the real answer dwarfs prose asides (`{}`, `{phone}`), and prose
//      can trail the answer as easily as precede it, so position is no signal.
//
// Callers iterate the candidates and keep the first one matching their expected
// shape (e.g. `Array.isArray(c.mappings)`), so a stray parseable aside can't
// shadow the real answer.

/** End index of the balanced object starting at `start` (which must be `{`),
 *  honoring JSON string literals and escapes; -1 when unterminated. */
function matchBalancedObject(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

/** Every balanced top-level `{…}` substring, in order of appearance. */
function scanBalancedObjects(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const end = matchBalancedObject(text, i)
    // Unterminated → try the next `{` (a truncated object must not swallow a
    // complete one that starts later).
    if (end === -1) continue
    out.push(text.slice(i, end + 1))
    i = end
  }
  return out
}

/** Parse every plausible JSON value out of an agent's answer, best-first.
 *  Returns [] when nothing parses. */
export function extractJsonCandidates(text: string): unknown[] {
  const raw: string[] = []
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g
  for (let m = fenceRe.exec(text); m !== null; m = fenceRe.exec(text)) {
    if (m[1]?.trim()) raw.unshift(m[1])
  }
  raw.push(...scanBalancedObjects(text).sort((a, b) => b.length - a.length))
  const out: unknown[] = []
  for (const candidate of raw) {
    try {
      out.push(JSON.parse(candidate.trim()))
    } catch {
      /* not JSON — try the next candidate */
    }
  }
  return out
}

/** First candidate that is a plain (non-array) object, else null. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  for (const c of extractJsonCandidates(text)) {
    if (c && typeof c === 'object' && !Array.isArray(c)) return c as Record<string, unknown>
  }
  return null
}
