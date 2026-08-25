import fs from 'fs'
import path from 'path'
import { DIAGNOSIS_JOURNAL_PATH, MANIFEST_PATH, ROOT, getSummaryPath } from './paths'
import { FailedEntry, truncateOneLine } from './log-enrichment'

// ─── Heal Index ─────────────────────────────────────────────────────────────

export interface JournalEntry {
  // Always set: parseJournalMarkdown is the only producer and it reads the
  // number straight out of a `\d+` capture in the heading.
  iteration: number
  timestamp?: string
  hypothesis?: string
  outcome?: string | null
  fix?: { description?: string; file?: string }
  signal?: string
  run?: string
  feature?: string
  failingTests?: string
}

// Hard cap on the size of the unified-diff content written per iteration.
// Keeps `diagnosis-journal.md` readable and bounds the heal agent's context
// when it reads prior cycles. Larger diffs get truncated with a trailing
// marker line so the heal agent knows content is missing. Tune in one place.
export const MAX_JOURNAL_DIFF_BYTES = 8192

export function truncateDiffForJournal(text: string, max = MAX_JOURNAL_DIFF_BYTES): string {
  const byteLen = Buffer.byteLength(text, 'utf-8')
  if (byteLen <= max) return text
  // Slice by bytes to avoid splitting a multibyte rune across the boundary.
  const buf = Buffer.from(text, 'utf-8')
  const head = buf.subarray(0, max).toString('utf-8')
  // Trim any incomplete trailing partial line for readability.
  const lastNewline = head.lastIndexOf('\n')
  const safeHead = lastNewline > 0 ? head.slice(0, lastNewline) : head
  const remaining = byteLen - Buffer.byteLength(safeHead, 'utf-8')
  return `${safeHead}\n... (truncated, ${remaining} more bytes)`
}

// When a cycle's diff exceeds the in-journal cap, write the FULL unified diff
// to `<runDir>/diffs/iteration-<n>.patch` so the truncated journal block can
// point the heal agent at the complete edit. Returns the repo-relative path,
// or null on write failure (the journal still carries the truncated head).
export function writeFullDiffPatch(
  journalPath: string,
  iteration: number,
  diff: string,
): string | null {
  try {
    const dir = path.join(path.dirname(journalPath), 'diffs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `iteration-${iteration}.patch`)
    fs.writeFileSync(file, diff.endsWith('\n') ? diff : `${diff}\n`)
    // Always diffs/iteration-N.patch under the journal dir, never ROOT itself.
    return path.relative(ROOT, file)
  } catch {
    return null
  }
}

// Parse the Markdown journal format:
//
//   ## Iteration 1 — 2026-04-22T01:20:11Z
//
//   - feature: shop_oauth
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
    const heading = line.match(headingRe)
    if (heading) {
      if (current) entries.push(current)
      current = {
        iteration: parseInt(heading[1], 10),
        timestamp: heading[2].trim(),
      }
      continue
    }
    if (!current) continue
    const field = line.match(fieldRe)
    if (!field) continue
    const key = field[1]
    const value = field[2].trim()
    if (key === 'hypothesis') current.hypothesis = value
    else if (key === 'outcome') {
      current.outcome = value === 'pending' || value === 'null' || value === '' ? null : value
    }
    else if (key === 'signal') current.signal = value
    else if (key === 'run') current.run = value
    else if (key === 'feature') current.feature = value
    else if (key === 'failingTests') current.failingTests = value
    else if (key === 'fix.file') current.fix = { ...(current.fix ?? {}), file: value }
    else if (key === 'fix.description') current.fix = { ...(current.fix ?? {}), description: value }
  }
  if (current) entries.push(current)
  return entries
}

// Read the latest journal iteration's `failingTests` line and split it back
// into a slug array. This is the "what was failing at the start of the
// previous cycle" record. Returns [] when the journal is missing, has no
// iterations, or the latest entry has no failingTests field (e.g., the
// summary was missing when the iteration was appended).
export function readPreviousFailingSlugsFromJournal(journalPath: string): string[] {
  try {
    const raw = fs.readFileSync(journalPath, 'utf-8')
    const entries = parseJournalMarkdown(raw)
    const last = entries[entries.length - 1]
    const value = last?.failingTests?.trim()
    if (!value) return []
    return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  } catch {
    return []
  }
}

