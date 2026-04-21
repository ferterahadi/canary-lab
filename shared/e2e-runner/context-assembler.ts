import fs from 'fs'
import path from 'path'
import {
  BENCHMARK_DIR,
  DIAGNOSIS_JOURNAL_PATH,
  MANIFEST_PATH,
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

function buildBaselineSummary(summary: SummaryShape | null): string {
  const failed = Array.isArray(summary?.failed) ? summary.failed : []
  return JSON.stringify({
    total: summary?.total ?? failed.length,
    passed: summary?.passed ?? 0,
    failed: failed.map((entry) => ({
      name: entry?.name,
      error: entry?.error,
      durationMs: entry?.durationMs,
      location: entry?.location,
      retry: entry?.retry,
    })),
  }, null, 2) + '\n'
}

export function buildBenchmarkContextSnapshot(
  runId: string,
  cycle: number,
  mode: BenchmarkMode,
): BenchmarkContextSnapshot {
  const summaryRaw = safeRead(SUMMARY_PATH)
  const journalRaw = safeRead(DIAGNOSIS_JOURNAL_PATH)
  const summary = parseSummary(summaryRaw)
  const contextDir = path.join(BENCHMARK_DIR, 'context')
  const baselineSummaryPath = path.join(contextDir, `cycle-${cycle}-summary.json`)

  let summaryPath = SUMMARY_PATH
  let summaryForMetrics = summaryRaw ?? ''
  const includedLogFiles: string[] = []
  const includedLogSlices: Record<string, number> = {}
  let journalPath: string | null = null
  let journalBytes = 0
  let excludedArtifacts: string[] = []
  let notes = 'Structured summary only'

  if (mode === 'baseline') {
    fs.mkdirSync(contextDir, { recursive: true })
    const playwrightOnly = buildBaselineSummary(summary)
    fs.writeFileSync(baselineSummaryPath, playwrightOnly)
    summaryPath = baselineSummaryPath
    summaryForMetrics = playwrightOnly
    excludedArtifacts = ['logs/diagnosis-journal.json', 'logs/svc-*.log', 'failed[].logs']
    notes = 'Baseline benchmark context: Playwright failure context only; diagnosis journal and Canary-specific log enrichment excluded'
  } else {
    const failed = Array.isArray(summary?.failed) ? summary.failed : []
    for (const entry of failed) {
      if (!entry?.logs || typeof entry.logs !== 'object') continue
      for (const [svcName, snippet] of Object.entries(entry.logs)) {
        if (typeof snippet !== 'string') continue
        if (!includedLogFiles.includes(`logs/${svcName}.log`)) {
          includedLogFiles.push(`logs/${svcName}.log`)
        }
        includedLogSlices[svcName] = (includedLogSlices[svcName] ?? 0) + Buffer.byteLength(snippet, 'utf-8')
      }
    }
    if (journalRaw) {
      journalPath = DIAGNOSIS_JOURNAL_PATH
      journalBytes = byteLength(journalRaw)
    }
    notes = 'Canary benchmark context: enriched summary with per-test log slices plus diagnosis journal when present'
  }

  const summaryBytes = Buffer.byteLength(summaryForMetrics, 'utf-8')
  const slicedLogBytes = Object.values(includedLogSlices).reduce((sum, value) => sum + value, 0)
  const contextBytes = summaryBytes + journalBytes + slicedLogBytes
  const contextChars = summaryForMetrics.length + (journalRaw?.length ?? 0) + slicedLogBytes

  const promptAddendum = mode === 'baseline'
    ? [
        'Benchmark override: this is a baseline benchmark run.',
        `Use only ${path.relative(ROOT, summaryPath)} as your failure context.`,
        'Do not read logs/diagnosis-journal.json.',
        'Do not rely on failed[].logs or any per-test sliced service logs, even if they exist elsewhere.',
        'Treat this as Playwright failure context only and explore the codebase yourself from there.',
      ].join('\n')
    : [
        'Benchmark override: this is a canary benchmark run.',
        `Read ${path.relative(ROOT, summaryPath)} first.`,
        'If logs/diagnosis-journal.json exists, you may read it.',
        'Prefer the enriched failed[].logs slices already embedded in the summary before reading raw service logs.',
      ].join('\n')

  return {
    runId,
    cycle,
    mode,
    summaryPath,
    journalPath,
    includedLogFiles,
    includedFailedTests: failedTests(summary),
    summaryBytes,
    journalBytes,
    includedLogSlices,
    excludedArtifacts,
    filesIncluded: 1 + includedLogFiles.length + (journalPath ? 1 : 0),
    contextBytes,
    contextChars,
    slicedLogBytes,
    rawServiceLogBytesAvailable: sumRawServiceLogBytes(),
    notes,
    promptAddendum,
  }
}
