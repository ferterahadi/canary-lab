import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

// Surface the highest-signal pieces of a Playwright `trace.zip` as a
// self-contained `trace-extract/` directory that the heal agent reads with
// the `Read` tool — never `Bash`. The directory contains a lean
// `failure-summary.md` for the heal prompt and full-fidelity drill-down
// files (snapshot, actions, failed network, console, multi-action detail)
// for when the summary isn't enough.
//
// We use Playwright's built-in trace CLI under the hood (see
// `node_modules/playwright-core/lib/tools/trace/SKILL.md`) — Playwright owns
// the trace schema, so this stays version-stable. The CLI is invoked
// internally; nothing in the artifacts we write points the agent at it.

const CLI_TIMEOUT_MS = 30_000

// Summary section caps. These bound only the inlined slice in
// `failure-summary.md`; the corresponding sibling `.txt` files are always
// written full-fidelity. Tune in one place.
const SUMMARY_SNAPSHOT_MAX_LINES = 150
const SUMMARY_TIMELINE_MAX_ACTIONS = 15
const SUMMARY_TOP_REQUESTS = 10
const SUMMARY_TOP_CONSOLE = 10
// Table-output convention: 2 lines of header (column titles + box-drawing
// separator) above the first data row. Used when slicing top-N / last-N
// rows from `trace actions`, `trace requests`, etc.
const TABLE_HEADER_LINES = 2

// Resolve the Playwright CLI script once per process. We spawn it with
// `process.execPath` (the current Node binary) instead of relying on `npx` /
// PATH lookup, which makes this robust whether canary-lab runs from source or
// from an installed npm package.
let cachedCliPath: string | null = null
function resolvePlaywrightCli(): string {
  if (cachedCliPath) return cachedCliPath
  const pkgPath = require.resolve('@playwright/test/package.json')
  const cli = path.join(path.dirname(pkgPath), 'cli.js')
  /* v8 ignore next -- package installs without cli.js are corrupt install states, not runtime branches. */
  if (!fs.existsSync(cli)) {
    throw new Error(`playwright cli not found at ${cli}`)
  }
  cachedCliPath = cli
  return cli
}

interface RunCliOk { ok: true; stdout: string }
interface RunCliFail { ok: false; error: string }
type RunCliResult = RunCliOk | RunCliFail

async function runPlaywrightCli(args: string[], cwd: string): Promise<RunCliResult> {
  const cli = resolvePlaywrightCli()
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: stripTrailingNoise(stdout) || err.message })
          return
        }
        resolve({ ok: true, stdout: stripTrailingNoise(stdout) })
      },
    )
  })
}

// Strip noise the Playwright CLI sometimes emits when wrapped by the macOS /
// Linux shell-integration: a `Shell cwd was reset to ...` line at the very
// end. Belongs nowhere in the agent-facing artifacts.
function stripTrailingNoise(out: string): string {
  return out
    .replace(/\n?Shell cwd was reset to .*\n?$/m, '')
    .replace(/\s+$/, '')
}

// `trace action <id>` output ends with a block that tells the user to run
// `npx playwright trace snapshot <id> --name <before|after>`. We've already
// written those snapshots to sibling files; rewrite the block to point at
// the files so the agent doesn't try to invoke the (stateful, easy to
// misuse) CLI.
export function stripSnapshotsCliBlock(actionOutput: string): string {
  // The CLI block is two indented lines:
  //   available: before, after
  //   usage:     npx playwright trace snapshot 25 --name <before|after>
  // Replace the `usage:` line with a pointer; keep `available:` because it
  // tells the agent whether `snapshot-before.txt` exists.
  return actionOutput.replace(
    /(^|\n)(\s*)usage:\s+npx playwright trace snapshot .*$/m,
    (_match, lead: string, indent: string) =>
      `${lead}${indent}see:       trace-extract/snapshot-at-failure.txt (and snapshot-before.txt when listed above)`,
  )
}

// Parse `trace actions --errors-only` output to find every failing action's
// numeric ID. The CLI prints a table whose first data column is the ordinal
// number (e.g. "  25.  0:03.111  Wait for selector ...  ✗") plus optional
// continuation lines (selector wrap-around). Returns an ordered, deduped
// list of ordinals.
export function parseFailedActionIds(errorsOnlyStdout: string): string[] {
  const lines = errorsOnlyStdout.split('\n')
  const ids: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+\S+\s+.+✗\s*$/)
    if (!m) continue
    if (seen.has(m[1])) continue
    seen.add(m[1])
    ids.push(m[1])
  }
  return ids
}

