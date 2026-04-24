import fs from 'fs'
import path from 'path'
import {
  DIAGNOSIS_JOURNAL_PATH,
  FAILED_DIR,
  HEAL_INDEX_PATH,
  LOGS_DIR,
  MANIFEST_PATH,
  ROOT,
  getSummaryPath,
} from './paths'

// Cap each per-test slice at head + tail to keep per-failure files readable in
// a single Read tool call. Errors are almost always near the end of the window,
// so tail matters as much as head.
export const SLICE_HALF_BYTES = 10_240
const ELISION_MARKER = '\n… [eliding {n} bytes from middle — full log at {path}] …\n'

export function capSlice(
  snippet: string,
  fullLogRelPath: string,
): string {
  const bytes = Buffer.byteLength(snippet, 'utf-8')
  if (bytes <= SLICE_HALF_BYTES * 2) return snippet
  const head = snippet.slice(0, SLICE_HALF_BYTES)
  const tail = snippet.slice(-SLICE_HALF_BYTES)
  const elided = bytes - Buffer.byteLength(head, 'utf-8') - Buffer.byteLength(tail, 'utf-8')
  const marker = ELISION_MARKER
    .replace('{n}', String(elided))
    .replace('{path}', fullLogRelPath)
  return head + marker + tail
}

export function extractLogsForTest(
  slug: string,
  serviceLogs: string[],
): Record<string, string> {
  const logs: Record<string, string> = {}
  const openTag = `<${slug}>`
  const closeTag = `</${slug}>`

  for (const logPath of serviceLogs) {
    if (!fs.existsSync(logPath)) continue
    const content = fs.readFileSync(logPath, 'utf-8')
    const openIdx = content.indexOf(openTag)
    const closeIdx = content.indexOf(closeTag)
    if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) continue
    const snippet = content
      .slice(openIdx + openTag.length, closeIdx)
      .trim()
    if (snippet.length === 0) continue
    const svcName = path.basename(logPath, '.log')
    const relFullPath = path.relative(ROOT, logPath)
    logs[svcName] = capSlice(snippet, relFullPath)
  }
  return logs
}

// Write per-failure slice files under logs/failed/<slug>/<svc>.log and return
// the list of relative paths + byte counts so callers can reference them from
// the summary and the index.
export interface PerFailureSlices {
  logFiles: string[]        // repo-relative paths, e.g. "logs/failed/foo/svc-api.log"
  bytesByPath: Record<string, number>
}

export function writeFailureSlices(
  slug: string,
  serviceLogs: string[],
): PerFailureSlices {
  const slices = extractLogsForTest(slug, serviceLogs)
  const dir = path.join(FAILED_DIR, slug)
  const logFiles: string[] = []
  const bytesByPath: Record<string, number> = {}

  if (Object.keys(slices).length === 0) {
    return { logFiles, bytesByPath }
  }

  fs.mkdirSync(dir, { recursive: true })
  for (const [svc, body] of Object.entries(slices)) {
    const filePath = path.join(dir, `${svc}.log`)
    fs.writeFileSync(filePath, body)
    const rel = path.relative(ROOT, filePath)
    logFiles.push(rel)
    bytesByPath[rel] = Buffer.byteLength(body, 'utf-8')
  }
  return { logFiles, bytesByPath }
}

interface FailedEntry {
  name: string
  logFiles?: string[]
  error?: { message?: string; snippet?: string }
  location?: string
  durationMs?: number
  retry?: number
  [key: string]: unknown
}

