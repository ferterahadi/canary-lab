import fs from 'fs'
import path from 'path'
import { MAX_REQUEST_DETAILS, RunCliResult, capRequestDetail, stripSnapshotsCliBlock } from './trace-cli'

// Summary section caps. These bound only the inlined slice in
// `failure-summary.md`; the corresponding sibling `.txt` files are always
// written full-fidelity. Tune in one place.
export const SUMMARY_SNAPSHOT_MAX_LINES = 150

export const SUMMARY_TIMELINE_MAX_ACTIONS = 15

export const SUMMARY_TOP_REQUESTS = 10

export const SUMMARY_TOP_CONSOLE = 10

// Table-output convention: 2 lines of header (column titles + box-drawing
// separator) above the first data row. Used when slicing top-N / last-N
// rows from `trace actions`, `trace requests`, etc.
export const TABLE_HEADER_LINES = 2

// ─── Drill-down file writers ────────────────────────────────────────────────

export interface WriteDrillDownArgs {
  outputDir: string
  meta: RunCliResult
  allActions: RunCliResult
  actionDetails: Array<{ id: string; result: RunCliResult }>
  snapshot: RunCliResult | null
  snapshotBefore: RunCliResult | null
  failedRequests: RunCliResult
  requestDetails: Array<{ id: string; result: RunCliResult }>
  consoleErrors: RunCliResult
}

export function writeDrillDownFiles(args: WriteDrillDownArgs): string[] {
  const written: string[] = []
  const writeIfMeaningful = (filename: string, body: string): void => {
    if (body.trim().length === 0) return
    fs.writeFileSync(path.join(args.outputDir, filename), body)
    written.push(filename)
  }

  // Trace metadata (browser, viewport, action / error / network counts).
  writeIfMeaningful('metadata.txt', resultBodyOrError(args.meta, 'trace open'))

  // Full action timeline (uncapped). The agent reads this when the
  // last-15-actions slice in the summary isn't enough lead-up context.
  writeIfMeaningful('actions.txt', resultBodyOrError(args.allActions, 'trace actions'))

  // First failed action detail, on its own — most heals only need this.
  if (args.actionDetails.length > 0) {
    writeIfMeaningful(
      'failing-action.txt',
      resultBodyOrError(args.actionDetails[0].result, 'trace action'),
    )
  }

  // All failed actions concatenated. Same data as failing-action.txt for
  // single-failure traces; carries extra value for multi-failure ones.
  if (args.actionDetails.length > 0) {
    const sections: string[] = []
    for (const { id, result } of args.actionDetails) {
      sections.push(`# Action ${id}\n`)
      sections.push(resultBodyOrError(result, `trace action ${id}`))
      sections.push('')
    }
    writeIfMeaningful('failed-actions.txt', sections.join('\n').trimEnd() + '\n')
  }

  // Accessibility snapshot at the moment of failure (uncapped). When the
  // page closed before the failing call, the CLI prints
  // `Action 'N' has no associated page` — still useful, write it as-is.
  if (args.snapshot) {
    writeIfMeaningful(
      'snapshot-at-failure.txt',
      resultBodyOrError(args.snapshot, 'trace snapshot'),
    )
  }
  if (args.snapshotBefore) {
    writeIfMeaningful(
      'snapshot-before.txt',
      resultBodyOrError(args.snapshotBefore, 'trace snapshot --name before'),
    )
  }

  // Cross-cutting views (full). The failed-requests table is followed by a
  // per-request detail section (headers + request/response bodies, capped
  // per request) for the first MAX_REQUEST_DETAILS failures.
  const networkParts = [resultBodyOrError(args.failedRequests, 'trace requests --failed')]
  for (const { id, result } of args.requestDetails) {
    networkParts.push('')
    networkParts.push(`# Request ${id} (headers + bodies)`)
    networkParts.push(capRequestDetail(resultBodyOrError(result, `trace request ${id}`)))
  }
  writeIfMeaningful('network-failed.txt', networkParts.join('\n').trimEnd() + '\n')
  writeIfMeaningful(
    'console-errors.txt',
    resultBodyOrError(args.consoleErrors, 'trace console --errors-only'),
  )

  return written
}

