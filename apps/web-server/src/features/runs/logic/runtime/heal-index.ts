import fs from 'fs'
import path from 'path'
import { DIAGNOSIS_JOURNAL_PATH, HEAL_INDEX_PATH, ROOT, getSummaryPath } from './paths'
import { readJournalTail, readPreviousFailingSlugsFromJournal } from './heal-journal'
import { EnrichedSummary, Manifest, healIndexPathForSummary, journalPathForSummary, manifestPathForSummary, readManifest, renderSliceLines, stripAnsi, truncateOneLine } from './log-enrichment'

export function normalizeErrorKey(raw: string): string {
  const cleaned = stripAnsi(raw).replace(/\s+/g, ' ').trim()
  return cleaned || '(no error)'
}

// How many prior runs of the same feature to consult for the per-test
// cross-run failure history. Small on purpose: recent runs are the signal.
export const FLAKE_HISTORY_RUN_LIMIT = 5

// Cross-run failure history for the currently failing tests: how many of the
// last N prior runs of this feature each test ALSO failed in. This is the
// flaky-vs-real discriminator the heal agent can't derive from a single run —
// "failed in 4 of the last 5 runs" reads persistent; "failed in 0 of 5" reads
// new (introduced by the change under test) or a fresh flake.
//
// Prior runs are sibling directories of the current run dir (run ids are
// timestamp-prefixed, so lexicographic order is chronological). Only runs
// whose manifest names the same feature count. Returns null when there are no
// comparable prior runs (fresh workspace, legacy global-logs layout).
export function readCrossRunFailureHistory(opts: {
  healIndexPath: string
  feature?: string
  slugs: readonly string[]
}): Map<string, { failed: number; total: number }> | null {
  if (!opts.feature || opts.slugs.length === 0) return null
  const runDir = path.dirname(opts.healIndexPath)
  const root = path.dirname(runDir)
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  const priorDirs = entries
    .filter((e) => e.isDirectory() && path.join(root, e.name) !== runDir)
    .map((e) => e.name)
    .sort()
    .reverse()
  const counts = new Map<string, { failed: number; total: number }>(
    opts.slugs.map((s) => [s, { failed: 0, total: 0 }]),
  )
  let inspected = 0
  for (const name of priorDirs) {
    if (inspected >= FLAKE_HISTORY_RUN_LIMIT) break
    const dir = path.join(root, name)
    const manifest = readManifest(path.join(dir, 'manifest.json'))
    const feature = manifest.feature ?? manifest.featureName
    if (!feature || feature !== opts.feature) continue
    let failedNames: Set<string>
    try {
      const summary = JSON.parse(
        fs.readFileSync(path.join(dir, 'e2e-summary.json'), 'utf-8'),
      ) as { failed?: Array<{ name?: unknown }> }
      failedNames = new Set(
        (Array.isArray(summary.failed) ? summary.failed : [])
          .map((f) => (typeof f?.name === 'string' ? f.name : ''))
          .filter((n) => n.length > 0),
      )
    } catch { continue }
    inspected += 1
    for (const slug of opts.slugs) {
      // `counts` was seeded from this same list, so every slug has an entry.
      const c = counts.get(slug)!
      c.total += 1
      if (failedNames.has(slug)) c.failed += 1
    }
  }
  return inspected === 0 ? null : counts
}

// One-word interpretation so the agent doesn't have to re-derive what the
// ratio means. End-of-run summaries are the source, so "failed" means the
// test was still failing when that run finished (post-heal).
export function flakeHistoryLine(h: { failed: number; total: number }): string {
  const reading = h.failed === h.total
    ? 'persistent'
    : h.failed === 0
      ? 'new — first failure in recent runs'
      : 'intermittent — possible flake'
  return `  - history: failed in ${h.failed} of the last ${h.total} run${h.total === 1 ? '' : 's'} of this feature (${reading})`
}