// Rewrite e2e-summary.json so each failed[] entry carries logFiles (paths)
// instead of logs (full embedded snippets). Keeps the summary small enough to
// Read in one call — previously it ballooned past Claude's 256KB Read cap.
export function enrichSummaryWithLogs(): void {
  const summaryPath = getSummaryPath()
  if (!fs.existsSync(summaryPath) || !fs.existsSync(MANIFEST_PATH)) return

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
  const manifest: { serviceLogs: string[] } = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, 'utf-8'),
  )

  if (!Array.isArray(summary.failed) || summary.failed.length === 0) return

  summary.failed = summary.failed.map(
    (entry: string | FailedEntry): FailedEntry => {
      const base: FailedEntry = typeof entry === 'string' ? { name: entry } : { ...entry }
      const { logFiles } = writeFailureSlices(base.name, manifest.serviceLogs)
      // Never carry embedded `logs` forward — the per-failure files replace it.
      delete (base as { logs?: unknown }).logs
      if (logFiles.length > 0) {
        base.logFiles = logFiles
      }
      return base
    },
  )

  const tmpPath = `${summaryPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
  fs.renameSync(tmpPath, summaryPath)
}

// ─── Heal Index ─────────────────────────────────────────────────────────────

interface JournalEntry {
  iteration?: number
  timestamp?: string
  hypothesis?: string
  outcome?: string | null
  fix?: { description?: string; file?: string }
  signal?: string
}

// Parse the Markdown journal format:
//
//   ## Iteration 1 — 2026-04-22T01:20:11Z
//
//   - feature: mpass_oauth
//   - hypothesis: refresh_token missing from metadata
//   - fix.file: /path/to/a.java
//   - fix.description: Added field.
//   - signal: .restart
//   - outcome: no_change
//
// Markdown is what both Claude and Codex read most fluidly — much better than
// the old JSON array for the agent's read-and-append workflow.
export function parseJournalMarkdown(raw: string): JournalEntry[] {
  const headingRe = /^##\s+Iteration\s+(\d+)\s+[—-]\s+(.+?)\s*$/
  const fieldRe = /^\s*-\s+([\w.-]+):\s*(.*)$/

  const lines = raw.split('\n')
  const entries: JournalEntry[] = []
  let current: JournalEntry | null = null

  for (const line of lines) {
    const heading = headingRe.exec(line)
    if (heading) {
      if (current) entries.push(current)
      current = {
        iteration: parseInt(heading[1], 10),
        timestamp: heading[2].trim(),
      }
      continue
    }
    if (!current) continue
    const field = fieldRe.exec(line)
    if (!field) continue
    const key = field[1]
    const value = field[2].trim()
    if (key === 'hypothesis') current.hypothesis = value
    else if (key === 'outcome') {
      current.outcome = value === 'pending' || value === 'null' || value === '' ? null : value
    }
    else if (key === 'signal') current.signal = value
    else if (key === 'fix.file') current.fix = { ...(current.fix ?? {}), file: value }
    else if (key === 'fix.description') current.fix = { ...(current.fix ?? {}), description: value }
  }
  if (current) entries.push(current)
  return entries
}

function readJournalTail(limit = 3): JournalEntry[] {
  try {
    const raw = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    return parseJournalMarkdown(raw).slice(-limit)
  } catch {
    return []
  }
}

function truncateOneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

interface Manifest {
  serviceLogs?: string[]
  featureName?: string
  featureDir?: string
  repoPaths?: string[]
}

function readManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest
  } catch {
    return {}
  }
}

// Strip ANSI color escape sequences from a string. Playwright emits them in
// error messages, and some reporters also emit the bracketed form without
// the escape prefix (`[2m`, `[22m`). Both forms are noise in a markdown file
// consumed by an agent.
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\[\d+(?:;\d+)*m/g, '')
}

function normalizeErrorKey(raw: string): string {
  const cleaned = stripAnsi(raw).replace(/\s+/g, ' ').trim()
  return cleaned || '(no error)'
}

// Write a compact map (not a script) for the heal agent: where the feature
// lives, which repos to edit, what failed, and the exact slice files to read.
// Keep this literal; inferred target-service hints can mislead when a shared
// frontend/proxy appears in every slice but the real bug lives downstream.
export function writeHealIndex(): void {
  const summaryPath = getSummaryPath()
  if (!fs.existsSync(summaryPath)) return
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as {
    total?: number
    passed?: number
    failed?: FailedEntry[]
  }

  const failed = Array.isArray(summary.failed) ? summary.failed : []
  const manifest = readManifest()
  const lines: string[] = []

  lines.push('# Heal Index')
  lines.push('')
  if (manifest.featureDir) {
    lines.push(`Feature: ${path.relative(ROOT, manifest.featureDir) || manifest.featureDir}`)
  } else if (manifest.featureName) {
    lines.push(`Feature: ${manifest.featureName}`)
  }
  if (manifest.repoPaths && manifest.repoPaths.length > 0) {
    lines.push(`Repos:   ${manifest.repoPaths.join(', ')}`)
  }
  lines.push('')

  if (failed.length === 0) {
    lines.push('No failures. Nothing to heal.')
  } else {
    lines.push('## Failures')
    lines.push('')
    for (const entry of failed) {
      lines.push(`- **${entry.name}**`)
      if (entry.error?.message) {
        const errorMessage = normalizeErrorKey(entry.error.message)
        lines.push(`  - error: ${truncateOneLine(errorMessage, 400)}`)
      }
      if (entry.logFiles && entry.logFiles.length > 0) {
        lines.push(`  - slice: ${entry.logFiles.join(', ')}`)
      }
    }
    lines.push('')
  }

  const journalTail = readJournalTail()
  if (journalTail.length > 0) {
    const parts = journalTail.map((e) => {
      const iter = e.iteration !== undefined ? `#${e.iteration}` : ''
      const outcome = e.outcome === null || e.outcome === undefined ? 'pending' : e.outcome
      const hyp = e.hypothesis ? truncateOneLine(e.hypothesis, 100) : '(no hypothesis)'
      return `${iter} ${hyp} → ${outcome}`.trim()
    })
    lines.push(`Journal: ${parts.join('; ')}.  Full history: \`logs/diagnosis-journal.md\`.`)
    lines.push('')
  }

  fs.mkdirSync(LOGS_DIR, { recursive: true })
  const tmp = `${HEAL_INDEX_PATH}.tmp`
  fs.writeFileSync(tmp, lines.join('\n'))
  fs.renameSync(tmp, HEAL_INDEX_PATH)
}

