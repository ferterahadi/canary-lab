import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RunDetail } from '../../runs/logic/run-store'
import { suiteDirForReading } from '../../runs/logic/runtime/manifest'
import { digestOfSpecHashes } from '../../runs/logic/runtime/run-suite-snapshot'
import { hashFeatureSpecs } from '../../runs/logic/dirty-specs/detect'
import { testRequirementsOf } from '../../runs/logic/dirty-specs/test-requirements'
import { extractTestPredicatesFromSource, type ExtractedTestPredicates } from '../../../shared/ast-extractor'
import { strengthOf } from '../../../shared/verification-strength/lattice'
import { buildTestReviewPacket, statusBucket, NOT_RUN_STATUS, type TestReviewCase } from './test-review-export'
import { specFileOf } from './test-review/ast'
import type { CoverageLedger } from '../../../../../../shared/coverage/types'
import type { RobustnessFinding, RobustnessJobManifest } from '../../../../../../shared/robustness/jobs'
import { INTEGRITY_HINT_DISCLOSURE } from '../../../../../../shared/verification-strength/disclosure'
import {
  BEHAVIOR_CERTIFICATE_FORMAT,
  type BehaviorCertificate,
  type CertificateClaim,
  type CertificateRobustness,
  type CertificateRobustnessFinding,
  type CertificateRun,
  type CertificateSuite,
  type CertificateTest,
  type ClaimOutcome,
} from '../../../../../../shared/verification-strength/certificate'

// The behavior certificate (D7): derived from a finished run's own record and
// the suite content its verdict executed — never from an agent's account of
// either. Everything here is a re-statement of evidence that already exists
// (the manifest, the summary roster, the run-start copy, the requirement
// ledger); the certificate adds the checkable frame around it and says, in its
// own words, what that frame does not cover. Written by the evaluation export
// path, so it rides the same archive as `evaluation.html`.

export interface BuildBehaviorCertificateOptions {
  /** The feature's requirement ledger, when the export attached one. Wording
   *  only: the ledger's `proven` joins the LATEST run and is not this run's. */
  coverage?: CoverageLedger
  /** The settled Robustness Lab job built from THIS run, when one exists. A
   *  running job is not evidence yet and is passed as absent; `null` is the
   *  store's own "no record" and reads the same way. */
  robustness?: RobustnessJobManifest | null
  now?: () => string
}

export function buildBehaviorCertificate(detail: RunDetail, options: BuildBehaviorCertificateOptions = {}): BehaviorCertificate {
  const manifest = detail.manifest
  const packet = buildTestReviewPacket(detail)
  const suiteDir = suiteDirForReading(manifest)
  const suite = certifySuite(manifest.suiteSnapshot, suiteDir)
  const extracted = suiteDir ? extractSuite(suiteDir) : new Map<string, ExtractedSpec>()
  const tests = certifyTests(packet.tests, suiteDir, extracted)
  const claims = certifyClaims(tests, options.coverage)
  const robustness = options.robustness ? certifyRobustness(options.robustness) : undefined
  const notProven = notProvenBy(suite, manifest.specEdits !== undefined, options.coverage !== undefined, packet.tests, detail, robustness)
  const run = certifyRun(detail, tests)
  return {
    format: BEHAVIOR_CERTIFICATE_FORMAT,
    issuedAt: (options.now ?? (() => new Date().toISOString()))(),
    statement: statementFor(run, suite, robustness),
    run,
    suite,
    tests,
    claims,
    ...(manifest.specEdits
      ? {
          specEdits: {
            checkedAt: manifest.specEdits.checkedAt,
            pending: manifest.specEdits.pending.map((edit) => ({
              file: edit.file,
              change: edit.change,
              ...(edit.strength ? { verdict: edit.strength.verdict } : {}),
            })),
            adopted: manifest.specEdits.adopted,
          },
        }
      : {}),
    ...(robustness ? { robustness } : {}),
    hints: manifest.integrity?.hints ?? [],
    disclosure: manifest.integrity?.disclosure ?? INTEGRITY_HINT_DISCLOSURE,
    notProven,
  }
}

/** The job record re-stated for the certificate: findings split by whether
 *  they reproduced 3/3, the trace and the driver log left behind. `judged` is
 *  what the matrix actually ran to a verdict; the matrix's own `done` counter
 *  advances on a skipped cell too, so skipped cells are subtracted here. */