export function resultBodyOrError(r: RunCliResult, label: string): string {
  if (r.ok) return r.stdout
  return `# ${label} failed\n\n${r.error}\n`
}

// ─── Summary slicing helpers ────────────────────────────────────────────────

// Number of data rows in a table-shaped CLI output. Headers (2 lines) are
// excluded. Empty trailing newlines are tolerated.
export function countDataRows(stdout: string, headerLines: number = TABLE_HEADER_LINES): number {
  if (stdout.trim().length === 0) return 0
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  return Math.max(0, lines.length - headerLines)
}

// Keep header + the FIRST n data rows.
export function topNRows(stdout: string, n: number, headerLines: number = TABLE_HEADER_LINES): string {
  const lines = stdout.split('\n')
  const header = lines.slice(0, headerLines)
  const data = lines.slice(headerLines)
  if (data.length <= n) return stdout
  return [...header, ...data.slice(0, n)].join('\n')
}

// Keep header + the LAST n data rows. Used for the action timeline where
// the lead-up to failure matters more than the setup.
export function lastNRows(stdout: string, n: number, headerLines: number = TABLE_HEADER_LINES): string {
  const lines = stdout.split('\n')
  const header = lines.slice(0, headerLines)
  const data = lines.slice(headerLines)
  if (data.length <= n) return stdout
  return [...header, ...data.slice(-n)].join('\n')
}

// First N lines of free-form text. Used for the accessibility snapshot
// (line-based, not row-based) since it isn't a table.
export function firstNLines(stdout: string, n: number): { body: string; truncated: boolean } {
  const lines = stdout.split('\n')
  if (lines.length <= n) return { body: stdout, truncated: false }
  return { body: lines.slice(0, n).join('\n'), truncated: true }
}

// ─── Summary renderer ───────────────────────────────────────────────────────

export interface RenderArgs {
  testName?: string
  traceZipPath: string
  meta: RunCliResult
  failedActionId: string | null
  failedIds: string[]
  errorsOnly: RunCliResult
  firstActionDetail: RunCliResult | null
  snapshot: RunCliResult | null
  snapshotBefore: RunCliResult | null
  failedRequests: RunCliResult
  consoleErrors: RunCliResult
  allActions: RunCliResult
}

