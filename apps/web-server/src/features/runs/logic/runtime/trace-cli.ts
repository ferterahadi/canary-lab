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

export const CLI_TIMEOUT_MS = 30_000

// How many failed requests get a full `trace request <id>` drill-down
// (headers + request/response bodies) appended to network-failed.txt, and
// the per-request byte cap on that detail. The failing API call's response
// body is often the actual root cause — worth the extra CLI calls — but a
// multi-megabyte payload isn't.
export const MAX_REQUEST_DETAILS = 5

export const REQUEST_DETAIL_MAX_BYTES = 16_384

// Resolve the Playwright CLI script once per process. We spawn it with
// `process.execPath` (the current Node binary) instead of relying on `npx` /
// PATH lookup, which makes this robust whether canary-lab runs from source or
// from an installed npm package.
export let cachedCliPath: string | null = null

export function resolvePlaywrightCli(): string {
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

export interface RunCliOk { ok: true; stdout: string }

export interface RunCliFail { ok: false; error: string }

export type RunCliResult = RunCliOk | RunCliFail

export async function runPlaywrightCli(args: string[], cwd: string): Promise<RunCliResult> {
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
export function stripTrailingNoise(out: string): string {
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

// Parse `trace requests --failed` output for request ordinals. Same table
// convention as actions: data rows start with `  <n>.` after the two header
// lines. Ordered, deduped.
export function parseRequestIds(requestsStdout: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const line of requestsStdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\.\s+\S+/)
    if (!m) continue
    if (seen.has(m[1])) continue
    seen.add(m[1])
    ids.push(m[1])
  }
  return ids
}

// Byte-cap a request detail block so one large response body can't balloon
// network-failed.txt past what a single `Read` call handles.
export function capRequestDetail(text: string, max = REQUEST_DETAIL_MAX_BYTES): string {
  const byteLen = Buffer.byteLength(text, 'utf-8')
  if (byteLen <= max) return text
  const head = Buffer.from(text, 'utf-8').subarray(0, max).toString('utf-8')
  return `${head}\n… (truncated, ${byteLen - Buffer.byteLength(head, 'utf-8')} more bytes)`
}
