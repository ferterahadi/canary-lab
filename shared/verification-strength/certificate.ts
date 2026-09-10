// The behavior certificate (D7): the evaluation export's checkable claim, as a
// file. It records which tests a run executed from which suite snapshot, what
// each test asserted and how strongly, how the run ended, which live spec edits
// the verdict never executed, and the advisory hints — then says in its own text
// what it does NOT prove. Wire types only: the server derives one in
// `apps/web-server/src/features/evaluation/logic/behavior-certificate.ts`, the
// bundled `verify-certificate.mjs` re-checks it offline, and an MCP client reads
// it through the export tools.
import type { IntegrityHint } from './hints'
import type { PredicateStrength, TestGuard, UnparsedExpectation } from './types'
import type { RobustnessCell, RobustnessJobStatus } from '../robustness/jobs'
import type { RobustnessEnvelope } from '../robustness/types'

/** `@2` adds the optional `robustness` block (D16). A `@1` certificate is the
 *  same document without it; the bundled checker reads both. */
export const BEHAVIOR_CERTIFICATE_FORMAT = 'canary-lab/behavior-certificate@2'
/** Where the certificate sits inside the export archive and beside it on disk. */
export const BEHAVIOR_CERTIFICATE_FILENAME = 'certificate.json'
/** The zero-dependency Node script bundled next to it. */
export const BEHAVIOR_CERTIFICATE_CHECKER_FILENAME = 'verify-certificate.mjs'

/** Where the certificate's spec content came from. `run-start-snapshot` is the
 *  copy the verdict executed (D9); `live-feature-dir` means no copy was
 *  available, so the hashes describe the suite as it read at export time —
 *  the certificate says so in `notProven`. */
export type CertificateSuiteSource = 'run-start-snapshot' | 'live-feature-dir' | 'none'

interface CertificateSuiteBase {
  /** sha256 over the sorted `<path>\0<sha256>\n` lines of `files` — the same
   *  digest `RunSuiteSnapshot.digest` records at run start. */
  digest: string
  /** The digest the run recorded when it took its snapshot, when it did. */
  runStartDigest?: string
  /** Whether `digest` equals `runStartDigest`: `matches` is the boundary
   *  holding; `differs` means the copy changed after the run started (an edit
   *  to the snapshot itself, which is visible but not prevented); `unverifiable`
   *  when the run recorded no digest. */
  runStartCheck: 'matches' | 'differs' | 'unverifiable'
  files: Array<{ path: string; sha256: string; bytes: number }>
}

/** `reason` exists exactly when the source is not the run-start snapshot: the
 *  union makes "not the snapshot, but no reason given" unrepresentable, so the
 *  certificate text never needs a fallback sentence for it. */
export type CertificateSuite =
  | (CertificateSuiteBase & { source: 'run-start-snapshot'; /** Absolute path the files were read from. */ dir: string })
  | (CertificateSuiteBase & { source: 'live-feature-dir'; dir: string; /** Why the source is not the run-start snapshot. */ reason: string })
  | (CertificateSuiteBase & { source: 'none'; reason: string })

export interface CertificatePredicate {
  line: number
  /** The assertion as written, whitespace collapsed — what the checker looks for. */
  source: string
  matcher: string
  target: string
  negated: boolean
  strength: PredicateStrength
}

export interface CertificateTest {
  /** Spec path relative to the suite dir; absent when the run's roster names a
   *  test the suite content does not declare. */
  file?: string
  name: string
  line?: number
  /** The run's own outcome for this test: `passed`, `failed`, `skipped`,
   *  `interrupted`, or `not run` — never derived from a count. */
  status: string
  /** `@req-*` ids the test carries. Absent when it carries none. */
  requirements?: string[]
  /** Declaration modifier (`skip`/`fixme`/`fail`/`only`) — the predicates are
   *  not enforced under the first three. Absent when none. */
  modifier?: string
  predicates: CertificatePredicate[]
  /** `expect(...)` forms the extractor could not read — visible, never counted
   *  as absent. Present only when non-empty. */
  unparsed?: UnparsedExpectation[]
  /** Run-time guards that can sit the test out. Present only when non-empty. */
  guards?: TestGuard[]
}