function certifyRobustness(job: RobustnessJobManifest): CertificateRobustness {
  if (job.status === 'running') throw new Error(`robustness job ${job.jobId} is still running and cannot be certified`)
  const finding = (f: RobustnessFinding): CertificateRobustnessFinding => ({
    cell: f.cell,
    tests: f.failedTests,
    ...(f.requirements.length > 0 ? { requirements: f.requirements } : {}),
    envelope: f.shrink?.envelope ?? f.envelope,
    ...(f.shrink ? { repro: f.shrink.repro, confirmations: f.shrink.confirmations } : {}),
  })
  const judged = job.cells.done - job.skipped.length
  return {
    jobId: job.jobId,
    status: job.status,
    envelope: job.envelope,
    cells: { planned: job.cells.planned, judged, notRun: job.cells.planned - judged },
    findings: job.findings.filter((f) => f.status === 'confirmed').map(finding),
    // `found` and `shrinking` only survive in a job that stopped early: the
    // failure happened once and was never confirmed — unconfirmed, by definition.
    unconfirmed: job.findings.filter((f) => f.status !== 'confirmed').map(finding),
    skipped: job.skipped.map((s) => ({ cell: s.cell, reason: s.reason })),
  }
}

function certifyRun(detail: RunDetail, tests: CertificateTest[]): CertificateRun {
  const counts = { declared: tests.length, passed: 0, failed: 0, skipped: 0, interrupted: 0, notRun: 0 }
  for (const test of tests) counts[statusBucket(test.status)] += 1
  const manifest = detail.manifest
  return {
    runId: detail.runId,
    feature: manifest.feature,
    executionType: manifest.executionType ?? 'run',
    status: manifest.status,
    startedAt: manifest.startedAt,
    ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
    healCycles: manifest.healCycles,
    counts,
    ...(detail.summary?.mergedFromPriorExecution ? { spansExecutions: true } : {}),
  }
}

function certifySuite(snapshot: RunDetail['manifest']['suiteSnapshot'], suiteDir: string | undefined): CertificateSuite {
  if (!suiteDir || !fs.existsSync(suiteDir)) {
    return { source: 'none', digest: digestOfSpecHashes({}), runStartCheck: 'unverifiable', reason: 'the run recorded no readable suite directory', files: [] }
  }
  const hashes = hashFeatureSpecs(suiteDir)
  const files = Object.keys(hashes).sort().map((rel) => ({
    path: rel,
    sha256: hashes[rel],
    bytes: fs.statSync(path.join(suiteDir, rel)).size,
  }))
  const digest = digestOfSpecHashes(hashes)
  const runStartDigest = snapshot?.kind === 'taken' ? snapshot.digest : undefined
  const base = {
    dir: suiteDir,
    digest,
    ...(runStartDigest ? { runStartDigest } : {}),
    runStartCheck: runStartDigest ? (runStartDigest === digest ? 'matches' : 'differs') : 'unverifiable',
    files,
  } as const
  if (snapshot?.kind === 'taken' && snapshot.dir === suiteDir) return { source: 'run-start-snapshot', ...base }
  return { source: 'live-feature-dir', reason: liveDirReason(snapshot), ...base }
}

function liveDirReason(snapshot: RunDetail['manifest']['suiteSnapshot']): string {
  if (!snapshot) return 'the run was recorded before the run-start snapshot boundary existed'
  if (snapshot.kind === 'unavailable') return `the run-start snapshot failed (${snapshot.reason}); the run executed the live suite`
  return 'the run-start snapshot directory no longer exists; the live suite was read instead'
}


interface ExtractedSpec {
  tests: ExtractedTestPredicates[]
  requirements: Map<string, string[] | undefined>
}

/** Every spec in the suite dir, parsed once: its tests' predicates and the
 *  `@req-*` ids each test carries — the same two extractors the run's own
 *  integrity hints use, so a certificate never reads a spec differently. */
function extractSuite(suiteDir: string): Map<string, ExtractedSpec> {
  const out = new Map<string, ExtractedSpec>()
  for (const rel of Object.keys(hashFeatureSpecs(suiteDir)).sort()) {
    const source = fs.readFileSync(path.join(suiteDir, rel), 'utf8')
    out.set(rel, {
      tests: extractTestPredicatesFromSource(rel, source).tests,
      requirements: testRequirementsOf(rel, source),
    })
  }
  return out
}