// Same-failure streak for `currentSlugs`, derived from the journal: the current
// observation (1) plus each trailing iteration whose `failingTests` matches the
// current set. Mirrors HealCycleState.consecutiveSameFailures for surfaces that
// only have the persisted journal (the external/MCP heal loop doesn't run the
// in-memory state machine). Ordering-insensitive: keys off a sorted signature so
// the runner reordering slugs can't masquerade as progress. Returns 0 when the
// current set is empty.
export function countConsecutiveSameFailures(
  journalPath: string,
  currentSlugs: readonly string[],
): number {
  const target = signatureFor(currentSlugs)
  if (!target) return 0
  let streak = 1
  try {
    const entries = parseJournalMarkdown(fs.readFileSync(journalPath, 'utf-8'))
    for (let i = entries.length - 1; i >= 0; i--) {
      const value = entries[i]?.failingTests?.trim()
      if (!value) break
      const sig = signatureFor(value.split(',').map((s) => s.trim()))
      if (sig !== target) break
      streak += 1
    }
  } catch {
    return streak
  }
  return streak
}

export function signatureFor(slugs: readonly string[]): string {
  return slugs.map((s) => s.trim()).filter((s) => s.length > 0).slice().sort().join('|')
}

// Flake-tolerant per-test streaks derived from the journal — the external/MCP
// mirror of `HealCycleState.stuckSlugs`. For each currently-failing slug,
// counts the current observation (1) plus each trailing journal iteration
// whose `failingTests` includes that slug, stopping at the first iteration
// where it was absent. A slug at `threshold`+ observations is stuck even when
// flaky siblings churned the exact-set signature between cycles.
export function stuckSlugsFromJournal(
  journalPath: string,
  currentSlugs: readonly string[],
  threshold: number,
): { stuck: string[]; maxStreak: number } {
  const current = currentSlugs.map((s) => s.trim()).filter((s) => s.length > 0)
  if (current.length === 0) return { stuck: [], maxStreak: 0 }
  let priorSets: Array<Set<string>> = []
  try {
    const entries = parseJournalMarkdown(fs.readFileSync(journalPath, 'utf-8'))
    priorSets = entries.map(
      (e) => new Set((e.failingTests ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)),
    )
  } catch { /* no journal → every streak is 1 */ }
  let maxStreak = 0
  const stuck: string[] = []
  for (const slug of current) {
    let streak = 1
    for (let i = priorSets.length - 1; i >= 0; i--) {
      if (!priorSets[i].has(slug)) break
      streak += 1
    }
    if (streak > maxStreak) maxStreak = streak
    if (streak >= threshold) stuck.push(slug)
  }
  return { stuck, maxStreak }
}

export function readJournalTail(journalPath: string, limit = 3): JournalEntry[] {
  try {
    const raw = fs.readFileSync(journalPath, 'utf-8')
    return parseJournalMarkdown(raw).slice(-limit)
  } catch {
    return []
  }
}

// ─── Journal append (runner-side) ───────────────────────────────────────────
//
// The runner pre-seeds the iteration heading and the fields it already knows
// (feature, failingTests, timestamp, signal, fix.file, outcome: pending) so
// the agent doesn't have to spend tokens writing ceremony boilerplate. The
// agent normally supplies `hypothesis` (and optionally `fix.description`) in
// the signal-body JSON it wrote to `.restart` / `.rerun`; `.none` records a
// runner-side no-signal timeout or exit.

export interface JournalAppendInput {
  signal: '.restart' | '.rerun' | 'none'
  hypothesis?: string
  filesChanged?: string[]
  fixDescription?: string
  // Unified-diff content (concatenated across the feature's repos) for the
  // agent's edit window. Written into a `### Diff` subsection beneath the
  // structured fields; truncated to MAX_JOURNAL_DIFF_BYTES on write.
  diffContent?: string
  runId?: string
  // When provided, overrides the global manifest/summary lookup so the
  // orchestrator can append from a per-run dir without the runner-side
  // singletons getting in the way.
  manifestPath?: string
  summaryPath?: string
  journalPath?: string
}

