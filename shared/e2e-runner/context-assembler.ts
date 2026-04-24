import fs from 'fs'
import path from 'path'
import {
  DIAGNOSIS_JOURNAL_PATH,
  HEAL_INDEX_PATH,
  MANIFEST_PATH,
  PLAYWRIGHT_STDOUT_PATH,
  ROOT,
  SUMMARY_PATH,
} from './paths'

export type BenchmarkMode = 'canary' | 'baseline'

export interface BenchmarkContextSnapshot {
  runId: string
  cycle: number
  mode: BenchmarkMode
  summaryPath: string
  journalPath: string | null
  includedLogFiles: string[]
  includedFailedTests: string[]
  summaryBytes: number
  journalBytes: number
  includedLogSlices: Record<string, number>
  excludedArtifacts: string[]
  filesIncluded: number
  contextBytes: number
  contextChars: number
  slicedLogBytes: number
  rawServiceLogBytesAvailable: number
  notes: string
  promptAddendum: string
}

interface SummaryFailureEntry {
  name?: string
  logs?: Record<string, string>
  error?: unknown
  durationMs?: unknown
  location?: unknown
  retry?: unknown
}

interface SummaryShape {
  total?: number
  passed?: number
  failed?: SummaryFailureEntry[]
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function byteLength(text: string | null): number {
  return text ? Buffer.byteLength(text, 'utf-8') : 0
}

function parseSummary(raw: string | null): SummaryShape | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as SummaryShape
  } catch {
    return null
  }
}

function failedTests(summary: SummaryShape | null): string[] {
  if (!summary?.failed) return []
  return summary.failed
    .map((entry) => (typeof entry?.name === 'string' ? entry.name : ''))
    .filter((name) => name.length > 0)
}

function sumRawServiceLogBytes(): number {
  const manifestRaw = safeRead(MANIFEST_PATH)
  if (!manifestRaw) return 0

  try {
    const manifest = JSON.parse(manifestRaw) as { serviceLogs?: string[] }
    if (!Array.isArray(manifest.serviceLogs)) return 0
    return manifest.serviceLogs.reduce((total, logPath) => {
      try {
        return total + fs.statSync(logPath).size
      } catch {
        return total
      }
    }, 0)
  } catch {
    return 0
  }
}

function statSizeOrZero(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

export function buildBenchmarkContextSnapshot(
  runId: string,
  cycle: number,
  mode: BenchmarkMode,
): BenchmarkContextSnapshot {
  if (mode === 'baseline') {
    // Baseline hands the agent exactly what a developer would see after
    // `npx playwright test` fails: the raw stdout log. No canary-lab-shaped
    // summary, no journal, no service-log slices. The agent's prompt (set in
    // auto-heal.ts) is what points it at this file, so we leave promptAddendum
    // empty — all guidance lives in the inline baseline prompt.
    const summaryPath = PLAYWRIGHT_STDOUT_PATH
    const summaryBytes = statSizeOrZero(PLAYWRIGHT_STDOUT_PATH)
    return {
      runId,
      cycle,
      mode,
      summaryPath,
      journalPath: null,
      includedLogFiles: [],
      includedFailedTests: [],
      summaryBytes,
      journalBytes: 0,
      includedLogSlices: {},
      excludedArtifacts: [
        'logs/e2e-summary.json',
        'logs/diagnosis-journal.md',
        'logs/svc-*.log',
        'failed[].logs',
        'CLAUDE.md heal-prompt section',
      ],
      filesIncluded: summaryBytes > 0 ? 1 : 0,
      contextBytes: summaryBytes,
      contextChars: summaryBytes,
      slicedLogBytes: 0,
      rawServiceLogBytesAvailable: 0,
      notes: 'Baseline benchmark context: raw Playwright stdout only; no skill, no canary-lab enrichment',
      promptAddendum: '',
    }
  }

  // Canary's entry point is now logs/heal-index.md — a compact markdown that
  // references per-failure slice files under logs/failed/<slug>/. The bloated
  // e2e-summary.json-first path is dead; that file ballooned past Claude's
  // 256KB Read cap on real runs and forced the agent to hack around with
  // `node -e JSON.stringify(...)`.
  const indexRaw = safeRead(HEAL_INDEX_PATH)
  const journalRaw = safeRead(DIAGNOSIS_JOURNAL_PATH)
  const summary = parseSummary(safeRead(SUMMARY_PATH))

  const failed = Array.isArray(summary?.failed) ? summary.failed : []
  const includedLogFiles: string[] = []
  const includedLogSlices: Record<string, number> = {}
  for (const entry of failed) {
    const logFiles = Array.isArray((entry as { logFiles?: unknown }).logFiles)
      ? ((entry as { logFiles: unknown[] }).logFiles.filter((x) => typeof x === 'string') as string[])
      : []
    for (const rel of logFiles) {
      if (!includedLogFiles.includes(rel)) includedLogFiles.push(rel)
      try {
        const size = fs.statSync(path.join(ROOT, rel)).size
        const svcName = path.basename(rel, '.log')
        includedLogSlices[svcName] = (includedLogSlices[svcName] ?? 0) + size
      } catch {
        /* slice file missing — leave it out of the byte count */
      }
    }
  }

  let journalPath: string | null = null
  let journalBytes = 0
  if (journalRaw) {
    journalPath = DIAGNOSIS_JOURNAL_PATH
    journalBytes = byteLength(journalRaw)
  }

  const indexBytes = byteLength(indexRaw)
  const slicedLogBytes = Object.values(includedLogSlices).reduce((sum, value) => sum + value, 0)
  // indexBytes already references these; we count both so consumers comparing
  // modes see the agent's realistic read budget (index + the slice files it's
  // likely to drill into).
  const contextBytes = indexBytes + slicedLogBytes
  const contextChars = (indexRaw?.length ?? 0) + slicedLogBytes

  // Supplemental reminder (not an override — the CLAUDE.md heal-prompt section
  // is the source of truth). Only fires during benchmark runs so we can measure
  // canary's information advantage cleanly; non-benchmark runs get the same
  // behavior from the heal-prompt block.
  const promptAddendum = [
    'Benchmark telemetry is on — same canary flow as usual, just reinforcing the entry points:',
    `- Start with \`${path.relative(ROOT, HEAL_INDEX_PATH)}\` (compact markdown index of every failure, slice paths, and prior hypotheses).`,
    '- For each failure you plan to fix, read its `logs/failed/<slug>/<svc>.log` slice (pre-capped, pre-scoped via XML markers).',
    '- If a slice is elided in the middle, the full log is at `logs/svc-<name>.log` — drill in with `sed -n \'/<slug>/,/<\\/slug>/p\' logs/svc-<name>.log`.',
    '- `logs/diagnosis-journal.md` has full history; the index summarizes the last 3 iterations — skip hypotheses already tried.',
  ].join('\n')

  return {
    runId,
    cycle,
    mode,
    summaryPath: HEAL_INDEX_PATH,
    journalPath,
    includedLogFiles,
    includedFailedTests: failedTests(summary),
    summaryBytes: indexBytes,
    journalBytes,
    includedLogSlices,
    excludedArtifacts: [],
    filesIncluded: (indexRaw ? 1 : 0) + includedLogFiles.length + (journalPath ? 1 : 0),
    contextBytes,
    contextChars,
    slicedLogBytes,
    rawServiceLogBytesAvailable: sumRawServiceLogBytes(),
    notes: 'Canary benchmark context: heal-index.md entry point + per-failure slice files (capped, pre-scoped)',
    promptAddendum,
  }
}
