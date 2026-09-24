import type { RequirementSource } from '../../../../../../../shared/coverage/types'
import type { DocEntry } from './docs-collection'

// Requirement provenance (D11). Locates a requirement's wording in the source
// docs the summary was built from: the doc, the nearest heading above the
// best-matching line, and that line. Deterministic token overlap — canary owns
// the answer, the agent may only HINT (a doc it says it read, a heading it says
// it read under), and a hint is honoured only when it names something real in
// the collection. A hint that names nothing real is dropped, not repaired.

export interface RequirementSourceHint {
  doc?: string
  heading?: string
}

// Words too common to carry meaning between a requirement and its source line.
const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'are', 'was', 'were', 'will', 'must',
  'should', 'can', 'not', 'when', 'then', 'than', 'from', 'into', 'its', 'has', 'have',
  'been', 'each', 'any', 'all', 'one', 'per', 'via', 'also', 'only', 'even',
])

function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word)
  }
  return out
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/

interface Located {
  score: number
  heading?: string
  line: number
}

/** Best-overlap line in one doc, with the heading in force at that line. */
function locateInDoc(needle: Set<string>, content: string): Located | undefined {
  let heading: string | undefined
  let best: Located | undefined
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const h = HEADING.exec(lines[i])
    if (h) {
      heading = h[1]
      continue
    }
    let score = 0
    for (const word of tokens(lines[i])) if (needle.has(word)) score += 1
    if (score > 0 && (!best || score > best.score)) {
      best = { score, line: i + 1, ...(heading !== undefined ? { heading } : {}) }
    }
  }
  return best
}

/** Line of the first heading whose text matches the hint (case-insensitive). */
function findHeading(content: string, hint: string): { heading: string; line: number } | undefined {
  const wanted = hint.trim().toLowerCase()
  if (!wanted) return undefined
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const h = HEADING.exec(lines[i])
    if (h && h[1].toLowerCase() === wanted) return { heading: h[1], line: i + 1 }
  }
  return undefined
}

export function locateRequirementSource(
  requirement: { title: string; text: string },
  docs: DocEntry[],
  hint?: RequirementSourceHint,
): RequirementSource | undefined {
  const hinted = hint?.doc ? docs.find((d) => d.relPath === hint.doc) : undefined
  const candidates = hinted ? [hinted] : docs
  const needle = tokens(`${requirement.title} ${requirement.text}`)

  let bestDoc: DocEntry | undefined
  let best: Located | undefined
  for (const doc of candidates) {
    const located = locateInDoc(needle, doc.content)
    if (located && (!best || located.score > best.score)) {
      best = located
      bestDoc = doc
    }
  }

  // A heading hint pins the section when the doc is known (hinted, or located)
  // and the heading really is in it — the located line is then the heading's own.
  const doc = bestDoc ?? hinted
  if (doc && hint?.heading) {
    const heading = findHeading(doc.content, hint.heading)
    if (heading) return { doc: doc.relPath, heading: heading.heading, line: heading.line }
  }
  // A real doc hint with no overlapping line: the doc is still the agent's
  // validated claim; the line is honestly unknown, so it is omitted.
  if (!bestDoc || !best) return hinted ? { doc: hinted.relPath } : undefined
  return {
    doc: bestDoc.relPath,
    ...(best.heading !== undefined ? { heading: best.heading } : {}),
    line: best.line,
  }
}