export type JournalOutcome = 'all_passed' | 'advanced' | 'partial' | 'no_change' | 'regression'

export interface SummaryForJournalOutcome {
  failed?: Array<{ name?: unknown }>
  // `unknown` mirrors SummaryShape in run-verdict.ts: this is parsed JSON off
  // disk, so the field's type is a claim until checked. Kept as a local
  // structural type rather than importing SummaryShape — heal-journal is loaded
  // inside the Playwright reporter process, and run-verdict's neighbours pull in
  // the AST extractor and feature loader.
  passedNames?: unknown
}

export function failedNamesFromSummary(summary: SummaryForJournalOutcome): string[] {
  return Array.isArray(summary.failed)
    ? summary.failed
        .map((f) => f.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
}

// The passing set recorded by a summary, or null when the summary has no
// `passedNames` field at all. The null case is load-bearing: it is the only
// thing separating "nothing had passed yet" from "this summary predates the
// field", and those two demand opposite regression rules.
function passedNameSetFromSummary(summary: SummaryForJournalOutcome): Set<string> | null {
  if (!Array.isArray(summary.passedNames)) return null
  return new Set(summary.passedNames.filter((n): n is string => typeof n === 'string' && n.length > 0))
}

// Classify a heal cycle by comparing the failing set before the fix with the
// one after the verification rerun.
//
// `regression` means one thing only: a test that was GREEN before this fix is
// red now. It deliberately does not mean "a failing name we hadn't seen".
// Under `--max-failures=1` the suite aborts at the first failure, so a cycle
// that actually works surfaces the next test as the blocker — a name that was
// in neither the before-failures nor the before-passes because it had never
// executed. Reading that as a regression is how run 2026-08-07T0709-33ng got
// four consecutive `regression` labels for four successful cycles, each one
// telling the next cycle (via OUTCOME_STEER) to revert a fix that had worked.
// That case is `advanced`: the blocker cleared and the suite went deeper.
//
// Order matters. `regression` outranks `advanced` so a cycle that fixes one
// test and breaks a green one still steers a revert.
export function classifyJournalOutcome(
  before: SummaryForJournalOutcome,
  after: SummaryForJournalOutcome,
): JournalOutcome {
  const beforeNames = new Set(failedNamesFromSummary(before))
  const afterNames = new Set(failedNamesFromSummary(after))
  if (afterNames.size === 0) return 'all_passed'

  let fixed = 0
  for (const name of beforeNames) {
    if (!afterNames.has(name)) fixed += 1
  }
  const introduced: string[] = []
  for (const name of afterNames) {
    if (!beforeNames.has(name)) introduced.push(name)
  }

  const beforePassed = passedNameSetFromSummary(before)
  if (!beforePassed) {
    // Legacy summaries carry no passing set, so a broken-green test and a
    // never-run one are indistinguishable here. Keep the old any-new-failure
    // reading: a spurious `regression` costs one revert cycle, while the other
    // direction would let a real regression through wearing a progress badge.
    if (introduced.length > 0 || afterNames.size > beforeNames.size) return 'regression'
    return fixed > 0 ? 'partial' : 'no_change'
  }

  if (introduced.some((name) => beforePassed.has(name))) return 'regression'
  if (fixed > 0 && introduced.length > 0) return 'advanced'
  if (fixed > 0) return 'partial'
  // Nothing cleared. This also absorbs the rare "blocker unchanged but the run
  // surfaced a never-run failure" case: the actionable fact for the next cycle
  // is still that the fix did not move the blocker, which is what `no_change`
  // steers on.
  return 'no_change'
}

export interface JournalOutcomeUpdateInput {
  journalPath: string
  runId?: string
  outcome: JournalOutcome
}

export function updateLatestPendingJournalOutcome(input: JournalOutcomeUpdateInput): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(input.journalPath, 'utf-8')
  } catch {
    return false
  }

  const lines = raw.split('\n')
  const sectionStarts: number[] = []
  const headingRe = /^##\s+Iteration\s+\d+\s+[—-]\s+.+?\s*$/
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) sectionStarts.push(i)
  }

  for (let s = sectionStarts.length - 1; s >= 0; s--) {
    const start = sectionStarts[s]
    const end = sectionStarts[s + 1] ?? lines.length
    const section = lines.slice(start, end)
    if (input.runId && !section.some((line) => line.trim() === `- run: ${input.runId}`)) {
      continue
    }
    const outcomeOffset = section.findIndex((line) => /^\s*-\s+outcome:\s*(pending|null)?\s*$/.test(line))
    if (outcomeOffset === -1) continue
    lines[start + outcomeOffset] = `- outcome: ${input.outcome}`
    const tmpPath = `${input.journalPath}.tmp`
    fs.writeFileSync(tmpPath, lines.join('\n'))
    fs.renameSync(tmpPath, input.journalPath)
    return true
  }
  return false
}