export function renderFailureSummary(r: RenderArgs): string {
  const lines: string[] = []
  lines.push('# Failure summary')
  lines.push('')
  if (r.testName) lines.push(`Test: ${r.testName}`)
  lines.push(`Trace: ${r.traceZipPath}`)
  lines.push('')

  // ─── Failing action ─────────────────────────────────────────────────────
  lines.push('## Failing action')
  lines.push('')
  if (r.firstActionDetail && r.firstActionDetail.ok) {
    lines.push('```')
    lines.push(stripSnapshotsCliBlock(r.firstActionDetail.stdout))
    lines.push('```')
    if (r.failedIds.length > 1) {
      lines.push('')
      lines.push(`There are ${r.failedIds.length} failed actions in this trace; see trace-extract/failed-actions.txt for the full set.`)
    }
  } else if (r.errorsOnly.ok && r.errorsOnly.stdout.trim().length > 0) {
    lines.push('No single failing action could be drilled into; raw `actions --errors-only` output:')
    lines.push('')
    lines.push('```')
    lines.push(r.errorsOnly.stdout)
    lines.push('```')
  } else if (!r.errorsOnly.ok) {
    lines.push(`_(trace actions --errors-only failed: ${r.errorsOnly.error})_`)
  } else {
    lines.push('_(no failing actions identified in this trace)_')
  }
  lines.push('')

  // ─── Page state at failure (accessibility snapshot) ─────────────────────
  lines.push('## Page state at failure (accessibility snapshot)')
  lines.push('')
  if (r.snapshot && r.snapshot.ok && r.snapshot.stdout.trim().length > 0) {
    const sliced = firstNLines(r.snapshot.stdout, SUMMARY_SNAPSHOT_MAX_LINES)
    lines.push(sliced.body)
    if (sliced.truncated) {
      lines.push('')
      lines.push('… (truncated)')
    }
    lines.push('')
    lines.push('Full tree: trace-extract/snapshot-at-failure.txt')
    if (r.snapshotBefore && r.snapshotBefore.ok && r.snapshotBefore.stdout.trim().length > 0) {
      lines.push('Page state immediately BEFORE the failing action: trace-extract/snapshot-before.txt')
    }
  } else if (r.snapshot && !r.snapshot.ok) {
    lines.push(`_(snapshot unavailable: ${r.snapshot.error})_`)
  } else {
    lines.push('_(no failing action identified — no snapshot to capture)_')
  }
  lines.push('')

  // ─── Failed network requests ────────────────────────────────────────────
  lines.push('## Failed network requests')
  lines.push('')
  if (r.failedRequests.ok) {
    const body = r.failedRequests.stdout.trim()
    if (body.length === 0) {
      lines.push('_(none)_')
    } else {
      const dataRows = countDataRows(body)
      const sliced = topNRows(body, SUMMARY_TOP_REQUESTS)
      lines.push('```')
      lines.push(sliced)
      lines.push('```')
      lines.push('Full request/response details (headers + bodies): trace-extract/network-failed.txt')
      if (dataRows > SUMMARY_TOP_REQUESTS) {
        lines.push(`Full list (${dataRows} failed requests): trace-extract/network-failed.txt`)
      }
    }
  } else {
    lines.push(`_(trace requests --failed failed: ${r.failedRequests.error})_`)
  }
  lines.push('')

  // ─── Console errors ─────────────────────────────────────────────────────
  lines.push('## Console errors')
  lines.push('')
  if (r.consoleErrors.ok) {
    const body = r.consoleErrors.stdout.trim()
    if (body.length === 0) {
      lines.push('_(none)_')
    } else {
      const dataRows = countDataRows(body)
      const sliced = topNRows(body, SUMMARY_TOP_CONSOLE)
      lines.push('```')
      lines.push(sliced)
      lines.push('```')
      if (dataRows > SUMMARY_TOP_CONSOLE) {
        lines.push(`Full list (${dataRows} console errors): trace-extract/console-errors.txt`)
      }
    }
  } else {
    lines.push(`_(trace console --errors-only failed: ${r.consoleErrors.error})_`)
  }
  lines.push('')

  // ─── Action timeline (lead-up) ──────────────────────────────────────────
  lines.push(`## Action timeline (last ${SUMMARY_TIMELINE_MAX_ACTIONS})`)
  lines.push('')
  if (r.allActions.ok) {
    const dataRows = countDataRows(r.allActions.stdout)
    const sliced = lastNRows(r.allActions.stdout, SUMMARY_TIMELINE_MAX_ACTIONS)
    lines.push('```')
    lines.push(sliced)
    lines.push('```')
    if (dataRows > SUMMARY_TIMELINE_MAX_ACTIONS) {
      lines.push(`Full timeline (${dataRows} actions): trace-extract/actions.txt`)
    }
  } else {
    lines.push(`_(trace actions failed: ${r.allActions.error})_`)
  }
  lines.push('')

  // ─── Trace metadata ─────────────────────────────────────────────────────
  lines.push('## Trace metadata')
  lines.push('')
  if (r.meta.ok) {
    lines.push('```')
    lines.push(r.meta.stdout)
    lines.push('```')
  } else {
    lines.push(`_(trace open failed: ${r.meta.error})_`)
  }
  lines.push('')

  return lines.join('\n')
}