// ─── Journal append (runner-side) ───────────────────────────────────────────
//
// The runner pre-seeds the iteration heading and the fields it already knows
// (feature, failingTests, timestamp, signal, fix.file, outcome: pending) so
// the agent doesn't have to spend tokens writing ceremony boilerplate. The
// agent only supplies `hypothesis` (and optionally `fix.description`) in the
// signal-body JSON it wrote to `.restart` / `.rerun`.

export interface JournalAppendInput {
  signal: '.restart' | '.rerun'
  hypothesis?: string
  filesChanged?: string[]
  fixDescription?: string
}

function nextIterationNumber(): number {
  try {
    const raw = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    const entries = parseJournalMarkdown(raw)
    const max = entries.reduce(
      (m, e) => (typeof e.iteration === 'number' && e.iteration > m ? e.iteration : m),
      0,
    )
    return max + 1
  } catch {
    return 1
  }
}

export function appendJournalIteration(input: JournalAppendInput): void {
  const hypothesis = input.hypothesis?.trim()
  if (!hypothesis) return // Nothing meaningful to record — skip.

  const manifest = readManifest()
  const summaryPath = getSummaryPath()
  let failingTests = ''
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as {
      failed?: FailedEntry[]
    }
    const failed = Array.isArray(summary.failed) ? summary.failed : []
    failingTests = failed
      .map((f) => f.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .join(', ')
  } catch {
    /* no summary — leave failingTests empty */
  }

  const fixFile = Array.isArray(input.filesChanged)
    ? input.filesChanged.filter((f) => typeof f === 'string').join(', ')
    : ''

  const section: string[] = []
  section.push(`## Iteration ${nextIterationNumber()} — ${new Date().toISOString()}`)
  section.push('')
  if (manifest.featureName) section.push(`- feature: ${manifest.featureName}`)
  if (failingTests) section.push(`- failingTests: ${failingTests}`)
  section.push(`- hypothesis: ${truncateOneLine(hypothesis, 400)}`)
  if (fixFile) section.push(`- fix.file: ${fixFile}`)
  if (input.fixDescription) {
    section.push(`- fix.description: ${truncateOneLine(input.fixDescription, 400)}`)
  }
  section.push(`- signal: ${input.signal}`)
  section.push('- outcome: pending')
  section.push('')

  fs.mkdirSync(LOGS_DIR, { recursive: true })
  const header = fs.existsSync(DIAGNOSIS_JOURNAL_PATH)
    ? ''
    : '# Diagnosis Journal\n\n'
  fs.appendFileSync(DIAGNOSIS_JOURNAL_PATH, header + section.join('\n'))
}
