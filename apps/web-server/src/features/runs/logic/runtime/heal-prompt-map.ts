import fs from 'fs'
import path from 'path'
import { type HealMode } from './heal-prompt-builder'
import { buildRunPaths } from './run-paths'
import { renderPersonalWikiMap } from '../../../../../../../shared/runtime/personal-wiki'
import { MODE_COPY, detectHealMode, featureDocsDir } from './auto-heal'

export interface HealPromptStartEntry {
  id: 'heal-index' | 'summary'
  field?: 'healIndexMarkdown' | 'summary'
  path: string
  purpose: string
}

export interface HealPromptResourceEntry {
  id:
    | 'failed-slices'
    | 'trace-extract'
    | 'playwright-mcp'
    | 'full-service-log'
    | 'journal'
    | 'feature-docs'
    | 'personal-wiki'
  field?: 'journalMarkdown'
  path: string
  useWhen: string
}

export interface HealPromptMap {
  source: 'canary-lab/heal-agent-map'
  mode: HealMode
  runDir: string
  runDirRel: string
  startHere: HealPromptStartEntry[]
  resources: HealPromptResourceEntry[]
  boundaries: {
    fixTarget: string
    signalPolicy: {
      serviceOrRuntimeChange: 'restart'
      testOrConfigOnlyChange: 'rerun'
      mechanism: 'call signal_run; do not write signal files directly'
    }
  }
}

export interface HealPromptMapOptions {
  projectRoot: string
  runDir: string
  personalWikiPath?: string | null
}

export function buildHealPromptMap(opts: HealPromptMapOptions): HealPromptMap {
  const paths = buildRunPaths(opts.runDir)
  const mode = detectHealMode(paths.manifestPath)
  const modeCopy = MODE_COPY[mode]
  const runDirRel = path.relative(opts.projectRoot, opts.runDir) || opts.runDir
  const startHere: HealPromptStartEntry[] = []
  const resources: HealPromptResourceEntry[] = []

  if (fileHasContent(paths.healIndexPath)) {
    startHere.push({
      id: 'heal-index',
      field: 'healIndexMarkdown',
      path: paths.healIndexPath,
      purpose: 'First source to inspect. Lists failed tests, assertion errors, editable repos, and exact per-failure slice paths.',
    })
  } else if (fs.existsSync(paths.summaryPath)) {
    startHere.push({
      id: 'summary',
      field: 'summary',
      path: paths.summaryPath,
      purpose: 'Raw Playwright summary. Use when heal-index.md is missing or incomplete.',
    })
  }

  if (hasAnyFailureLog(paths.failedDir)) {
    resources.push({
      id: 'failed-slices',
      path: `${paths.failedDir}/<slug>/<svc>.log`,
      useWhen: 'Use the exact per-failure slice paths referenced by heal-index.md.',
    })
  }
  if (hasAnyFailureWith(paths.failedDir, 'trace-extract/failure-summary.md')) {
    resources.push({
      id: 'trace-extract',
      path: `${paths.failedDir}/<slug>/trace-extract/failure-summary.md`,
      useWhen: 'Use for UI failures when the trace extract exists; it summarizes failing actions, snapshots, failed network, and console errors.',
    })
  }
  if (nonEmptyDir(path.join(opts.runDir, 'playwright-mcp'))) {
    resources.push({
      id: 'playwright-mcp',
      path: `${opts.runDir}/playwright-mcp/`,
      useWhen: 'Use when Playwright MCP artifacts exist and the trace summary plus service logs are not enough.',
    })
  } else if (hasAnyFailureWithNonEmptyDir(paths.failedDir, 'playwright-mcp')) {
    resources.push({
      id: 'playwright-mcp',
      path: `${paths.failedDir}/<slug>/playwright-mcp/`,
      useWhen: 'Use when Playwright MCP artifacts exist and the trace summary plus service logs are not enough.',
    })
  }
  if (hasAnyServiceLog(opts.runDir)) {
    resources.push({
      id: 'full-service-log',
      path: `${opts.runDir}/svc-<safeName>.log`,
      useWhen: 'Use only if a per-failure slice is missing or too short.',
    })
  }
  if (fileHasContent(paths.diagnosisJournalPath)) {
    resources.push({
      id: 'journal',
      field: 'journalMarkdown',
      path: paths.diagnosisJournalPath,
      useWhen: 'Use when prior iterations exist or the current cycle references earlier attempts.',
    })
  }
  const docsDir = featureDocsDir(paths.manifestPath)
  if (docsDir) {
    resources.push({
      id: 'feature-docs',
      path: docsDir,
      useWhen: 'Use when product requirements, acceptance criteria, or uploaded Add Test context may explain the failure.',
    })
  }
  const wikiMap = renderPersonalWikiMap(opts.personalWikiPath)
  const wikiPath = opts.personalWikiPath?.trim()
  if (wikiMap && wikiPath && directoryExists(wikiPath)) {
    resources.push({
      id: 'personal-wiki',
      path: wikiPath,
      useWhen: 'Use when the current failure seems related to prior work preserved in the personal wiki.',
    })
  }

  return {
    source: 'canary-lab/heal-agent-map',
    mode,
    runDir: opts.runDir,
    runDirRel,
    startHere,
    resources,
    boundaries: {
      fixTarget: `${modeCopy.healingDirective} ${modeCopy.testSpecRule}`,
      signalPolicy: {
        serviceOrRuntimeChange: 'restart',
        testOrConfigOnlyChange: 'rerun',
        mechanism: 'call signal_run; do not write signal files directly',
      },
    },
  }
}

