import fs from 'fs'
import { parseJournalMarkdown } from './runtime/heal-journal'
import type { JournalSection } from '../../../../../../shared/run-detail'

const HEADING_RE = /^##\s+Iteration\s+(\d+)(?:\s+[—-]\s+(.+?))?\s*$/
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
        timestamp: heading[2]?.trim() ?? null,
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
    else if (key === 'failingTests') {
      const names = value.split(',').map((name) => name.trim()).filter(Boolean)
      if (names.length > 0) current.failingTests = names
    } else if (key === 'cycle' && /^\d+$/.test(value)) current.cycle = Number(value)
    else if (key === 'inputExecution' && /^\d+$/.test(value)) current.inputExecution = Number(value)
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