// Write a compact map (not a script) for the heal agent: where the feature
// lives, which repos to edit, what failed, and the exact slice files to read.
// Keep this literal; inferred target-service hints can mislead when a shared
// frontend/proxy appears in every slice but the real bug lives downstream.
export function writeHealIndex(parsed?: {
  manifest: Manifest
  summary: EnrichedSummary
  healIndexPath?: string
  summaryPath?: string
  journalPath?: string
  /**
   * Failing-slug list from the cycle BEFORE this one. When provided and
   * non-empty, `writeHealIndex` emits a `## Failure delta vs previous cycle`
   * section so the agent can see what its prior cycle changed (or didn't).
   * Empty / omitted on the first cycle of a run.
   */
  previousFailingSlugs?: readonly string[]
}): void {
  let summary: EnrichedSummary
  let manifest: Manifest
  let healIndexPath = HEAL_INDEX_PATH
  let journalPath = DIAGNOSIS_JOURNAL_PATH
  if (parsed) {
    summary = parsed.summary
    manifest = parsed.manifest
    healIndexPath = parsed.healIndexPath ?? healIndexPath
    journalPath = parsed.journalPath ?? (parsed.summaryPath ? journalPathForSummary(parsed.summaryPath) : journalPath)
  } else {
    const summaryPath = getSummaryPath()
    if (!fs.existsSync(summaryPath)) return
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as EnrichedSummary
    manifest = readManifest(manifestPathForSummary(summaryPath))
    healIndexPath = healIndexPathForSummary(summaryPath)
    journalPath = journalPathForSummary(summaryPath)
  }

  const failed = Array.isArray(summary.failed) ? summary.failed : []
  const lines: string[] = []

  lines.push('# Heal Index')
  lines.push('')
  if (manifest.stoppedEarly) {
    const { reason, failuresAtStop, suiteTotal } = manifest.stoppedEarly
    lines.push(
      `> Stopped early: ${reason} after ${failuresAtStop} failure${failuresAtStop === 1 ? '' : 's'} (suite has ${suiteTotal} test${suiteTotal === 1 ? '' : 's'}; remaining unrun)`,
    )
    lines.push('')
  }
  if (manifest.featureDir) {
    lines.push(`Feature: ${path.relative(ROOT, manifest.featureDir) || manifest.featureDir}`)
  } else {
    // `??` and not `||`: an explicitly empty `feature` means "no name", it does
    // not fall through to `featureName`.
    const name = manifest.feature ?? manifest.featureName
    if (name) lines.push(`Feature: ${name}`)
  }
  if (manifest.repoPaths && manifest.repoPaths.length > 0) {
    lines.push(`Repos:   ${manifest.repoPaths.join(', ')}`)
  }
  lines.push('')

  if (failed.length === 0) {
    lines.push('No failures. Nothing to heal.')
  } else {
    const flakeHistory = readCrossRunFailureHistory({
      healIndexPath,
      feature: manifest.feature ?? manifest.featureName,
      slugs: failed.map((e) => (typeof e.name === 'string' ? e.name : '')).filter((n) => n.length > 0),
    })
    lines.push('## Failures')
    lines.push('')
    for (const entry of failed) {
      lines.push(`- **${entry.name}**`)
      if (entry.error?.message) {
        const errorMessage = normalizeErrorKey(entry.error.message)
        lines.push(`  - error: ${truncateOneLine(errorMessage, 400)}`)
      }
      const history = flakeHistory?.get(entry.name)
      if (history && history.total > 0) {
        lines.push(flakeHistoryLine(history))
      }
      if (entry.errorFile) {
        lines.push(`  - full error: ${entry.errorFile}`)
      }
      for (const sliceLine of renderSliceLines(entry)) {
        lines.push(sliceLine)
      }
      if (entry.errorContextFile) {
        lines.push(`  - page state: ${entry.errorContextFile} — Playwright's own capture of what the page looked like when the assertion failed`)
      }
      if (entry.traceSummaryFile) {
        lines.push(`  - trace: ${entry.traceSummaryFile} — read this for the failing action, page state, failed requests, console errors`)
      }
      if (entry.harFile) {
        lines.push(`  - network: ${entry.harFile} — full HAR of every request this test made; grep it for the failing call's response body rather than reading it whole`)
      }
    }
    lines.push('')
  }

  // Failure delta vs the previous cycle's failing set. Only emitted when we
  // actually have a previous cycle to compare against — on the initial run
  // there's no prior journal entry, so the section is suppressed.
  // The agent uses this to attribute what its prior turn did or didn't change:
  //   - still failing: same tests as last cycle — your previous fix didn't help
  //   - newly failing: regressions you introduced last cycle
  //   - newly passing: tests your previous fix actually unblocked
  //
  // When `previousFailingSlugs` isn't explicitly plumbed in, fall back to the
  // latest journal iteration's `failingTests` line. The reporter calls
  // writeHealIndex without orchestrator access, so journal-derived defaults
  // keep the call sites simple while still giving the agent the delta.
  const prevSlugs = parsed?.previousFailingSlugs ?? readPreviousFailingSlugsFromJournal(journalPath)
  if (failed.length > 0 && prevSlugs.length > 0) {
    const currentSlugs = failed
      .map((e) => (typeof e.name === 'string' ? e.name : ''))
      .filter((n) => n.length > 0)
    const currentSet = new Set(currentSlugs)
    const previousSet = new Set(prevSlugs)
    const stillFailing = currentSlugs.filter((s) => previousSet.has(s))
    const newlyFailing = currentSlugs.filter((s) => !previousSet.has(s))
    const newlyPassing = prevSlugs.filter((s) => !currentSet.has(s))

    lines.push('## Failure delta vs previous cycle')
    if (stillFailing.length > 0) {
      lines.push(`- still failing (${stillFailing.length}): ${stillFailing.join(', ')}`)
    }
    if (newlyFailing.length > 0) {
      lines.push(`- newly failing (${newlyFailing.length}): ${newlyFailing.join(', ')}`)
    }
    if (newlyPassing.length > 0) {
      lines.push(`- newly passing (${newlyPassing.length}): ${newlyPassing.join(', ')}`)
    }
    lines.push('')
  }

  const journalTail = readJournalTail(journalPath)
  if (journalTail.length > 0) {
    const parts = journalTail.map((e) => {
      const iter = `#${e.iteration}`
      const outcome = e.outcome === null || e.outcome === undefined ? 'pending' : e.outcome
      const hyp = e.hypothesis ? truncateOneLine(e.hypothesis, 100) : '(no hypothesis)'
      return `${iter} ${hyp} → ${outcome}`.trim()
    })
    lines.push(`Journal: ${parts.join('; ')}.  Full history: \`${path.relative(ROOT, journalPath)}\`.`)
    lines.push('')
  }

  // Surface the most recent heal-cycle's selective-restart bookkeeping so the
  // next heal agent knows which services were left warm (no restart, no log
  // truncation) vs restarted from scratch.
  const lastCycle = manifest.healCycleHistory?.[manifest.healCycleHistory.length - 1]
  if (lastCycle && (lastCycle.kept.length > 0 || lastCycle.restarted.length > 0)) {
    const restarted = lastCycle.restarted.length > 0 ? lastCycle.restarted.join(', ') : '(none)'
    const kept = lastCycle.kept.length > 0 ? lastCycle.kept.join(', ') : '(none)'
    lines.push(`Previous cycle #${lastCycle.cycle}: restarted ${restarted}; kept warm: ${kept}.`)
    lines.push('')
  }

  fs.mkdirSync(path.dirname(healIndexPath), { recursive: true })
  const tmp = `${healIndexPath}.tmp`
  fs.writeFileSync(tmp, lines.join('\n'))
  fs.renameSync(tmp, healIndexPath)
}