export function nextIterationNumber(journalPath: string = DIAGNOSIS_JOURNAL_PATH): number {
  try {
    const raw = fs.readFileSync(journalPath, 'utf-8')
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

export interface ManifestForJournal {
  feature?: string
  featureName?: string
}

export function readManifestFrom(file: string): ManifestForJournal {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ManifestForJournal
  } catch {
    return {}
  }
}

export function readFeatureNameFromManifest(file: string): string | undefined {
  const manifest = readManifestFrom(file)
  return manifest.feature ?? manifest.featureName
}

export function appendJournalSection(journalPath: string, section: string[]): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true })
  const header = fs.existsSync(journalPath)
    ? ''
    : '# Diagnosis Journal\n\n'
  fs.appendFileSync(journalPath, header + section.join('\n'))
}

export function appendJournalIteration(input: JournalAppendInput): void {
  const hypothesis = input.hypothesis?.trim()
  if (!hypothesis) return // Nothing meaningful to record — skip.

  const manifestPath = input.manifestPath ?? MANIFEST_PATH
  const summaryPath = input.summaryPath ?? getSummaryPath()
  const journalPath = input.journalPath ?? DIAGNOSIS_JOURNAL_PATH

  const featureName = readFeatureNameFromManifest(manifestPath)

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

  const iteration = nextIterationNumber(journalPath)
  const section: string[] = []
  section.push(`## Iteration ${iteration} — ${new Date().toISOString()}`)
  section.push('')
  if (input.runId) section.push(`- run: ${input.runId}`)
  if (featureName) section.push(`- feature: ${featureName}`)
  if (failingTests) section.push(`- failingTests: ${failingTests}`)
  section.push(`- hypothesis: ${truncateOneLine(hypothesis, 400)}`)
  if (fixFile) section.push(`- fix.file: ${fixFile}`)
  if (input.fixDescription) {
    section.push(`- fix.description: ${truncateOneLine(input.fixDescription, 400)}`)
  }
  section.push(`- signal: ${input.signal}`)
  section.push('- outcome: pending')
  section.push('')

  // Diff content lives in its own subsection — a `- fix.diff:` field line
  // can't carry multi-line content without breaking the per-line field
  // parser. The fenced block is `diff`-tagged so editors and the agent both
  // get syntax cues.
  const diffContent = input.diffContent?.trim()
  if (diffContent) {
    section.push('### Diff')
    section.push('')
    section.push('```diff')
    section.push(truncateDiffForJournal(diffContent))
    section.push('```')
    // The journal block is capped for readability; when the diff overflows it,
    // persist the full patch and point the agent at it so no edit context is
    // lost across cycles.
    if (Buffer.byteLength(diffContent, 'utf-8') > MAX_JOURNAL_DIFF_BYTES) {
      const patchPath = writeFullDiffPatch(journalPath, iteration, diffContent)
      if (patchPath) section.push(`Full diff: ${patchPath}`)
    }
    section.push('')
  }

  appendJournalSection(journalPath, section)
}
