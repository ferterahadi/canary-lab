// Robustness trials — the D17 mechanism gate for the Robustness Lab. Runs the
// shipped storefront suite against the shipped storefront services through the
// perturbation shim, and asks the three questions the gate is made of:
//
//   noise    100 trials of the GREEN app under the default envelope → ≤ 2 findings
//   replay   every finding replays 20/20 under the envelope it was found with
//   defects  one seeded defect per atom is found under the default envelope and
//            shrinks to a one-line repro — twice, to the same answer at the knob
//            resolution (`sameAtResolution`), each confirmed 3/3
//
// Kill criterion (D17): noise above 2/100, or a shrink that does not agree with
// itself, stops the build before 6c. The three seeded defects are the demo app's
// pre-hardening behaviours, kept as patches under `defects/`.
//
//   npx tsx tools/robustness-trials/trials.ts prepare --work <dir>
//   npx tsx tools/robustness-trials/trials.ts clean   --work <dir> [--trials 100]
//   npx tsx tools/robustness-trials/trials.ts defect  --work <dir> --name <duplicate-unkeyed|restart-in-memory|latency-timeout> [--replays 20] [--shrinks 2]
//   npx tsx tools/robustness-trials/trials.ts all     --work <dir> --out <report.json> [--trials 100] [--replays 20] [--shrinks 2]
//
// `prepare` is implied by the other commands when the work dir has no suite yet.
import fs from 'node:fs'
import path from 'node:path'
import { defaultRobustnessEnvelope } from '../../shared/robustness/envelope'
import { reproLine, sameAtResolution, shrinkEnvelope, type ShrinkResult } from '../../shared/robustness/shrink'
import type { RobustnessEnvelope } from '../../shared/robustness/types'
import { DEFECTS, SLOTS, prepareWorkdir, runTrial, seededApp, type DefectName, type Failure, type TrialResult, type Workdir } from './fixture'

const argv = process.argv.slice(2)
const command = argv[0]
const arg = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const num = (name: string, fallback: number): number => Number(arg(name, String(fallback)))

const ENVELOPE = defaultRobustnessEnvelope(SLOTS)
const NOISE_MAX = 2

interface CleanReport {
  trials: number
  /** Trials with at least one failing test — the noise the gate counts. */
  noisy: { label: string; failures: Failure[] }[]
  inconclusive: { label: string; reason: string }[]
  meanDurationMs: number
  /** One unperturbed pass first: the fixture itself must be green. */
  baseline: Failure[]
}

interface DefectReport {
  name: DefectName
  /** The seeded app must be green WITHOUT the envelope: the defect is invisible to the plain suite. */
  greenUnperturbed: boolean
  found: boolean
  discovery: Failure[]
  /** The first failing test in journey order is the finding shrink works on. */
  target?: string
  replays: { asked: number; reproduced: number }
  shrinks: ShrinkResult[]
  /** Every shrink confirmed 3/3 and every pair agrees at the knob resolution. */
  deterministic: boolean
  repro?: string
}

interface Report {
  startedAt: string
  finishedAt?: string
  envelope: RobustnessEnvelope
  clean?: CleanReport
  defects: DefectReport[]
  verdict?: { noise: boolean; replay: boolean; defects: boolean; shrink: boolean; pass: boolean }
}

