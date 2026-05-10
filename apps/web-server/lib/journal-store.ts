import fs from 'fs'
import path from 'path'
import { parseJournalMarkdown } from './runtime/log-enrichment'

// Pure-ish business logic for the journal viewer. The Fastify route layer
// owns the request shape; this module owns the markdown parsing, filtering,
// and atomic delete-by-iteration helper.

export interface JournalSection {
  iteration: number | null
  timestamp: string | null
  feature: string | null
  run: string | null
  outcome: string | null
  hypothesis: string | null
  body: string
}

const HEADING_RE = /^##\s+Iteration\s+(\d+)\s+[—-]\s+(.+?)\s*$/
const FIELD_RE = /^\s*-\s+([\w.-]+):\s*(.*)$/

export function splitJournalSections(raw: string): JournalSection[] {
  const lines = raw.split('\n')
  const sections: JournalSection[] = []
  let currentLines: string[] | null = null
  let current: JournalSection | null = null

  const flush = (): void => {
    if (current && currentLines) {
      while (currentLines.length > 0 && currentLines[currentLines.length - 1].trim() === '') {
        currentLines.pop()
      }
      current.body = currentLines.join('\n')
      sections.push(current)
    }
    current = null
    currentLines = null
  }

  for (const line of lines) {
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flush()
      current = {
        iteration: parseInt(heading[1], 10),
        timestamp: heading[2].trim(),
        feature: null,
        run: null,
        outcome: null,
        hypothesis: null,
        body: '',
      }
      currentLines = [line]
      continue
    }
    if (!current || !currentLines) continue
    currentLines.push(line)
    const f = FIELD_RE.exec(line)
    if (!f) continue
    const key = f[1]
    const value = f[2].trim()
    if (key === 'feature') current.feature = value
    else if (key === 'run') current.run = value
    else if (key === 'outcome') current.outcome = value
    else if (key === 'hypothesis') current.hypothesis = value
  }
  flush()
  return sections
}

export interface JournalFilter {
  feature?: string
  run?: string
}

export function filterSections(
  sections: readonly JournalSection[],
  filter: JournalFilter,
): JournalSection[] {
  return sections.filter((s) => {
    if (filter.feature && s.feature !== filter.feature) return false
    if (filter.run && s.run !== filter.run) return false
    return true
  })
}

// Newest first — sort by iteration number descending. Sections without an
// iteration number sink to the bottom (unlikely in practice).
export function newestFirst(sections: readonly JournalSection[]): JournalSection[] {
  return [...sections].sort((a, b) => {
    const ai = a.iteration ?? -Infinity
    const bi = b.iteration ?? -Infinity
    return bi - ai
  })
}

// Re-uses the canonical parser for the structured-fields view used by the
// route response. Wrapped here so the journal-store module is the one place
// the route handler talks to.
export function parseStructured(raw: string): ReturnType<typeof parseJournalMarkdown> {
  return parseJournalMarkdown(raw)
}

export interface ReadJournalResult {
  sections: JournalSection[]
}

export function readJournal(journalPath: string): ReadJournalResult {
  let raw = ''
  try {
    raw = fs.readFileSync(journalPath, 'utf-8')
  } catch {
    return { sections: [] }
  }
  return { sections: splitJournalSections(raw) }
}

// Remove the iteration N section atomically. Returns true if a section was
// removed. The body of the surviving file keeps any non-section preamble
// (e.g. the "# Diagnosis Journal" header) and the original spacing between
// remaining sections.
export function deleteIterationSection(journalPath: string, iteration: number): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(journalPath, 'utf-8')
  } catch {
    return false
  }
  const lines = raw.split('\n')
  const out: string[] = []
  let skipping = false
  let removed = false
  for (const line of lines) {
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const iter = parseInt(heading[1], 10)
      if (iter === iteration) {
        skipping = true
        removed = true
        continue
      }
      skipping = false
    }
    if (!skipping) out.push(line)
  }
  if (!removed) return false
  // Atomic rewrite via tmp + rename.
  const tmp = `${journalPath}.tmp`
  fs.mkdirSync(path.dirname(journalPath), { recursive: true })
  fs.writeFileSync(tmp, out.join('\n'))
  fs.renameSync(tmp, journalPath)
  return true
}