function certifyTests(roster: TestReviewCase[], suiteDir: string | undefined, extracted: Map<string, ExtractedSpec>): CertificateTest[] {
  const claimed = new Set<string>()
  const tests = roster.map((entry) => {
    const located = locateTest(entry, suiteDir, extracted)
    if (located) claimed.add(`${located.file}::${located.test.name}`)
    return certifyTest(entry.title, entry.status, located, extracted)
  })
  // A test the suite declares but the run's roster never listed is still part
  // of what the suite content says — listed as not run, which is what it was.
  for (const [file, spec] of extracted) {
    for (const test of spec.tests) {
      if (claimed.has(`${file}::${test.name}`)) continue
      tests.push(certifyTest(test.name, NOT_RUN_STATUS, { file, test }, extracted))
    }
  }
  return tests
}

interface LocatedTest {
  file: string
  test: ExtractedTestPredicates
}

/** The roster's location names the file the test ran from; inside that file the
 *  title picks the declaration. A roster entry with no location (a summary-only
 *  pass) or one whose file is not in the suite is matched by title across the
 *  suite when exactly one test carries it — otherwise it stays unlocated rather
 *  than guessed. */
function locateTest(entry: TestReviewCase, suiteDir: string | undefined, extracted: Map<string, ExtractedSpec>): LocatedTest | undefined {
  if (entry.location && suiteDir) {
    const rel = path.relative(suiteDir, specFileOf(entry.location))
    const spec = extracted.get(rel)
    const test = spec?.tests.find((candidate) => candidate.name === entry.title)
    if (test) return { file: rel, test }
  }
  const byTitle: LocatedTest[] = []
  for (const [file, spec] of extracted) {
    for (const test of spec.tests) if (test.name === entry.title) byTitle.push({ file, test })
  }
  return byTitle.length === 1 ? byTitle[0] : undefined
}

function certifyTest(name: string, status: string, located: LocatedTest | undefined, extracted: Map<string, ExtractedSpec>): CertificateTest {
  if (!located) return { name, status, predicates: [] }
  const { file, test } = located
  const requirements = extracted.get(file)?.requirements.get(test.name)
  return {
    file,
    name,
    line: test.line,
    status,
    ...(requirements?.length ? { requirements } : {}),
    ...(test.modifier ? { modifier: test.modifier } : {}),
    predicates: test.predicates.map((predicate) => ({
      line: predicate.line,
      source: predicate.source,
      matcher: predicate.matcher,
      target: predicate.target,
      negated: predicate.negated,
      strength: strengthOf(predicate),
    })),
    ...(test.unparsed ? { unparsed: test.unparsed } : {}),
    ...(test.guards ? { guards: test.guards } : {}),
  }
}

function certifyClaims(tests: CertificateTest[], coverage: CoverageLedger | undefined): CertificateClaim[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const requirement of coverage?.requirements ?? []) add(requirement.requirement.id)
  for (const test of tests) for (const id of test.requirements ?? []) add(id)
  return ids.map((id) => {
    const wording = coverage?.requirements.find((entry) => entry.requirement.id === id)?.requirement
    const carriers = tests.filter((test) => test.requirements?.includes(id))
    return {
      requirement: {
        id,
        ...(wording
          ? { title: wording.title, text: wording.text, fingerprint: requirementFingerprint(id, wording.title, wording.text) }
          : {}),
      },
      tests: carriers.map((test) => test.name),
      outcome: claimOutcome(carriers),
    }
  })
}

function claimOutcome(carriers: CertificateTest[]): ClaimOutcome {
  if (carriers.length === 0) return 'no-tests'
  const buckets = carriers.map((test) => statusBucket(test.status))
  if (buckets.some((bucket) => bucket === 'failed' || bucket === 'interrupted')) return 'some-failed'
  if (buckets.every((bucket) => bucket === 'passed')) return 'all-passed'
  return 'not-run'
}

/** Pins the wording a claim was issued against; Phase 5's acceptance records
 *  the same fingerprint, so an accepted requirement and a certified one can be
 *  compared by value. */
export function requirementFingerprint(id: string, title: string, text: string): string {
  return createHash('sha256').update(`${id}\n${title}\n${text}`).digest('hex').slice(0, 16)
}