function log(line: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`)
}

function workdir(): Workdir {
  const root = arg('work')
  if (!root) throw new Error('--work <dir> is required')
  const resolved = path.resolve(root)
  if (command === 'prepare' || !fs.existsSync(path.join(resolved, 'suite'))) {
    log(`preparing fixture under ${resolved}`)
    return prepareWorkdir(resolved)
  }
  return { root: resolved, suiteDir: path.join(resolved, 'suite'), greenApp: path.join(resolved, 'app-green'), stateRoot: path.join(resolved, 'state'), reportsRoot: path.join(resolved, 'reports') }
}

const summarize = (t: TrialResult) => t.inconclusive ? `INCONCLUSIVE ${t.inconclusive.split('\n')[0]}` : t.failures.length === 0 ? `green (${t.tests.length} tests, ${(t.durationMs / 1000).toFixed(1)} s)` : `${t.failures.length} failing: ${t.failures.map((f) => `${f.title.split(' — ')[0]} · ${f.error}`).join(' | ')}`

async function runClean(work: Workdir, trials: number): Promise<CleanReport> {
  const baseline = await runTrial(work, work.greenApp, undefined, 'baseline')
  log(`baseline (no envelope): ${summarize(baseline)}`)
  const noisy: CleanReport['noisy'] = []
  const inconclusive: CleanReport['inconclusive'] = []
  let total = 0
  for (let i = 1; i <= trials; i++) {
    const label = `clean-${String(i).padStart(3, '0')}`
    const t = await runTrial(work, work.greenApp, ENVELOPE, label)
    total += t.durationMs
    log(`${label}: ${summarize(t)} · shim events ${t.events.length}, restarts ${t.events.filter((e) => e.kind === 'restarted').length}`)
    if (t.inconclusive) inconclusive.push({ label, reason: t.inconclusive })
    else if (t.failures.length) noisy.push({ label, failures: t.failures })
  }
  return { trials, noisy, inconclusive, meanDurationMs: Math.round(total / Math.max(trials, 1)), baseline: baseline.failures }
}

async function runDefect(work: Workdir, name: DefectName, replays: number, shrinks: number): Promise<DefectReport> {
  const app = seededApp(work, name)
  const unperturbed = await runTrial(work, app, undefined, `${name}-unperturbed`)
  log(`${name} without envelope: ${summarize(unperturbed)}`)
  const discovery = await runTrial(work, app, ENVELOPE, `${name}-discovery`)
  log(`${name} under the default envelope: ${summarize(discovery)}`)
  const target = discovery.failures[0]?.title
  const report: DefectReport = {
    name,
    greenUnperturbed: !unperturbed.inconclusive && unperturbed.failures.length === 0,
    found: target !== undefined,
    discovery: discovery.failures,
    target,
    replays: { asked: 0, reproduced: 0 },
    shrinks: [],
    deterministic: false,
  }
  if (!target) return report

  const reproduces = async (envelope: RobustnessEnvelope, label: string) => {
    const t = await runTrial(work, app, envelope, label)
    const hit = t.failures.some((f) => f.title === target)
    log(`  ${label}: ${hit ? 'reproduced' : 'did not reproduce'} — ${reproLine(envelope)} (${(t.durationMs / 1000).toFixed(1)} s)`)
    return hit
  }
  for (let i = 1; i <= replays; i++) {
    report.replays.asked++
    if (await reproduces(ENVELOPE, `${name}-replay-${String(i).padStart(2, '0')}`)) report.replays.reproduced++
  }
  log(`${name} replays: ${report.replays.reproduced}/${report.replays.asked}`)

  for (let i = 1; i <= shrinks; i++) {
    let probe = 0
    const result = await shrinkEnvelope(ENVELOPE, (candidate) => reproduces(candidate, `${name}-shrink-${i}-probe-${String(++probe).padStart(2, '0')}`))
    log(`${name} shrink ${i}: ${result.status} in ${result.probes} probes${result.budgetExhausted ? ' (budget exhausted)' : ''} → ${result.repro}`)
    report.shrinks.push(result)
  }
  report.deterministic = report.shrinks.length > 0
    && report.shrinks.every((s) => s.status === 'confirmed')
    && report.shrinks.every((s) => sameAtResolution(s.envelope, report.shrinks[0].envelope))
  report.repro = report.shrinks[0]?.repro
  return report
}

function verdict(report: Report): NonNullable<Report['verdict']> {
  const clean = report.clean
  const noise = !!clean && clean.baseline.length === 0 && clean.inconclusive.length === 0 && clean.noisy.length <= NOISE_MAX
  const replay = report.defects.every((d) => d.replays.asked > 0 && d.replays.reproduced === d.replays.asked)
  const defects = DEFECTS.every((name) => report.defects.some((d) => d.name === name && d.greenUnperturbed && d.found))
  const shrink = report.defects.every((d) => d.deterministic)
  return { noise, replay, defects, shrink, pass: noise && replay && defects && shrink }
}

async function main(): Promise<void> {
  const work = workdir()
  const report: Report = { startedAt: new Date().toISOString(), envelope: ENVELOPE, defects: [] }
  log(`envelope: ${reproLine(ENVELOPE)}`)
  switch (command) {
    case 'prepare':
      log(`fixture ready: suite ${work.suiteDir}, green app ${work.greenApp}`)
      return
    case 'clean':
      report.clean = await runClean(work, num('trials', 100))
      break
    case 'defect': {
      const name = arg('name') as DefectName | undefined
      if (!name || !DEFECTS.includes(name)) throw new Error(`--name must be one of ${DEFECTS.join(', ')}`)
      report.defects.push(await runDefect(work, name, num('replays', 20), num('shrinks', 2)))
      break
    }
    case 'all':
      report.clean = await runClean(work, num('trials', 100))
      for (const name of DEFECTS) report.defects.push(await runDefect(work, name, num('replays', 20), num('shrinks', 2)))
      break
    default:
      throw new Error('command must be one of: prepare, clean, defect, all')
  }
  report.finishedAt = new Date().toISOString()
  if (command === 'all') report.verdict = verdict(report)
  const out = arg('out')
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
    log(`report written to ${out}`)
  }
  if (report.clean) log(`noise: ${report.clean.noisy.length}/${report.clean.trials} noisy, ${report.clean.inconclusive.length} inconclusive, mean ${(report.clean.meanDurationMs / 1000).toFixed(1)} s per trial`)
  for (const d of report.defects) log(`${d.name}: green unperturbed ${d.greenUnperturbed} · found ${d.found} · replays ${d.replays.reproduced}/${d.replays.asked} · shrink deterministic ${d.deterministic}${d.repro ? ` · repro: ${d.repro}` : ''}`)
  if (report.verdict) log(`D17 verdict: ${report.verdict.pass ? 'PASS' : 'FAIL'} — noise ${report.verdict.noise}, replay ${report.verdict.replay}, defects ${report.verdict.defects}, shrink ${report.verdict.shrink}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
