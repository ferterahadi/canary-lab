import path from 'node:path'
import fs from 'node:fs'
import { json, write } from './files'
import type { StudyManifest } from './types'
import { pairedInterval } from './design'
import { summarizeVariants, variantOverview } from './variant-report'

import { totalTokens } from './usage'
const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
export function summarize(manifest: StudyManifest) {
  if (manifest.design?.variants) return []
  return (['codex', 'claude'] as const).flatMap((agent) => [...new Set(manifest.attempts.map((attempt) => attempt.scenario))].map((scenario) => {
    const rows = manifest.results.filter((row) => row.agent === agent && row.scenario === scenario)
    const workflows = (['canary', 'plain'] as const).map((workflow) => {
      const attempts = rows.filter((row) => row.workflow === workflow)
      return { workflow, recorded: attempts.length, successes: attempts.filter((row) => row.outcome === 'success').length,
        totalTokens: attempts.length && attempts.every((row) => totalTokens(agent, row.usage) !== null) ? attempts.reduce((sum, row) => sum + totalTokens(agent, row.usage)!, 0) : null,
        totalRepairMs: attempts.length && attempts.every((row) => row.repairMs !== null) ? attempts.reduce((sum, row) => sum + row.repairMs!, 0) : null,
        usageKnown: attempts.filter((row) => row.usage !== null).length }
    })
    const pairs = [...new Set(manifest.attempts.filter((row) => row.agent === agent && row.scenario === scenario).map((row) => row.repetition))].sort((a, b) => a - b).map((repetition) => {
      const a = rows.find((row) => row.repetition === repetition && row.workflow === 'canary')
      const b = rows.find((row) => row.repetition === repetition && row.workflow === 'plain')
      const aTime = a?.repairMs; const bTime = b?.repairMs
      const timeReductionPercent = a?.outcome === 'success' && b?.outcome === 'success' && typeof aTime === 'number' && typeof bTime === 'number' && bTime > 0
        ? (bTime - aTime) / bTime * 100 : null
      return { repetition, canary: a?.outcome ?? 'pending', plain: b?.outcome ?? 'pending',
        timeReductionPercent }
    })
    const successfulPairs = pairs.flatMap((pair) => {
      if (pair.timeReductionPercent === null) return []
      return [{ canaryMs: rows.find((r) => r.repetition === pair.repetition && r.workflow === 'canary')!.repairMs!,
        plainMs: rows.find((r) => r.repetition === pair.repetition && r.workflow === 'plain')!.repairMs! }]
    })
    return { agent, scenario, workflows, pairs, interval: pairedInterval(successfulPairs, manifest.design?.seed ?? 1) }
  })).filter((group) => manifest.attempts.some((attempt) => attempt.agent === group.agent && attempt.scenario === group.scenario))
}
const seconds = (ms: number | null | undefined): string => ms === null || ms === undefined ? 'unknown' : (ms / 1000).toFixed(3)