function statementFor(run: CertificateRun, suite: CertificateSuite, robustness: CertificateRobustness | undefined): string {
  const from = suite.source === 'run-start-snapshot'
    ? `the suite snapshot taken at run start (digest ${suite.digest.slice(0, 16)}…)`
    : suite.source === 'live-feature-dir'
      ? `the live suite directory as it read when this certificate was issued (digest ${suite.digest.slice(0, 16)}…)`
      : 'a suite directory this certificate could not read'
  const { counts } = run
  const base = `Canary Lab ran ${counts.declared} declared test${counts.declared === 1 ? '' : 's'} for run ${run.runId} of "${run.feature}" from ${from}: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.interrupted} interrupted, ${counts.notRun} never run; the run ended ${run.status}. Each test below is listed with the assertions it enforced, as written in that suite. Counts come from the harness's own result lines — a test the run never reached is listed as not run, never as passed.`
  if (!robustness) return base
  const { cells, findings, unconfirmed } = robustness
  return `${base} The Robustness Lab then re-ran the same spec files under the suite's perturbation envelope: ${cells.judged} of ${cells.planned} cell${cells.planned === 1 ? '' : 's'} judged, ${findings.length} finding${findings.length === 1 ? '' : 's'} confirmed by reproducing under the shrunk envelope, ${unconfirmed.length} unconfirmed. A finding names tests that passed here and failed under the fault; a cell that held leaves no record.`
}

function notProvenBy(
  suite: CertificateSuite,
  hasBoundary: boolean,
  hasLedger: boolean,
  roster: TestReviewCase[],
  detail: RunDetail,
  robustness: CertificateRobustness | undefined,
): string[] {
  const out = [
    'The absence of weakening. An agent can weaken a suite by means the differential does not model — deleting a test, narrowing a fixture, changing test data — and a human can adopt a weaker edit. The hints below are advisory; they were checked by AI, not by a human, and they never changed this verdict.',
    'That the requirement set is complete. This certificate lists the requirements the suite claims; whether the product needed more is answered by coverage, separately.',
    'Anything the listed assertions did not observe. Only the Playwright checks written in these tests are certified; API, state and log planes are proven only where a listed assertion reached them.',
  ]
  if (suite.source !== 'run-start-snapshot') {
    out.push(`Which suite content the run executed. ${suite.reason} — the file hashes describe the suite as read, not necessarily as run.`)
  } else if (suite.runStartCheck === 'differs') {
    out.push('That the snapshot is what ran: its digest differs from the digest recorded at run start, so the copy was edited after the run began. The snapshot is visible evidence, not a security boundary.')
  }
  if (!hasBoundary) out.push('Which live spec edits the verdict never executed. The run recorded no snapshot boundary, so pending edits could not be measured.')
  if (!hasLedger) out.push('The requirements’ wording. No requirement ledger was attached, so claims carry ids from test tags only, with no title or text to fingerprint.')
  if (detail.summary?.mergedFromPriorExecution) out.push('That every test passed in one execution. The outcomes span several partial executions — a targeted heal rerun carried untouched results forward.')
  if (roster.some((test) => test.status === NOT_RUN_STATUS)) out.push('Anything about the tests marked not run. The run stopped before reaching them; they are listed so the count stays honest, not as passes.')
  out.push(...robustnessNotProven(robustness))
  return out
}

/** The perturbation axis is certified only as far as a matrix ran: none at all,
 *  or planned cells it never judged, are named with the count — "robustness:
 *  <n> cells not run" is the line a reader greps for. */
function robustnessNotProven(robustness: CertificateRobustness | undefined): string[] {
  if (!robustness) {
    return ['Behaviour under perturbation. No Robustness Lab matrix ran against this run, so nothing here speaks to these tests under added latency, duplicated writes or service restarts.']
  }
  const out: string[] = []
  const { cells, unconfirmed, skipped, status } = robustness
  if (cells.notRun > 0) {
    const why = status === 'done'
      ? `${skipped.length} skipped (see robustness.skipped for each reason)`
      : `the matrix ended ${status} after ${cells.judged} judged${skipped.length > 0 ? `, ${skipped.length} more skipped` : ''}`
    out.push(`robustness: ${cells.notRun} cell${cells.notRun === 1 ? '' : 's'} not run — ${why}. A cell the matrix never judged is not a pass.`)
  }
  if (unconfirmed.length > 0) {
    out.push(`That the ${unconfirmed.length} unconfirmed robustness finding${unconfirmed.length === 1 ? '' : 's'} ${unconfirmed.length === 1 ? 'is a defect' : 'are defects'}. Each failed under perturbation at least once and did not reproduce 3/3 under its shrunk envelope; listed as unconfirmed, counted as neither a defect nor a pass.`)
  }
  out.push('Behaviour outside the certified envelope. Only the atoms in robustness.envelope were exercised, at the knobs recorded there and through a proxy on the suite\'s declared port slots; a tighter envelope, a different fault, or a service without a slot was not tested.')
  return out
}
