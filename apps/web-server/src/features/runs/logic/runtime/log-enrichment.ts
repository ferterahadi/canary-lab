import fs from 'fs'
import path from 'path'
import { MANIFEST_PATH, ROOT, getSummaryPath } from './paths'
import { compressLogByTemplate } from './log-template'
import { writeHealIndex } from './heal-index'

export { writeHealIndex } from './heal-index'
export { MAX_JOURNAL_DIFF_BYTES, appendJournalIteration, classifyJournalOutcome, countConsecutiveSameFailures, nextIterationNumber, parseJournalMarkdown, readJournalTail, stuckSlugsFromJournal, truncateDiffForJournal, updateLatestPendingJournalOutcome, writeFullDiffPatch } from './heal-journal'
export type { JournalAppendInput, JournalOutcome, JournalOutcomeUpdateInput, SummaryForJournalOutcome } from './heal-journal'

// Cap each per-test slice at head + tail to keep per-failure files readable in
// a single Read tool call. Errors are almost always near the end of the window,
// so tail matters as much as head.
export const SLICE_HALF_BYTES = 10_240

const ELISION_MARKER = '\n… [eliding {n} bytes from middle — full log at {path}] …\n'

// What capSlice did to a snippet, so callers can surface it up-front in the
// heal-index instead of relying on the agent reading the buried elision marker.
// `capped` is true ONLY for the lossy head+tail branch — template collapse is
// lossless (every distinct line survives), so it doesn't count as "capped".
export interface CapResult {
  text: string
  /** Lossy: the middle was dropped, so the on-disk slice is incomplete. */
  capped: boolean
  /** Byte size of the pre-cap window (the full per-test marker span). */
  windowBytes: number
}

export function capSliceWithMeta(
  snippet: string,
  fullLogRelPath: string,
): CapResult {
  const bytes = Buffer.byteLength(snippet, 'utf-8')
  // Small enough to read in one call → keep it byte-for-byte (lossless).
  if (bytes <= SLICE_HALF_BYTES * 2) return { text: snippet, capped: false, windowBytes: bytes }

  // Over budget. Collapse repeated noise by template FIRST — this keeps full
  // temporal coverage of the slice, which beats dropping the middle. If that
  // gets us under budget, we never truncate at all.
  const { text: compact, collapsedLines } = compressLogByTemplate(snippet)
  const compactBytes = Buffer.byteLength(compact, 'utf-8')
  if (compactBytes <= SLICE_HALF_BYTES * 2) {
    // Getting here means the collapse shrank an over-budget slice, and the only
    // way it can shrink one is by collapsing at least one line — otherwise it
    // reproduces every line and merely appends a count suffix, so `compact`
    // would be no smaller than the input we already know is over budget.
    const text = `${compact}\n… [${collapsedLines} repeated line(s) collapsed by template — full log at ${fullLogRelPath}] …`
    return { text, capped: false, windowBytes: bytes }
  }

  // Still too big even after collapsing → head+tail the compressed text. The
  // elision marker keeps pointing at the full, uncompressed log.
  const head = compact.slice(0, SLICE_HALF_BYTES)
  const tail = compact.slice(-SLICE_HALF_BYTES)
  const elided = compactBytes - Buffer.byteLength(head, 'utf-8') - Buffer.byteLength(tail, 'utf-8')
  const marker = ELISION_MARKER
    .replace('{n}', String(elided))
    .replace('{path}', fullLogRelPath)
  return { text: head + marker + tail, capped: true, windowBytes: bytes }
}

export function capSlice(
  snippet: string,
  fullLogRelPath: string,
): string {
  return capSliceWithMeta(snippet, fullLogRelPath).text
}

// A per-test slice plus the provenance the heal-index surfaces up-front: how
// big the source log is, where it lives, and whether the slice is lossy.
export interface SliceRecord {
  /** Capped slice text written to the per-failure file. */
  text: string
  /** Repo-relative path to the source `svc-*.log`. */
  fullLog: string
  /** Byte size of the source `svc-*.log` on disk. */
  fullLogBytes: number
  /** Byte size of the pre-cap per-test window. */
  windowBytes: number
  /** Lossy head+tail cap — the on-disk slice dropped its middle. */
  capped: boolean
}

