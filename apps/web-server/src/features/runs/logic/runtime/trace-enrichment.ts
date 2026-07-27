import fs from 'fs'
import path from 'path'
import { MAX_REQUEST_DETAILS, RunCliResult, parseFailedActionIds, parseRequestIds, runPlaywrightCli } from './trace-cli'
import { renderFailureSummary, writeDrillDownFiles } from './trace-failure-summary'

export { parseFailedActionIds, parseFirstFailedActionId, parseRequestIds, stripSnapshotsCliBlock } from './trace-cli'

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

  // 4b. Drill into the first few failed requests (headers + bodies) — the
  //     failing API call's response body is often the real root cause, and
  //     the requests table alone carries only method/status/URL. Must run
  //     before `trace close`.
  const requestIds = failedRequests.ok ? parseRequestIds(failedRequests.stdout).slice(0, MAX_REQUEST_DETAILS) : []
  const requestDetails: Array<{ id: string; result: RunCliResult }> = requestIds.length === 0
    ? []
    : await Promise.all(
        requestIds.map(async (id) => ({
          id,
          result: await runPlaywrightCli(['trace', 'request', id], outputDir),
        })),
      )

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
    requestDetails,
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
