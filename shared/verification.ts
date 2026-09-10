// `run`    — the normal boot → Playwright → heal cycle.
// `verify` — observational: run tests against a deployment, never boot/heal.
// `boot`   — apply envset + boot the feature's services and hold them (no
//            Playwright, no heal) until the run is stopped, which tears the
//            services down and reverts the envset. Its RunStatus stays
//            `running` while held; the distinct identity is derived from this.
// `benchmark` — a run spawned by the benchmark (an arm or the validity-gate
//            trial). Behaves like `run`, but is hidden from the global Runs
//            list/count — it's surfaced only inside the benchmark window.
// `robustness` — one Robustness Lab cell: a single spec file booted under one
//            atom of the suite's envelope, no heal. Hidden like `benchmark`;
//            surfaced only through the robustness job that spawned it.
export type ExecutionType = 'run' | 'verify' | 'boot' | 'benchmark' | 'robustness'

/** Runs that never stand in for the suite: a boot session runs no tests, and a
 *  benchmark arm or a robustness cell runs the suite under conditions it did
 *  not ask for. Every Runs list and every "latest run" lookup skips them — one
 *  predicate so a new kind is added here, not at each of those sites. A
 *  `verify` run is NOT auxiliary: it is the suite, observed against a
 *  deployment, and the sites that also exclude it say so themselves. */
export function isAuxiliaryExecution(type: ExecutionType | undefined): boolean {
  return type === 'boot' || type === 'benchmark' || type === 'robustness'
}

export interface VerificationTarget {
  id: string
  name: string
  envVar?: string
}

export interface VerificationTargetSnapshot extends VerificationTarget {
  url: string
}

export interface VerificationConfig {
  id: string
  featureId: string
  name: string
  targetUrls: Record<string, string>
  playwrightEnvsetId: string
  createdAt: string
  updatedAt: string
}

export interface VerificationDiagnosticArtifact {
  name: string
  kind: 'screenshot' | 'trace' | 'video' | 'other'
  url: string
}

export interface VerificationDiagnosticFailedTest {
  name: string
  testFile?: string
  location?: string
  browser?: string
  targetUrl?: string
  endpoint?: string
  httpStatus?: number
  errorMessage?: string
  assertionFailure?: string
  consoleErrors?: string[]
  networkErrors?: string[]
  rawPlaywrightError?: string
  artifacts?: VerificationDiagnosticArtifact[]
}

export interface VerificationDiagnostics {
  generatedAt: string
  summary: string
  targetUrls: Record<string, string>
  failedTests: VerificationDiagnosticFailedTest[]
  rawPlaywrightOutput?: string
}

export interface VerificationRunMetadata {
  configId?: string
  configName?: string
  playwrightEnvsetId: string
  targetUrls: Record<string, string>
  targets: VerificationTargetSnapshot[]
  diagnostics?: VerificationDiagnostics
}
