// MCP tools — the Robustness Lab (D16): start a suite's perturbation matrix and
// read what it found. Both are thin over the robustness REST routes through
// `robustnessRequest` (app.inject), so admission — a green run, declared port
// slots, a valid envelope, one matrix per suite at a time — is judged in one
// place for the stage, the web UI and this surface alike.
//
// No submit half and no heal task: the matrix is deterministic Canary-run
// machinery, the same shape as `boot_services`. What an agent DOES with a
// finding is the repair loop — `start_run` with `perturbation` — so every
// result here says that in its `nextSteps`.
import { z } from 'zod'
import type { RobustnessFinding, RobustnessJobIndexEntry, RobustnessJobManifest } from '../../../../../shared/robustness/jobs'
import { type ToolGroupContext, asJsonResult, errorResult } from '../tool-support'

const UNAVAILABLE = 'Robustness Lab is unavailable on this server'

/** The poll cadence the guide quotes: a cell is a full run (~10 s of Playwright
 *  plus a service boot), so anything faster than this reads a job that has not
 *  moved. */
const POLL_ADVICE = 'poll get_robustness(jobId) again in ~30 s; a running matrix reports cells.done and the findings so far'

/** The repair-side rule, one voice with the heal context's `perturbationRule`. */
const REPAIR_ADVICE = 'for each confirmed finding call start_run(feature, perturbation: finding.shrink.envelope ?? finding.envelope, claim_heal:true, session_id, conversation_name) and drive the repair loop — the failure reproduces under that envelope and the heal context carries the rule: fix the app\'s tolerance (idempotency keys, timeouts, durable state), never the test and never the envelope'

function slimFinding(f: RobustnessFinding, includeTrace: boolean): RobustnessFinding {
  if (includeTrace || !f.shrink) return f
  // Per-probe steps are the pane's trace, dozens of envelopes deep on a busy
  // job; the agent needs the answer (`shrink.envelope`, `repro`), not the search.
  const { steps: _steps, ...shrink } = f.shrink
  return { ...f, shrink: { ...shrink, steps: [] } }
}

export function jobNextSteps(job: RobustnessJobManifest): string[] {
  if (job.status === 'running') return [POLL_ADVICE]
  const steps: string[] = []
  const confirmed = job.findings.filter((f) => f.status === 'confirmed').length
  const unconfirmed = job.findings.filter((f) => f.status === 'unconfirmed').length
  if (confirmed > 0) steps.push(REPAIR_ADVICE)
  if (unconfirmed > 0) steps.push(`${unconfirmed} finding(s) are unconfirmed — the shrunk envelope did not reproduce 3/3; report them as unconfirmed, never as defects and never as passes`)
  if (job.skipped.length > 0) steps.push(`${job.skipped.length} cell(s) could not be judged (skipped[].reason) — a skipped cell is not a pass`)
  if (job.status === 'done' && job.findings.length === 0 && job.skipped.length === 0) steps.push('no finding: every cell held under the envelope — nothing to repair')
  if (job.status !== 'done') steps.push(`the matrix ended ${job.status}${job.error ? ` (${job.error})` : ''}: findings so far stand, nothing after them was judged — start_robustness(feature) runs a fresh matrix`)
  return steps
}