// Back-compat shim — used by older callers and the existing test.
export function parseFirstFailedActionId(errorsOnlyStdout: string): string | null {
  const ids = parseFailedActionIds(errorsOnlyStdout)
  return ids[0] ?? null
}

export interface ExtractTraceSummaryArgs {
  /** Absolute path to the Playwright trace.zip for a failed test. */
  traceZipPath: string
  /** Per-failure output dir, e.g. `<runDir>/failed/<slug>/trace-extract`.
   *  We also use this as the cwd for the CLI invocations, which is where
   *  Playwright extracts its scratch dir (`.playwright-cli/`). */
  outputDir: string
  /** Optional path used in the summary header for the agent's reference. */
  testName?: string
}

export interface ExtractTraceSummaryResult {
  /** Absolute path to the written `failure-summary.md`. */
  summaryPath: string
  /** Bytes written to the summary file. */
  bytes: number
  /** The failed-action ordinal we drilled into first, when one was found. */
  failedActionId: string | null
  /** All sibling files written into `outputDir` (basenames). */
  drillDownFiles: string[]
}

/**
 * Run the Playwright trace CLI against a failing test's trace.zip and write
 * a self-contained `trace-extract/` directory:
 *
 *   failure-summary.md     ← lean headline (referenced from the heal prompt)
 *   failing-action.txt     ← full `trace action <id>` for the first ✗
 *   failed-actions.txt     ← concatenated `trace action <id>` for every ✗
 *   snapshot-at-failure.txt← full accessibility snapshot, no cap
 *   snapshot-before.txt    ← `before` phase, when present
 *   actions.txt            ← full action timeline, no cap
 *   network-failed.txt     ← every failed request
 *   console-errors.txt     ← every console error
 *   metadata.txt           ← `trace open` output (browser, viewport, etc.)
 *
 * The agent is expected to read `failure-summary.md` first, then `Read` any
 * sibling file the summary points to.
 *
 * Throws only on egregious setup errors (missing trace, can't write).
 * Per-subcommand failures degrade gracefully: the affected section gets a
 * `_(... failed: <message>)_` placeholder, and the run continues.
 */
export async function extractTraceSummary(
  args: ExtractTraceSummaryArgs,
): Promise<ExtractTraceSummaryResult> {
  const { traceZipPath, outputDir, testName } = args
  if (!fs.existsSync(traceZipPath)) {
    throw new Error(`trace.zip not found: ${traceZipPath}`)
  }
  fs.mkdirSync(outputDir, { recursive: true })

  // 1. Open the trace. This populates `<outputDir>/.playwright-cli/trace/`
  //    which all subsequent commands read from. Must complete before any
  //    other call.
  const meta = await runPlaywrightCli(['trace', 'open', traceZipPath], outputDir)

  // 2. Collect cross-cutting views in parallel — they only read the
  //    extracted trace dir, so they don't race each other.
  const [allActions, errorsOnly, failedRequests, consoleErrors] = await Promise.all([
    runPlaywrightCli(['trace', 'actions'], outputDir),
    runPlaywrightCli(['trace', 'actions', '--errors-only'], outputDir),
    runPlaywrightCli(['trace', 'requests', '--failed'], outputDir),
    runPlaywrightCli(['trace', 'console', '--errors-only'], outputDir),
  ])

  const failedIds = errorsOnly.ok ? parseFailedActionIds(errorsOnly.stdout) : []
  const failedActionId = failedIds[0] ?? null

  // 3. Drill into each failed action (in parallel). The first one's output
  //    leads the summary; all are concatenated into `failed-actions.txt`.
  const actionDetails: Array<{ id: string; result: RunCliResult }> = failedIds.length === 0
    ? []
    : await Promise.all(
        failedIds.map(async (id) => ({
          id,
          result: await runPlaywrightCli(['trace', 'action', id], outputDir),
        })),
      )

  // 4. Snapshots for the first failing action: default (state at failure)
  //    and `before` (page state immediately before the failing call). Both
  //    are best-effort — many traces don't carry a `before` phase.
  const [snapshot, snapshotBefore] = failedActionId
    ? await Promise.all([
        runPlaywrightCli(['trace', 'snapshot', failedActionId], outputDir),
        runPlaywrightCli(['trace', 'snapshot', failedActionId, '--name', 'before'], outputDir),
      ])
    : [null, null]

  // 5. Best-effort close, then remove the `.playwright-cli/` scratch dir
  //    that the CLI leaves behind. `trace close` only removes the inner
  //    `trace/` subdirectory; we own the outer dir cleanup ourselves so the
  //    agent doesn't see a stray hidden folder under `trace-extract/`.
  await runPlaywrightCli(['trace', 'close'], outputDir)
  try {
    fs.rmSync(path.join(outputDir, '.playwright-cli'), { recursive: true, force: true })
  } catch { /* best-effort */ }

  // 6. Write every drill-down file. Each gets the full CLI stdout (no cap)
  //    so the agent has the unabridged source-of-truth via `Read`.
  const drillDownFiles = writeDrillDownFiles({
    outputDir,
    meta,
    allActions,
    actionDetails,
    snapshot,
    snapshotBefore,
    failedRequests,
    consoleErrors,
  })

  // 7. Render the compact summary that the heal prompt actually points at.
  const summary = renderFailureSummary({
    testName,
    traceZipPath,
    meta,
    failedActionId,
    failedIds,
    errorsOnly,
    firstActionDetail: actionDetails[0]?.result ?? null,
    snapshot,
    snapshotBefore,
    failedRequests,
    consoleErrors,
    allActions,
  })

  const summaryPath = path.join(outputDir, 'failure-summary.md')
  const tmp = `${summaryPath}.tmp`
  fs.writeFileSync(tmp, summary)
  fs.renameSync(tmp, summaryPath)

  return {
    summaryPath,
    bytes: Buffer.byteLength(summary, 'utf-8'),
    failedActionId,
    drillDownFiles,
  }
}

