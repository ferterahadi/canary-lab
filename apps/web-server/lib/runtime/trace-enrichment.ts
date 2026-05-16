import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'

// Surface the highest-signal pieces of a Playwright `trace.zip` as a single
// curated `failure-summary.md` per failure. The heal agent reads this instead
// of opening the trace itself.
//
// Implementation strategy: shell out to `playwright trace <subcommand>`, which
// ships with `@playwright/test` and is specifically designed for AI agent
// consumption (see `node_modules/playwright-core/lib/tools/trace/SKILL.md`).
// We get the structured action log, accessibility snapshots, failed network,
// and console errors for free — and Playwright owns the trace schema so this
// stays version-stable on upgrades.

const CLI_TIMEOUT_MS = 30_000

// Soft cap on the accessibility-snapshot section. A chatty e-commerce page
// can produce ~80KB of role tree; that dwarfs the rest of the summary and
// dilutes the agent's attention. Truncate with a hint pointing the agent at
// `npx playwright trace snapshot <id>` for the full tree when needed.
const SNAPSHOT_MAX_BYTES = 40_960

// Soft cap on the action-timeline section. 100+ action traces produce 15KB
// timelines that are mostly noise; the first/last few actions matter most.
const TIMELINE_MAX_BYTES = 8_192

function truncateSection(body: string, maxBytes: number, hint: string): string {
  if (Buffer.byteLength(body, 'utf-8') <= maxBytes) return body
  const buf = Buffer.from(body, 'utf-8')
  const headBytes = Math.floor(maxBytes * 0.8)
  const tailBytes = maxBytes - headBytes
  const head = buf.subarray(0, headBytes).toString('utf-8')
  const tail = buf.subarray(buf.length - tailBytes).toString('utf-8')
  // Trim partial lines at the cut points for readability.
  const safeHead = head.includes('\n') ? head.slice(0, head.lastIndexOf('\n')) : head
  const safeTail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : tail
  const elided = buf.length - Buffer.byteLength(safeHead, 'utf-8') - Buffer.byteLength(safeTail, 'utf-8')
  return `${safeHead}\n\n… [truncated ${elided} bytes — ${hint}] …\n\n${safeTail}`
}

// Resolve the Playwright CLI script once per process. We spawn it with
// `process.execPath` (the current Node binary) instead of relying on `npx` /
// PATH lookup, which makes this robust whether canary-lab runs from source or
// from an installed npm package.
let cachedCliPath: string | null = null
function resolvePlaywrightCli(): string {
  if (cachedCliPath) return cachedCliPath
  const pkgPath = require.resolve('@playwright/test/package.json')
  const cli = path.join(path.dirname(pkgPath), 'cli.js')
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
          resolve({ ok: false, error: stripTrailingNoise(stdout) || (err.message ?? String(err)) })
          return
        }
        resolve({ ok: true, stdout: stripTrailingNoise(stdout) })
      },
    )
  })
}

// The CLI appends a `Shell cwd was reset to ...` footer on macOS/Linux (the
// child shell printing its cwd-tracking notice). Strip it so it doesn't leak
// into the summary.
function stripTrailingNoise(out: string): string {
  return out
    .replace(/\n?Shell cwd was reset to .*\n?$/m, '')
    .replace(/\s+$/, '')
}

// Parse `trace actions --errors-only` output to find the first failing action's
// numeric ID. The CLI prints a table whose first data column is the ordinal
// number (e.g. "  25.  0:03.111  Wait for selector ...  ✗"). Returns `null`
// when no failed action is found (e.g. the trace is from a passing run that
// was nevertheless retained — defensive).
export function parseFirstFailedActionId(errorsOnlyStdout: string): string | null {
  const lines = errorsOnlyStdout.split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+\S+\s+.+✗\s*$/)
    if (m) return m[1]
  }
  return null
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
  /** The failed-action ordinal we drilled into, when one was found. */
  failedActionId: string | null
}

/**
 * Run the Playwright trace CLI against a failing test's trace.zip and write a
 * curated `failure-summary.md` into `outputDir`. The summary leads with the
 * failing action + error, then the accessibility snapshot at the failure
 * point (when available), then failed network and console errors. The agent
 * is expected to read this file first; raw drill-down via `playwright trace`
 * remains available if it needs more.
 *
 * Returns the path to the written summary. Does not throw on subcommand
 * failures — partial output is still useful and is included with an inline
 * note. Throws only on egregious setup errors (missing trace, can't write).
 */
