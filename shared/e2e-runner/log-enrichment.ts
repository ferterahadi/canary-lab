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

function readJournalTail(limit = 3): JournalEntry[] {
  try {
    const raw = fs.readFileSync(DIAGNOSIS_JOURNAL_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(-limit)
  } catch {
    return []
  }
}

function fileSizeOrZero(rel: string): number {
  try {
    return fs.statSync(path.join(ROOT, rel)).size
  } catch {
    return 0
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function truncateOneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// Read ±N lines of the spec file at `location` (format: "path:line"). Returns
// a compact code fence the agent can eyeball without a separate Read round-trip.
export function readSpecSnippet(
  location: string | undefined,
  linesAround = 8,
): { text: string; lang: string } | null {
  if (!location) return null
  const m = location.match(/^(.+):(\d+)(?::\d+)?$/)
  if (!m) return null
  const [, file, lineStr] = m
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  let raw: string
  try {
    raw = fs.readFileSync(abs, 'utf-8')
  } catch {
    return null
  }
  const lineNum = parseInt(lineStr, 10)
  const allLines = raw.split('\n')
  const start = Math.max(0, lineNum - 1 - linesAround)
  const end = Math.min(allLines.length, lineNum + linesAround)
  const widthOf = String(end).length
  const snippet = allLines
    .slice(start, end)
    .map((text, i) => {
      const n = start + i + 1
      const marker = n === lineNum ? '→' : ' '
      return `${marker} ${String(n).padStart(widthOf)}  ${text}`
    })
    .join('\n')
  const ext = path.extname(file).replace(/^\./, '')
  return { text: snippet, lang: ext || 'text' }
}

// Write a compact markdown entry point for the heal agent: error, slice
// paths, inline spec snippet, and a journal tail. Intentionally does NOT
// pre-compute grep "suspects" — subprocess-based greps across declared
// repo paths were too slow in practice (minutes added on large Java/Node
// trees). The agent does its own targeted grep from the error literals,
// which is fast once it has the spec snippet in front of it.
export function writeHealIndex(): void {
  const summaryPath = getSummaryPath()
  if (!fs.existsSync(summaryPath)) return
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as {
    total?: number
    passed?: number
    failed?: FailedEntry[]
  }

  const failed = Array.isArray(summary.failed) ? summary.failed : []

  const lines: string[] = []
  lines.push(`# Heal Index — ${new Date().toISOString()}`)
  lines.push('')
  lines.push(
    `${failed.length} test${failed.length === 1 ? '' : 's'} failed, ${summary.passed ?? 0} passed.`,
  )
  lines.push('')

  if (failed.length === 0) {
    lines.push('No failures. Nothing to heal.')
  } else {
    failed.forEach((entry, i) => {
      lines.push(`## failed[${i}] — ${entry.name}`)
      if (entry.error?.message) {
        lines.push(`- error: ${truncateOneLine(entry.error.message, 300)}`)
      }
      if (entry.logFiles && entry.logFiles.length > 0) {
        lines.push('- logs:')
        for (const rel of entry.logFiles) {
          lines.push(`  - ${rel}  (${formatBytes(fileSizeOrZero(rel))})`)
        }
      } else {
        lines.push('- logs: _none captured — grep `logs/svc-*.log` for the slug manually_')
      }

      // Inline spec snippet — ±8 lines around the assertion. Saves a full
      // Read of the spec file.
      const snippet = readSpecSnippet(entry.location)
      if (snippet) {
        lines.push(`- assertion (${entry.location}):`)
        lines.push('')
        lines.push('  ```' + snippet.lang)
        for (const ln of snippet.text.split('\n')) {
          lines.push(`  ${ln}`)
        }
        lines.push('  ```')
      } else if (entry.location) {
        lines.push(`- location: ${entry.location}`)
      }
      lines.push('')
    })
  }

  const journalTail = readJournalTail()
  if (journalTail.length > 0) {
    lines.push('## Journal (last 3 iterations)')
    lines.push(
      `See \`logs/diagnosis-journal.json\` for full history. Skip hypotheses already tried.`,
    )
    lines.push('')
    for (const entry of journalTail) {
      const iter = entry.iteration !== undefined ? `#${entry.iteration}` : ''
      const outcome = entry.outcome === null || entry.outcome === undefined ? 'pending' : entry.outcome
      const hyp = entry.hypothesis ? truncateOneLine(entry.hypothesis, 200) : '(no hypothesis)'
      lines.push(`- ${iter} ${hyp} → **${outcome}**`)
      if (entry.fix?.description) {
        lines.push(`  - fix: ${truncateOneLine(entry.fix.description, 160)}${entry.fix.file ? ` (\`${entry.fix.file}\`)` : ''}`)
      }
    }
    lines.push('')
  }

  fs.mkdirSync(LOGS_DIR, { recursive: true })
  const tmp = `${HEAL_INDEX_PATH}.tmp`
  fs.writeFileSync(tmp, lines.join('\n'))
  fs.renameSync(tmp, HEAL_INDEX_PATH)
}