/** What this run says about one requirement, from its own tests only. The
 *  ledger's `proven` joins the feature's LATEST run and is deliberately not
 *  copied: a certificate for run X must not carry run Y's outcome. */
export type ClaimOutcome = 'all-passed' | 'some-failed' | 'not-run' | 'no-tests'

export interface CertificateClaim {
  requirement: {
    id: string
    /** From the feature's requirement ledger; absent when the id appears only
     *  as a test tag. */
    title?: string
    text?: string
    /** sha256 (first 16 hex) over `id\ntitle\ntext` — pins the wording this
     *  certificate was issued against. Absent without ledger wording. */
    fingerprint?: string
  }
  /** Names of this run's tests that carry the id, in roster order. */
  tests: string[]
  outcome: ClaimOutcome
}

export interface CertificateRun {
  runId: string
  feature: string
  executionType: string
  status: string
  startedAt: string
  endedAt?: string
  healCycles: number
  /** Declared roster counts, one bucket per test — `declared` is their sum. */
  counts: { declared: number; passed: number; failed: number; skipped: number; interrupted: number; notRun: number }
  /** True when the outcomes span several partial executions (a targeted heal
   *  rerun carried untouched results forward): the tests never all passed in
   *  one execution. */
  spansExecutions?: boolean
}

export interface CertificateSpecEdits {
  checkedAt: string
  /** Live edits the verdict never executed, with the differential's reading. */
  pending: Array<{ file: string; change: 'modified' | 'added' | 'deleted'; verdict?: string }>
  adopted: Array<{ at: string; by: string; files: string[] }>
}

/** One Robustness Lab finding against this run's own tests: a cell (spec file ×
 *  atom) where tests that passed green failed under perturbation. `envelope` is
 *  the smallest one known to reproduce it — the shrunk envelope when shrink ran,
 *  the cell's own when it did not. */
export interface CertificateRobustnessFinding {
  cell: RobustnessCell
  /** Titles of the tests that failed in the cell and passed in the run. */
  tests: string[]
  /** `@req-*` ids those tests carry. Absent when they carry none. */
  requirements?: string[]
  envelope: RobustnessEnvelope
  /** One line a human can act on. Absent when shrink never ran. */
  repro?: string
  /** Re-runs under `envelope` after shrinking: `reproduced` of `asked`. Absent
   *  when shrink never ran. */
  confirmations?: { asked: number; reproduced: number }
}

/** What the Robustness Lab found when it re-ran this run's spec files under the
 *  suite's perturbation envelope. Findings, never counts of passes: a cell that
 *  held leaves no record, and a cell the matrix never judged is listed under
 *  `skipped` or counted in `cells.notRun` — neither is a pass. */
export interface CertificateRobustness {
  jobId: string
  /** How the matrix ended; `notRun` below is non-zero for anything but `done`. */
  status: Exclude<RobustnessJobStatus, 'running'>
  envelope: RobustnessEnvelope
  cells: { planned: number; judged: number; notRun: number }
  /** Reproduced 3/3 under the shrunk envelope. */
  findings: CertificateRobustnessFinding[]
  /** Failed under perturbation at least once but never reproduced 3/3 —
   *  listed as such, never promoted and never dropped. */
  unconfirmed: CertificateRobustnessFinding[]
  skipped: Array<{ cell: RobustnessCell; reason: string }>
}

export interface BehaviorCertificate {
  format: typeof BEHAVIOR_CERTIFICATE_FORMAT
  issuedAt: string
  /** What this certificate proves, in the reader's language. */
  statement: string
  run: CertificateRun
  suite: CertificateSuite
  tests: CertificateTest[]
  claims: CertificateClaim[]
  /** Absent when the run had no snapshot boundary — then `notProven` says so. */
  specEdits?: CertificateSpecEdits
  /** Absent when no settled Robustness Lab matrix ran against this run — then
   *  `notProven` says so. */
  robustness?: CertificateRobustness
  hints: IntegrityHint[]
  disclosure: string
  /** What this certificate does NOT prove — always non-empty. */
  notProven: string[]
}