export async function extractTraceSummary(
  args: ExtractTraceSummaryArgs,
): Promise<ExtractTraceSummaryResult> {
  const { traceZipPath, outputDir, testName } = args
  if (!fs.existsSync(traceZipPath)) {
    throw new Error(`trace.zip not found: ${traceZipPath}`)
  }
  fs.mkdirSync(outputDir, { recursive: true })

  // 1. Open the trace. This extracts to `<cwd>/.playwright-cli/trace/` and
  //    pins it as the "current" trace for all subsequent commands.
  const meta = await runPlaywrightCli(['trace', 'open', traceZipPath], outputDir)

  // 2. Find the first failing action.
  const errorsOnly = await runPlaywrightCli(
    ['trace', 'actions', '--errors-only'],
    outputDir,
  )
  const failedActionId = errorsOnly.ok
    ? parseFirstFailedActionId(errorsOnly.stdout)
    : null

  // 3. Drill into that action: full params, error, source, snapshot refs.
  const actionDetail = failedActionId
    ? await runPlaywrightCli(['trace', 'action', failedActionId], outputDir)
    : null

  // 4. Accessibility snapshot at the moment of failure. Note: when the page
  //    closed before the failing action (e.g. browser crash, teardown race),
  //    Playwright reports `Action 'N' has no associated page` — still useful
  //    information for the agent, surface it as-is.
  const snapshot = failedActionId
    ? await runPlaywrightCli(['trace', 'snapshot', failedActionId], outputDir)
    : null

  // 5. Failed network requests across the whole run.
  const failedRequests = await runPlaywrightCli(
    ['trace', 'requests', '--failed'],
    outputDir,
  )

  // 6. Console errors across the whole run.
  const consoleErrors = await runPlaywrightCli(
    ['trace', 'console', '--errors-only'],
    outputDir,
  )

  // 7. Compact list of all actions for context (the lead-up to the failure).
  const allActions = await runPlaywrightCli(['trace', 'actions'], outputDir)

  // 8. Best-effort close — removes the `.playwright-cli/` scratch dir.
  await runPlaywrightCli(['trace', 'close'], outputDir)

  const summary = renderFailureSummary({
    testName,
    traceZipPath,
    meta,
    failedActionId,
    errorsOnly,
    actionDetail,
    snapshot,
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
  }
}

interface RenderArgs {
  testName?: string
  traceZipPath: string
  meta: RunCliResult
  failedActionId: string | null
  errorsOnly: RunCliResult
  actionDetail: RunCliResult | null
  snapshot: RunCliResult | null
  failedRequests: RunCliResult
  consoleErrors: RunCliResult
  allActions: RunCliResult
}

function renderFailureSummary(r: RenderArgs): string {
  const lines: string[] = []
  lines.push('# Failure summary (from Playwright trace)')
  lines.push('')
  if (r.testName) lines.push(`Test: ${r.testName}`)
  lines.push(`Trace: ${r.traceZipPath}`)
  lines.push('')
  lines.push('> Generated by canary-lab from `npx playwright trace`. To explore further:')
  lines.push(`> \`npx playwright trace open ${JSON.stringify(r.traceZipPath)}\` then \`actions\` / \`action <id>\` / \`snapshot <id>\` / \`requests\` / \`console\`.`)
  lines.push('')

  // ─── Section 1: failing action ──────────────────────────────────────────
  lines.push('## Failing action')
  lines.push('')
  if (r.actionDetail && r.actionDetail.ok) {
    lines.push('```')
    lines.push(r.actionDetail.stdout)
    lines.push('```')
  } else if (r.errorsOnly.ok) {
    lines.push('No single failing action could be drilled into; raw `actions --errors-only` output:')
    lines.push('')
    lines.push('```')
    lines.push(r.errorsOnly.stdout)
    lines.push('```')
  } else {
    lines.push(`_(trace actions --errors-only failed: ${r.errorsOnly.error})_`)
  }
  lines.push('')

  // ─── Section 2: page state at failure ───────────────────────────────────
  lines.push('## Page state at failure (accessibility snapshot)')
  lines.push('')
  if (r.snapshot && r.snapshot.ok && r.snapshot.stdout.trim().length > 0) {
    const truncated = truncateSection(
      r.snapshot.stdout,
      SNAPSHOT_MAX_BYTES,
      r.failedActionId
        ? `run \`npx playwright trace snapshot ${r.failedActionId}\` against the trace for the full tree`
        : 'open the trace for the full tree',
    )
    lines.push(truncated)
  } else if (r.snapshot && !r.snapshot.ok) {
    lines.push(`_(snapshot unavailable: ${r.snapshot.error})_`)
  } else {
    lines.push('_(no failing action identified — no snapshot to capture)_')
  }
  lines.push('')

  // ─── Section 3: failed network ──────────────────────────────────────────
  lines.push('## Failed network requests')
  lines.push('')
  if (r.failedRequests.ok) {
    const body = r.failedRequests.stdout.trim()
    if (body.length === 0) {
      lines.push('_(none)_')
    } else {
      lines.push('```')
      lines.push(body)
      lines.push('```')
    }
  } else {
    lines.push(`_(trace requests --failed failed: ${r.failedRequests.error})_`)
  }
  lines.push('')

  // ─── Section 4: console errors ──────────────────────────────────────────
  lines.push('## Console errors')
  lines.push('')
  if (r.consoleErrors.ok) {
    const body = r.consoleErrors.stdout.trim()
    if (body.length === 0) {
      lines.push('_(none)_')
    } else {
      lines.push('```')
      lines.push(body)
      lines.push('```')
    }
  } else {
    lines.push(`_(trace console --errors-only failed: ${r.consoleErrors.error})_`)
  }
  lines.push('')

  // ─── Section 5: all actions (lead-up context) ──────────────────────────
  lines.push('## Action timeline')
  lines.push('')
  if (r.allActions.ok) {
    lines.push('```')
    lines.push(truncateSection(
      r.allActions.stdout,
      TIMELINE_MAX_BYTES,
      'run `npx playwright trace actions` against the trace for the full timeline',
    ))
    lines.push('```')
  } else {
    lines.push(`_(trace actions failed: ${r.allActions.error})_`)
  }
  lines.push('')

  // ─── Section 6: trace metadata ──────────────────────────────────────────
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
