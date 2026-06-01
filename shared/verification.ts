// `run`    — the normal boot → Playwright → heal cycle.
// `verify` — observational: run tests against a deployment, never boot/heal.
// `boot`   — apply envset + boot the feature's services and hold them (no
//            Playwright, no heal) until the run is stopped, which tears the
//            services down and reverts the envset. Its RunStatus stays
//            `running` while held; the distinct identity is derived from this.
export type ExecutionType = 'run' | 'verify' | 'boot'

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