// ─── Drill-down file writers ────────────────────────────────────────────────

interface WriteDrillDownArgs {
  outputDir: string
  meta: RunCliResult
  allActions: RunCliResult
  actionDetails: Array<{ id: string; result: RunCliResult }>
  snapshot: RunCliResult | null
  snapshotBefore: RunCliResult | null
  failedRequests: RunCliResult
  consoleErrors: RunCliResult
}

function writeDrillDownFiles(args: WriteDrillDownArgs): string[] {
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

  // Cross-cutting views (full).
  writeIfMeaningful(
    'network-failed.txt',
    resultBodyOrError(args.failedRequests, 'trace requests --failed'),
  )
  writeIfMeaningful(
    'console-errors.txt',
    resultBodyOrError(args.consoleErrors, 'trace console --errors-only'),
  )

  return written
}

function resultBodyOrError(r: RunCliResult, label: string): string {
  if (r.ok) return r.stdout
  return `# ${label} failed\n\n${r.error}\n`
}

// ─── Summary slicing helpers ────────────────────────────────────────────────

// Number of data rows in a table-shaped CLI output. Headers (2 lines) are
// excluded. Empty trailing newlines are tolerated.
function countDataRows(stdout: string, headerLines: number = TABLE_HEADER_LINES): number {
  if (stdout.trim().length === 0) return 0
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  return Math.max(0, lines.length - headerLines)
}

// Keep header + the FIRST n data rows.
function topNRows(stdout: string, n: number, headerLines: number = TABLE_HEADER_LINES): string {
  const lines = stdout.split('\n')
  const header = lines.slice(0, headerLines)
  const data = lines.slice(headerLines)
  if (data.length <= n) return stdout
  return [...header, ...data.slice(0, n)].join('\n')
}

// Keep header + the LAST n data rows. Used for the action timeline where
// the lead-up to failure matters more than the setup.
function lastNRows(stdout: string, n: number, headerLines: number = TABLE_HEADER_LINES): string {
  const lines = stdout.split('\n')
  const header = lines.slice(0, headerLines)
  const data = lines.slice(headerLines)
  if (data.length <= n) return stdout
  return [...header, ...data.slice(-n)].join('\n')
}

// First N lines of free-form text. Used for the accessibility snapshot
// (line-based, not row-based) since it isn't a table.
function firstNLines(stdout: string, n: number): { body: string; truncated: boolean } {
  const lines = stdout.split('\n')
  if (lines.length <= n) return { body: stdout, truncated: false }
  return { body: lines.slice(0, n).join('\n'), truncated: true }
}

// ─── Summary renderer ───────────────────────────────────────────────────────

interface RenderArgs {
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

function renderFailureSummary(r: RenderArgs): string {
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