export function registerRobustnessTools({ registerTool, deps }: ToolGroupContext): void {
  const request = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    if (!deps.robustnessRequest) return null
    return deps.robustnessRequest({ method, url, payload })
  }
  const jobResult = (job: RobustnessJobManifest, includeLog: boolean, includeTrace: boolean) => {
    const { log, ...record } = job
    return asJsonResult({
      ...record,
      findings: job.findings.map((f) => slimFinding(f, includeTrace)),
      ...(includeLog ? { log } : {}),
      nextSteps: jobNextSteps(job),
    })
  }

  registerTool('start_robustness', {
    description:
      'Start the Robustness Lab matrix for a suite: every spec file of its newest PASSED run (or the runId you pass) is re-run under each atom of the suite\'s robustness envelope — added latency, a duplicated write, a service restart — through a per-slot proxy; each failure is then shrunk to the smallest envelope that still reproduces it and confirmed 3/3. Deterministic Canary-run machinery: nothing to claim, no heal task — poll get_robustness(jobId) (~30 s apart) until status leaves "running"; a cell costs roughly 10 s plus a service boot, shrink up to 12 search probes per finding. Refused for a suite with no passing run or a matrix already running (409), and for a suite whose services take no injected port — run Parallel setup first (400). Omit envelope to use the suite\'s robustness/envelope.json (written with the default on first use).',
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      runId: z.string().optional().describe('The PASSED run whose spec files and test titles the matrix is built from. Defaults to the suite\'s newest passed run.'),
      envelope: z.record(z.string(), z.unknown()).optional().describe('Robustness envelope to run under (format canary-lab/robustness-envelope@1: latency {ms}, duplicate {gapMs, match}, restart [{slot, afterNth, match}]). Forwarded raw — the route validates it and names the reason when it is rejected. Omit to use the suite\'s own file.'),
    },
  }, async ({ feature, runId, envelope }) => {
    const resp = await request('POST', `/api/features/${encodeURIComponent(feature)}/robustness`, {
      ...(runId ? { runId } : {}),
      ...(envelope ? { envelope } : {}),
    })
    if (!resp) return errorResult(UNAVAILABLE)
    if (resp.statusCode >= 400) {
      const body = resp.body as { error?: string; jobId?: string }
      return errorResult(`start_robustness failed (${resp.statusCode}): ${body.error ?? JSON.stringify(resp.body)}${body.jobId ? ` — read it with get_robustness(jobId:"${body.jobId}")` : ''}`)
    }
    return jobResult(resp.body as RobustnessJobManifest, false, false)
  })

  registerTool('get_robustness', {
    description:
      'Read a Robustness Lab job by jobId — status, cells {planned, done}, findings and skipped cells — or list a suite\'s jobs newest first when only feature is given. A finding names a defect the green run did not see: the spec file and atom (cell), the tests that failed there and passed green (failedTests), their @req tags (requirements), status found → shrinking → confirmed (reproduced 3/3) | unconfirmed (did not — report it as such, never as a defect or a pass), the envelope the cell ran under, and once shrunk shrink.envelope with a one-line repro. skipped[] cells were not judged (boot failure, abort) — never passes. Repair a confirmed finding with start_run(feature, perturbation: finding.shrink.envelope ?? finding.envelope). Slim by default: the driver log and per-probe shrink steps are omitted (includeLog / includeTrace inline them).',
    inputSchema: {
      jobId: z.string().optional().describe('The job to read (from start_robustness, a flight\'s links.robustnessJobId, or the feature list).'),
      feature: z.string().optional().describe('Without jobId: list this suite\'s jobs, newest first.'),
      includeLog: z.boolean().default(false).describe('Inline the driver log (grows with every cell and probe).'),
      includeTrace: z.boolean().default(false).describe('Inline each finding\'s shrink.steps — every probe\'s envelope and whether it reproduced.'),
    },
  }, async ({ jobId, feature, includeLog, includeTrace }) => {
    if (jobId) {
      const resp = await request('GET', `/api/robustness/${encodeURIComponent(jobId)}`)
      if (!resp) return errorResult(UNAVAILABLE)
      if (resp.statusCode !== 200) return errorResult(`robustness job not found: ${jobId}`)
      return jobResult(resp.body as RobustnessJobManifest, includeLog, includeTrace)
    }
    if (feature) {
      const resp = await request('GET', `/api/features/${encodeURIComponent(feature)}/robustness`)
      if (!resp) return errorResult(UNAVAILABLE)
      const jobs = resp.body as RobustnessJobIndexEntry[]
      return asJsonResult({
        feature,
        jobs,
        ...(jobs.length === 0 ? { nextSteps: ['no matrix has run for this suite — start_robustness(feature) starts one from its newest passed run'] } : {}),
      })
    }
    return errorResult('Provide jobId or feature')
  })
}