export function report(manifest: StudyManifest): void {
  const summary = summarize(manifest)
  const replay = manifest.design?.mode === 'replay'
  const experiment = replay ? 'Scripted local overhead replay (no cloud model)' : manifest.repository ? 'Repository repair study (trusted container checks)' : 'Live repair study'
  const preamble = `${experiment}: ${manifest.results.length}/${manifest.attempts.length} attempts recorded. ${manifest.design?.repetitions ?? 2} repetitions per agent/scenario; ${manifest.design ? `balanced randomized ${manifest.design.variants ? 'variant blocks' : 'pairs'}, seed ${manifest.design.seed}` : 'legacy alternating order'}; no general superiority claim. Preparation: ${(manifest.preparationMs / 1000).toFixed(1)} seconds. Missing usage and test-execution counts are unknown, not zero. Dollar cost and onboarding value are unmeasured. Human intervention is zero for unattended attempts; interruptions are reported separately.`
  const rows = manifest.attempts.map((attempt) => {
    const result = manifest.results.find((row) => row.id === attempt.id)
    return [replay ? 'scripted' : attempt.agent, attempt.scenario, String(attempt.repetition), attempt.variant ? `${attempt.workflow}/${attempt.variant.id}` : attempt.workflow, result?.outcome ?? 'pending',
      result && result.repairMs !== null ? (result.repairMs / 1000).toFixed(1) : 'unknown', result ? (result.verificationMs / 1000).toFixed(1) : '—',
      result?.testExecutions === null || result?.testExecutions === undefined ? 'unknown' : String(result.testExecutions), result?.usage ? `${result.usage.input}/${result.usage.output}` : 'unknown',
      result?.usage ? `${result.usage.cacheRead ?? 'unknown'}/${result.usage.cacheWrite ?? 'unknown'}` : 'unknown',
      result?.telemetry?.requestEvents?.toString() ?? 'unknown', result?.telemetry?.retryEvents?.toString() ?? 'unknown',
      result?.telemetry?.errorEvents?.toString() ?? 'unknown',
      seconds(result?.telemetry?.requestDurationMs),
      seconds(result?.telemetry?.streamDurationMs),
      seconds(result?.telemetry?.toolDurationMs),
      result?.telemetry ? `${result.telemetry.status}; rejected batches ${result.telemetry.rejectedBatches}` : 'unavailable',
      seconds(result?.timing?.independentVerdictMs), result?.adherence?.status ?? 'unknown',
      result?.attribution ? result.attribution.sessions.map((session) => `${session.role}:${session.sessionId}`).join(', ') : 'unknown',
      result?.reason ?? 'Not attempted']
  })
  const headings = ['Agent', 'Scenario', 'Repeat', 'Workflow', 'Outcome', 'Repair seconds', 'Verify seconds', manifest.repository ? 'Completed trusted checks' : 'Observed test launches', 'Input/output tokens', 'Cache read/write tokens', 'Observed request events', 'Observed retry-marked events', 'Observed request errors', 'Request duration sum (s)', 'Stream duration sum (s)', 'Tool duration sum (s)', 'Telemetry status', 'Time to independent verdict (s)', 'Policy adherence', 'Session roles', 'Evidence / reason']
  const artifacts = manifest.attempts.map((attempt) => [
    ['Receipt', `receipts/${attempt.id}.json`], ['Patch', `receipts/${attempt.id}.patch`],
    ['Transcript', `attempts/${attempt.id}/session-events.json`], ['Attempt', `attempts/${attempt.id}/`],
    ['Evaluator', `evaluation/${attempt.id}/verdict.json`],
    ['Telemetry', `attempts/${attempt.id}/telemetry-summary.json`], ['Telemetry events', `attempts/${attempt.id}/telemetry-events.jsonl`],
    ['Usage breakdown', `attempts/${attempt.id}/usage-breakdown.json`], ['Evidence audit', `receipts/${attempt.id}.audit.json`],
    ['Stage boundaries', `attempts/${attempt.id}/stage-events.jsonl`], ['Prompt receipts', `attempts/${attempt.id}/prompts/`],
    ['Policy adherence', `attempts/${attempt.id}/policy-adherence.json`],
  ].filter(([, file]) => fs.existsSync(path.join(manifest.root, file))))
  const totals = summary.flatMap((group) => group.workflows.map((w) => `| ${replay ? 'scripted' : group.agent} | ${group.scenario} | ${w.workflow} | ${w.successes}/${w.recorded} | ${w.totalRepairMs === null ? 'unknown' : (w.totalRepairMs / 1000).toFixed(1)} | ${w.totalTokens ?? 'unknown'} |`)).join('\n')
  const intervals = summary.map((group) => {
    const stat = group.interval
    return `- ${replay ? 'scripted' : group.agent} / ${group.scenario}: ${stat ? `${stat.pairs}/${group.pairs.length} successful pairs; ${stat.reductionPercent.toFixed(1)}% less Canary time; ${stat.bootstrap95 ? `95% paired bootstrap interval ${stat.bootstrap95.map((n) => n.toFixed(1)).join(' to ')}%` : 'interval unavailable (fewer than five successful pairs)'}` : 'no comparable successful pairs'}.`
  }).join('\n')
  const overview = manifest.design?.variants ? variantOverview(manifest) : `\n\n## Totals including unsuccessful attempts\n\n| Agent | Scenario | Workflow | Verified / recorded | Elapsed seconds | Tokens including cache |\n| --- | --- | --- | --- | --- | --- |\n${totals}\n\n## Paired uncertainty\n\n${intervals}\n\nIntervals resample complete successful pairs (5,000 resamples); they exclude failed pairs, are exploratory, and do not establish general superiority. Pending attempts are not zero-cost observations.\n`
  const md = `# Canary repair study\n\n${preamble}\n\n${manifest.stopReason ? `Stopped: ${manifest.stopReason}\n\n` : ''}` +
    overview + `\n## Attempts\n\n| ${headings.join(' | ')} |\n| ${headings.map(() => '---').join(' | ')} |\n` + rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`).join('\n') +
    '\n\n## Paired results\n\n' + summary.map((group) => `- **${replay ? 'scripted' : group.agent} / ${group.scenario}:** ${group.workflows.map((w) => `${w.workflow} ${w.successes}/${w.recorded} verified successes, usage ${w.usageKnown}/${w.recorded}`).join('; ')}. ${group.pairs.map((pair) => `Repeat ${pair.repetition}: ${pair.timeReductionPercent === null ? 'no comparable successful pair' : `${pair.timeReductionPercent.toFixed(1)}% less Canary repair time`}`).join('; ')}.`).join('\n') +
    `\n\n## Interpretation\n\n${replay ? 'Replay measures a fixed failing-test → known application patch → passing-test workflow. No model requests or diagnosis occur; these results cannot rank repair intelligence or be pooled with live repairs.' : 'Telemetry is observed CLI export evidence, not a complete network trace. Request time includes model computation and provider queues; Codex request events may cover connection/headers with streaming recorded separately. Duration sums may overlap across delegated work and tools; never subtract them from elapsed time or call the remainder local overhead. Retry-marked events are not a verified count of all retries. Missing exports, killed agents and unsupported versions leave measurements incomplete.'}\n\nToken totals include input and output; Claude cache read/write fields are added, while Codex cached input is already included. They are not dollar cost. Native session evidence remains authoritative for tokens.\n\nA 20% improvement is a practical target, not statistical significance. Compare time only alongside verified success; failed, interrupted, contaminated, and infrastructure attempts remain visible. Do not pool agents. Differences suggest follow-up questions; this experiment does not isolate which Canary capability caused them. Review transcripts, patches, and independent evaluator receipts before forming a causal explanation.\n` +
    '\n## Evidence\n\n' + artifacts.map((links, index) => links.length ? `- ${manifest.attempts[index].id}: ${links.map(([label, file]) => `[${label}](${file})`).join(' · ')}` : '').filter(Boolean).join('\n') + '\n'
  json(path.join(manifest.root, 'report.json'), { manifest, summary, variants: summarizeVariants(manifest) })
  write(path.join(manifest.root, 'report.md'), md)
  const table = `<table><thead><tr>${[...headings, 'Artifacts'].map((heading) => `<th>${escape(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, index) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}<td>${artifacts[index].map(([label, file]) => `<a href="${escape(file)}">${label}</a>`).join(' · ') || 'No artifacts yet'}</td></tr>`).join('')}</tbody></table>`
  write(path.join(manifest.root, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Canary repair study</title><style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui;margin:32px;max-width:1600px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid GrayText;padding:10px;text-align:left;vertical-align:top}a{color:LinkText}.scroll{overflow:auto}pre{white-space:pre-wrap}h1{font-size:26px}</style><h1>Canary repair study</h1><p>${escape(preamble)}</p><pre>${escape(overview)}</pre><div class="scroll">${table}</div><h2>Paired results and interpretation</h2><pre>${escape(md.slice(md.indexOf('## Paired results')))}</pre></html>`)
}
