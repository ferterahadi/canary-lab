import { buildPrPreflight } from './pr-preflight'
import { proposeFixesForRun } from './propose-fixes'
import { loadProjectConfig } from '../runtime/launcher/project-config'
import type { RunContext } from '../runtime/run-context'
import type { RunFixCapture, RunManifest, RunPrAttempt, RunProposedPr } from '../runtime/manifest'

// End-of-run pull request. A test run that healed green leaves a captured diff
// and, unless the workspace turned it off, proposes it as a DRAFT pull request
// before the run finishes — so an unattended overnight repair has something
// waiting for review in the morning rather than a patch file nobody knows about.
//
// Deliberately narrow about when it fires, because a push is the one step here
// that leaves the machine and can't be taken back:
//   - only a real test run (boot/verify/benchmark sessions never heal)
//   - only a green one (a loop that gave up produced a fix that did NOT work)
//   - only when repairs actually happened and left a diff
// Everything else — no gh login, no push rights, a patch that no longer applies
// — is recorded as a per-repo reason rather than raised, because the run's
// verdict must not depend on GitHub being reachable.

export interface AutoProposeDeps {
  preflight?: typeof buildPrPreflight
  propose?: typeof proposeFixesForRun
  loadConfig?: typeof loadProjectConfig
  now?: () => string
}

/** True when this run is allowed to open a pull request on its own. */
export function shouldAutoPropose(opts: {
  capture: RunFixCapture | null
  finalStatus: RunManifest['status']
  executionType: RunContext['executionType']
  healCycles: number
  autoProposePr: boolean
}): boolean {
  if (!opts.autoProposePr) return false
  if ((opts.executionType ?? 'run') !== 'run') return false
  if (opts.finalStatus !== 'passed') return false
  if (opts.healCycles <= 0) return false
  return !!opts.capture && opts.capture.repos.length > 0
}

export async function autoProposeFixes(opts: {
  ctx: RunContext
  capture: RunFixCapture | null
  finalStatus: RunManifest['status']
  deps?: AutoProposeDeps
}): Promise<void> {
  const { ctx, capture } = opts
  const preflightFor = opts.deps?.preflight ?? buildPrPreflight
  const propose = opts.deps?.propose ?? proposeFixesForRun
  const loadConfig = opts.deps?.loadConfig ?? loadProjectConfig
  const now = opts.deps?.now ?? (() => new Date().toISOString())

  // No project root means no config to read, and the setting is the user's
  // consent to push — absent consent, do nothing.
  if (!ctx.projectRoot) return
  const enabled = loadConfig(ctx.projectRoot).autoProposePr
  if (!shouldAutoPropose({
    capture,
    finalStatus: opts.finalStatus,
    executionType: ctx.executionType,
    healCycles: ctx.healCycles,
    autoProposePr: enabled,
  })) return

  const fixCapture = capture as RunFixCapture
  const preflight = await preflightFor(fixCapture)
  const results = await propose({
    runId: ctx.runId,
    feature: ctx.feature.name,
    fixCapture,
    preflight,
    draft: true,
  })

  const opened: RunProposedPr[] = results.flatMap((r) => (r.ok && r.pr ? [r.pr] : []))
  const attempt: RunPrAttempt = {
    at: now(),
    auto: true,
    results: results.map((r) => ({
      repoName: r.repoName,
      ok: r.ok,
      ...(r.pr ? { url: r.pr.url } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    })),
  }
  ctx.stateSink.patchManifest(ctx.runId, {
    ...(opened.length > 0 ? { proposedPrs: opened } : {}),
    prAttempt: attempt,
  })
  for (const r of results) {
    if (r.ok && r.pr) ctx.runnerLog?.info(`Opened a draft PR for "${r.repoName}": ${r.pr.url}`)
    else ctx.runnerLog?.warn(`No PR for "${r.repoName}": ${r.reason ?? 'unknown reason'}`)
  }
}