// Read each service log once and extract per-test slices for every requested
// slug in a single pass. With N failures × M service logs, the naive approach
// reads each log N times; this collapses it to M reads per enrichment cycle.
// Returns the slice text plus provenance (source log path/size, cap state).
export function extractAllSliceRecords(
  slugs: readonly string[],
  serviceLogs: readonly string[],
): Map<string, Record<string, SliceRecord>> {
  const result = new Map<string, Record<string, SliceRecord>>()
  for (const slug of slugs) result.set(slug, {})
  if (slugs.length === 0) return result

  for (const logPath of serviceLogs) {
    if (!fs.existsSync(logPath)) continue
    // The raw svc-*.log keeps its PTY control codes for the xterm pane replay;
    // strip them here so the heal-agent slices are plain text.
    const raw = fs.readFileSync(logPath, 'utf-8')
    const content = stripAnsi(raw)
    const svcName = path.basename(logPath, '.log')
    const relFullPath = path.relative(ROOT, logPath)
    const fullLogBytes = Buffer.byteLength(raw, 'utf-8')
    for (const slug of slugs) {
      const openTag = `<${slug}>`
      const openIdx = content.indexOf(openTag)
      if (openIdx === -1) continue
      const closeIdx = content.indexOf(`</${slug}>`, openIdx + openTag.length)
      if (closeIdx === -1) continue
      const snippet = content.slice(openIdx + openTag.length, closeIdx).trim()
      if (snippet.length === 0) continue
      const { text, capped, windowBytes } = capSliceWithMeta(snippet, relFullPath)
      result.get(slug)![svcName] = { text, fullLog: relFullPath, fullLogBytes, windowBytes, capped }
    }
  }
  return result
}

export function extractAllSlices(
  slugs: readonly string[],
  serviceLogs: readonly string[],
): Map<string, Record<string, string>> {
  const records = extractAllSliceRecords(slugs, serviceLogs)
  const result = new Map<string, Record<string, string>>()
  for (const [slug, bySvc] of records) {
    const texts: Record<string, string> = {}
    for (const [svc, rec] of Object.entries(bySvc)) texts[svc] = rec.text
    result.set(slug, texts)
  }
  return result
}

export function extractLogsForTest(
  slug: string,
  serviceLogs: string[],
): Record<string, string> {
  // Always present: extractAllSliceRecords seeds an entry for every slug it is
  // given before it reads a single log.
  return extractAllSlices([slug], serviceLogs).get(slug)!
}

// Write per-failure slice files under <runDir>/failed/<slug>/<svc>.log and return
// the list of relative paths + byte counts so callers can reference them from
// the summary and the index.
export interface PerFailureSlices {
  logFiles: string[]        // repo-relative paths, e.g. "logs/runs/<run-id>/failed/foo/svc-api.log"
  bytesByPath: Record<string, number>
}

// Per-slice provenance the heal-index renders up-front so the agent doesn't
// have to read into the slice to learn it was capped (and where the full log
// is). One entry per written slice file.
export interface SliceMeta {
  path: string         // repo-relative path of the on-disk slice (matches a logFiles entry)
  bytes: number        // byte size of the on-disk (capped) slice
  fullLog: string      // repo-relative path to the source svc-*.log
  fullLogBytes: number // byte size of that full log on disk
  windowBytes: number  // byte size of the full per-test window before capping
  capped: boolean      // slice dropped its middle (lossy) → grep the full log for more
}

export function writeFailureSlices(
  slug: string,
  serviceLogs: string[],
  failedDir?: string,
): PerFailureSlices {
  return writeSlicesToDisk(slug, extractLogsForTest(slug, serviceLogs), failedDir)
}

// Write slices from rich records, returning both the paths (for the summary's
// logFiles) and the per-slice provenance (for the heal-index size/cap hints).
function writeSliceRecordsToDisk(
  slug: string,
  records: Record<string, SliceRecord>,
  failedDir: string = path.join(path.dirname(getSummaryPath()), 'failed'),
): { logFiles: string[]; sliceMeta: SliceMeta[] } {
  const dir = path.join(failedDir, slug)
  const logFiles: string[] = []
  const sliceMeta: SliceMeta[] = []
  const entries = Object.entries(records)
  if (entries.length === 0) return { logFiles, sliceMeta }

  fs.mkdirSync(dir, { recursive: true })
  for (const [svc, rec] of entries) {
    const filePath = path.join(dir, `${svc}.log`)
    fs.writeFileSync(filePath, rec.text)
    const rel = path.relative(ROOT, filePath)
    logFiles.push(rel)
    sliceMeta.push({
      path: rel,
      bytes: Buffer.byteLength(rec.text, 'utf-8'),
      fullLog: rec.fullLog,
      fullLogBytes: rec.fullLogBytes,
      windowBytes: rec.windowBytes,
      capped: rec.capped,
    })
  }
  return { logFiles, sliceMeta }
}

