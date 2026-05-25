import fs from 'fs'
import path from 'path'
import type { RunDetail } from './run-store'
import { buildHealPromptMap, type HealPromptMap } from './runtime/auto-heal'
import { loadProjectConfig } from './runtime/launcher/project-config'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import type { HealSignalKind } from '../../../shared/run-state'

export interface ExternalHealFailedTest {
  name: string
  error?: unknown
  location?: string
  retry?: number
  artifacts: Array<{ name: string; kind: string; url: string }>
}

export interface NormalizedRunCounts {
  totalKnown: number
  passed: number
  failed: number
  skipped: number
  notRun: number
  passedNames: string[]
  passedIds: string[]
  failedNames: string[]
  failedIds: string[]
  skippedNames: string[]
  skippedIds: string[]
  notRunNames: string[]
  statusLine: string
}

export interface ExternalHealContext {
  runId: string
  feature: string
  env: string | null
  status: string
  healCycles: number
  repoBranches: RunDetail['manifest']['repoBranches']
  lifecycle: RunDetail['manifest']['lifecycle'] | null
  externalHealSession: RunDetail['manifest']['externalHealSession'] | null
  summary: RunDetail['summary'] | null
  counts: NormalizedRunCounts
  failedTests: ExternalHealFailedTest[]
  healIndexMarkdown: string | null
  journalMarkdown: string | null
  artifactsBase: string
  healPrompt?: HealPromptMap
}

export interface BuildExternalHealContextInput {
  detail: RunDetail
  logsDir: string
  projectRoot?: string
}

export function buildExternalHealContext(input: BuildExternalHealContextInput): ExternalHealContext {
  const { detail, logsDir, projectRoot } = input
  const runId = detail.manifest.runId
  const runDir = runDirFor(logsDir, runId)
  const paths = buildRunPaths(runDir)
  const summary = detail.summary
  const failedTests = (summary?.failed ?? []).map((entry) => ({
    name: entry.name,
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.location ? { location: entry.location } : {}),
    ...(typeof entry.retry === 'number' ? { retry: entry.retry } : {}),
    artifacts:
      detail.playwrightArtifacts
        ?.find((group) => group.testName === entry.name)
        ?.artifacts.map((artifact) => ({
          name: artifact.name,
          kind: artifact.kind,
          url: artifact.url,
        })) ?? [],
  }))
  const context: ExternalHealContext = {
    runId,
    feature: detail.manifest.feature,
    env: detail.manifest.env ?? null,
    status: detail.manifest.status,
    healCycles: detail.manifest.healCycles,
    repoBranches: detail.manifest.repoBranches ?? [],
    lifecycle: detail.manifest.lifecycle ?? null,
    externalHealSession: detail.manifest.externalHealSession ?? null,
    summary: summary ?? null,
    counts: normalizeRunCounts(summary ?? null),
    failedTests,
    healIndexMarkdown: safeRead(paths.healIndexPath),
    journalMarkdown: safeRead(paths.diagnosisJournalPath),
    artifactsBase: `/api/runs/${encodeURIComponent(runId)}/artifacts/`,
  }
  if (projectRoot) {
    const projectConfig = loadProjectConfig(projectRoot)
    context.healPrompt = buildHealPromptMap({
      projectRoot,
      runDir,
      personalWikiPath: projectConfig.personalWikiPath,
    })
  }
  return context
}

export interface WriteHealSignalInput {
  logsDir: string
  runId: string
  kind: HealSignalKind
  body: Record<string, unknown>
}

export function writeHealSignal(input: WriteHealSignalInput): { kind: HealSignalKind; path: string } {
  const paths = buildRunPaths(runDirFor(input.logsDir, input.runId))
  const target = healSignalPath(paths, input.kind)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(input.body))
  return { kind: input.kind, path: target }
}

function healSignalPath(paths: ReturnType<typeof buildRunPaths>, kind: HealSignalKind): string {
  if (kind === 'restart') return paths.restartSignal
  if (kind === 'rerun') return paths.rerunSignal
  return paths.healSignal
}

export function normalizeRunCounts(summary: RunDetail['summary'] | null): NormalizedRunCounts {
  const summaryWithKnownTests = summary as (RunDetail['summary'] & { knownTests?: unknown }) | null
  const knownTests = Array.isArray(summaryWithKnownTests?.knownTests)
    ? summaryWithKnownTests.knownTests
    : []
  const knownEntries = knownTests.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as { id?: unknown; name?: unknown }
    const name = typeof value.name === 'string' ? value.name : ''
    if (!name) return []
    return [{
      id: typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined,
      name,
    }]
  })
  const passedNames = uniqueStrings(summary?.passedNames ?? [])
  const passedIds = uniqueStrings(((summary as { passedIds?: unknown[] } | null)?.passedIds) ?? [])
  const failedNames = uniqueStrings((summary?.failed ?? []).map((entry) => entry.name))
  const failedIds = uniqueStrings((summary?.failed ?? []).map((entry) => (entry as { id?: unknown }).id))
  const skippedNames = uniqueStrings(summary?.skippedNames ?? [])
  const skippedIds = uniqueStrings(((summary as { skippedIds?: unknown[] } | null)?.skippedIds) ?? [])
  const hasResultIds = passedIds.length > 0 || failedIds.length > 0 || skippedIds.length > 0
  const accountedIds = new Set([...passedIds, ...failedIds, ...skippedIds])
  const accountedNames = new Set([...passedNames, ...failedNames, ...skippedNames])
  const notRunNames = knownEntries
    .filter((entry) => {
      if (hasResultIds && entry.id) return !accountedIds.has(entry.id)
      return !accountedNames.has(entry.name)
    })
    .map((entry) => entry.name)
  const totalKnown = knownEntries.length > 0 ? knownEntries.length : numberOrZero(summary?.total)
  const passed = typeof summary?.passed === 'number' ? summary.passed : passedNames.length
  const failed = failedNames.length
  const skipped = typeof summary?.skipped === 'number' ? summary.skipped : skippedNames.length
  const notRun = knownEntries.length > 0
    ? notRunNames.length
    : Math.max(0, totalKnown - passed - failed - skipped)

  return {
    totalKnown,
    passed,
    failed,
    skipped,
    notRun,
    passedNames,
    passedIds,
    failedNames,
    failedIds,
    skippedNames,
    skippedIds,
    notRunNames,
    statusLine: statusLineForCounts({ totalKnown, passed, failed, skipped, notRun }),
  }
}

function statusLineForCounts(counts: Pick<NormalizedRunCounts, 'totalKnown' | 'passed' | 'failed' | 'skipped' | 'notRun'>): string {
  const parts = [`${counts.passed}/${counts.totalKnown} passed`, `${counts.failed} failed`]
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  parts.push(`${counts.notRun} not run`)
  return parts.join(', ')
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}