// Optional per-failure artifact hints. Only emit a bullet when at least one
// failure dir actually contains the artifact, so the heal agent isn't told
// to look for files that don't exist. Returns the bullet line (no trailing
// newline) or an empty string. The template wraps the placeholder so an
// empty string collapses cleanly.
export function renderTraceExtractHint(failedDir: string): string {
  if (!hasAnyFailureWith(failedDir, 'trace-extract/failure-summary.md')) return ''
  return `- \`${failedDir}/<slug>/trace-extract/failure-summary.md\` — curated trace extract: failing action, page snapshot at failure, failed network, console errors. Read this FIRST for any UI failure; full drill-down files sit in the same directory. Do NOT invoke the \`playwright trace\` CLI — everything is already on disk.`
}

export function renderPlaywrightMcpHint(failedDir: string): string {
  // Current runs write to the run-level dir; runs recorded before the
  // per-failure→run-level change may have per-slug dirs instead. Hint at
  // whichever actually has content.
  const runLevelDir = path.join(path.dirname(failedDir), 'playwright-mcp')
  if (nonEmptyDir(runLevelDir)) {
    return `- \`${runLevelDir}/\` — browser captures (console / DOM snapshots / network) recorded by your own earlier Playwright MCP calls in this run. Inspect when the trace summary plus service log still don't explain the bug; new MCP captures land here too.`
  }
  if (hasAnyFailureWithNonEmptyDir(failedDir, 'playwright-mcp')) {
    return `- \`${failedDir}/<slug>/playwright-mcp/\` — browser captures (console / DOM snapshots / network) recorded by your own earlier Playwright MCP calls in this run. Inspect when the trace summary plus service log still don't explain the bug.`
  }
  return ''
}

export function nonEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('_')).length > 0
  } catch {
    return false
  }
}

export function hasAnyFailureWith(failedDir: string, relPath: string): boolean {
  if (!fs.existsSync(failedDir)) return false
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(failedDir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (fs.existsSync(path.join(failedDir, e.name, relPath))) return true
  }
  return false
}

export function hasAnyFailureWithNonEmptyDir(failedDir: string, subDir: string): boolean {
  if (!fs.existsSync(failedDir)) return false
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(failedDir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = path.join(failedDir, e.name, subDir)
    if (!fs.existsSync(candidate)) continue
    try {
      const inner = fs.readdirSync(candidate).filter((f) => !f.startsWith('_'))
      if (inner.length > 0) return true
    } catch { /* ignore */ }
  }
  return false
}

export function fileHasContent(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf-8').trim().length > 0
  } catch {
    return false
  }
}

export function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function hasAnyServiceLog(runDir: string): boolean {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }) } catch { return false }
  return entries.some((entry) => entry.isFile() && /^svc-.+\.log$/.test(entry.name))
}

export function hasAnyFailureLog(failedDir: string): boolean {
  if (!fs.existsSync(failedDir)) return false
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(failedDir, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(failedDir, entry.name)
    let inner: fs.Dirent[]
    try { inner = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    if (inner.some((candidate) => candidate.isFile() && candidate.name.endsWith('.log'))) return true
  }
  return false
}