// Write the full (untruncated) failure error — assertion message plus the
// code-frame snippet — to `<failedDir>/<slug>/error.txt`. Returns the
// repo-relative path, or null when there's nothing to write / a write fails.
// The heal-index points the agent here so a large assertion diff is never lost
// to the one-line preview.
export function writeErrorFile(
  slug: string,
  error: { message?: string; snippet?: string } | undefined,
  failedDir: string = path.join(path.dirname(getSummaryPath()), 'failed'),
): string | null {
  const message = error?.message?.trim() ?? ''
  const snippet = error?.snippet?.trim() ?? ''
  if (!message && !snippet) return null
  const parts: string[] = []
  if (message) parts.push(message)
  if (snippet) parts.push('--- snippet ---', snippet)
  const body = parts.join('\n\n')
  try {
    const dir = path.join(failedDir, slug)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'error.txt')
    // `body` joins trimmed parts, so it never already ends in a newline.
    fs.writeFileSync(filePath, `${body}\n`)
    // filePath always ends in /error.txt, so it is never ROOT itself and
    // path.relative never returns the empty string here.
    return path.relative(ROOT, filePath)
  } catch {
    return null
  }
}

function writeSlicesToDisk(
  slug: string,
  slices: Record<string, string>,
  failedDir: string = path.join(path.dirname(getSummaryPath()), 'failed'),
): PerFailureSlices {
  const dir = path.join(failedDir, slug)
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

export interface FailedEntry {
  name: string
  logFiles?: string[]
  // Per-slice provenance (size + source-log path + cap state) used by the
  // heal-index to tell the agent up-front whether a slice is complete. Lives
  // in-memory on the enriched summary; not persisted to e2e-summary.json since
  // writeHealIndex always runs in the same tick as enrichSummaryWithLogs.
  sliceMeta?: SliceMeta[]
  // Repo-relative path to `trace-extract/failure-summary.md` produced from
  // the test's Playwright trace.zip. Populated by the trace-enrichment step
  // after the test run completes; surfaced in `heal-index.md` so the agent
  // reads the curated trace summary as its first stop for "what went wrong".
  traceSummaryFile?: string
  // Repo-relative path to `failed/<slug>/error-context.md` — Playwright's own
  // page-state-at-failure capture. Cheaper and earlier than the trace extract
  // (no subprocess, available in onTestEnd), so the heal-index lists it first.
  errorContextFile?: string
  // Repo-relative path to `failed/<slug>/network.har` — every request the test
  // made. Large and machine-shaped, so the heal-index points at it as a grep
  // target rather than something to read whole.
  harFile?: string
  error?: { message?: string; snippet?: string }
  // Repo-relative path to `failed/<slug>/error.txt` — the full, untruncated
  // assertion message + code-frame snippet. The heal-index shows a one-line
  // preview of `error.message`; this file is the complete source for the agent.
  errorFile?: string
  location?: string
  durationMs?: number
  retry?: number
  [key: string]: unknown
}

export interface EnrichedSummary {
  total?: number
  passed?: number
  failed?: FailedEntry[]
  complete?: boolean
}

interface ManifestService {
  logPath?: string
}

function summaryPathToRunDir(summaryPath: string): string {
  return path.dirname(summaryPath)
}

export function manifestPathForSummary(summaryPath: string): string {
  return path.join(summaryPathToRunDir(summaryPath), 'manifest.json')
}

function failedDirForSummary(summaryPath: string): string {
  return path.join(summaryPathToRunDir(summaryPath), 'failed')
}

export function healIndexPathForSummary(summaryPath: string): string {
  return path.join(summaryPathToRunDir(summaryPath), 'heal-index.md')
}

export function journalPathForSummary(summaryPath: string): string {
  return path.join(summaryPathToRunDir(summaryPath), 'diagnosis-journal.md')
}

function serviceLogsFromManifest(manifest: Manifest): string[] {
  const legacy = Array.isArray(manifest.serviceLogs) ? manifest.serviceLogs : []
  const current = Array.isArray(manifest.services)
    ? manifest.services
        .map((s) => s.logPath)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  return [...legacy, ...current]
}

// Rewrite e2e-summary.json so each failed[] entry carries logFiles (paths)
// instead of logs (full embedded snippets). Keeps the summary small enough to
// Read in one call — previously it ballooned past Claude's 256KB Read cap.
//
// Returns the parsed manifest + summary so a follow-up writeHealIndex() in the
// same tick can reuse them instead of re-reading + re-parsing the same files.
export function enrichSummaryWithLogs(): { manifest: Manifest; summary: EnrichedSummary; summaryPath: string; healIndexPath: string; journalPath: string } | null {
  const summaryPath = getSummaryPath()
  const manifestPath = manifestPathForSummary(summaryPath)
  if (!fs.existsSync(summaryPath) || !fs.existsSync(manifestPath)) return null

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as EnrichedSummary
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest

  if (!Array.isArray(summary.failed) || summary.failed.length === 0) {
    return {
      manifest,
      summary,
      summaryPath,
      healIndexPath: healIndexPathForSummary(summaryPath),
      journalPath: journalPathForSummary(summaryPath),
    }
  }

  const slugs = summary.failed
    .map((e) => (typeof e === 'string' ? e : e.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  const recordsBySlug = extractAllSliceRecords(slugs, serviceLogsFromManifest(manifest))
  const failedDir = failedDirForSummary(summaryPath)

  summary.failed = summary.failed.map(
    (entry: string | FailedEntry): FailedEntry => {
      const base: FailedEntry = typeof entry === 'string' ? { name: entry } : { ...entry }
      const records = recordsBySlug.get(base.name) ?? {}
      const { logFiles, sliceMeta } = writeSliceRecordsToDisk(base.name, records, failedDir)
      // Never carry embedded `logs` forward — the per-failure files replace it.
      delete (base as { logs?: unknown }).logs
      if (logFiles.length > 0) {
        base.logFiles = logFiles
      }
      if (sliceMeta.length > 0) {
        base.sliceMeta = sliceMeta
      }
      const errorFile = writeErrorFile(base.name, base.error, failedDir)
      if (errorFile) {
        base.errorFile = errorFile
      }
      return base
    },
  )

  const tmpPath = `${summaryPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
  fs.renameSync(tmpPath, summaryPath)
  return {
    manifest,
    summary,
    summaryPath,
    healIndexPath: healIndexPathForSummary(summaryPath),
    journalPath: journalPathForSummary(summaryPath),
  }
}

export function truncateOneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// Human-readable byte size for the heal-index, so the agent can judge at a
// glance whether a log fits in one Read or needs grepping.
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Render the slice bullet(s) for one failed entry. Prefers the rich sliceMeta
// (size + source-log path + cap state) so the agent knows up-front whether the
// slice is complete; falls back to the bare path list for callers/summaries
// without sliceMeta (e.g. a heal-index rebuilt from a persisted summary).
export function renderSliceLines(entry: FailedEntry): string[] {
  if (entry.sliceMeta && entry.sliceMeta.length > 0) {
    return entry.sliceMeta.map((m) =>
      m.capped
        ? `  - slice: ${m.path} (${fmtBytes(m.bytes)}, capped from a ${fmtBytes(m.windowBytes)} window) — middle elided; full service log ${m.fullLog} (${fmtBytes(m.fullLogBytes)}), grep \`<${entry.name}>\`…\`</${entry.name}>\` if head+tail isn't enough`
        : `  - slice: ${m.path} (${fmtBytes(m.bytes)})`,
    )
  }
  if (entry.logFiles && entry.logFiles.length > 0) {
    return [`  - slice: ${entry.logFiles.join(', ')}`]
  }
  return []
}

export interface Manifest {
  serviceLogs?: string[]
  services?: ManifestService[]
  featureName?: string
  feature?: string
  featureDir?: string
  repoPaths?: string[]
  stoppedEarly?: {
    reason: 'max-failures' | 'user-pause'
    failuresAtStop: number
    suiteTotal: number
  }
  healCycleHistory?: Array<{ cycle: number; restarted: string[]; kept: string[] }>
}

export function readManifest(file: string = MANIFEST_PATH): Manifest {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Manifest
  } catch {
    return {}
  }
}

// Matches terminal control sequences: CSI (colors `m`, cursor moves `H`,
// erases `J`/`K`, …), OSC (`ESC ] … BEL/ST`), charset designation (`ESC ( B`),
// and keypad-mode toggles (`ESC =`/`ESC >`). Services run under a PTY, so their
// captured output carries the full set, not just colors.
 
const TERM_ESCAPE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][A-Za-z0-9]|[=>])/g

// Strip ANSI/terminal control sequences from a string. Playwright emits color
// codes in error messages; PTY-captured service logs add cursor moves and
// erases. Some reporters also emit the bracket form without the escape prefix
// (`[2m`, `[22m`). All of it is noise in a markdown/log slice read by an agent.
export function stripAnsi(s: string): string {
  return s
    .replace(TERM_ESCAPE_RE, '')
    .replace(/\[\d+(?:;\d+)*m/g, '')
}
