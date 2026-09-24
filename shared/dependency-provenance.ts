export type DependencyVerdict = 'compatible' | 'incompatible' | 'unknown'

export type DependencyIncompatibilityCause =
  | 'shared-prepare-command'
  | 'prepare-failed'
  | 'validation-failed'
  | 'isolated-dependencies-required'
  | 'lockfile-mismatch'
  | 'generator-input-mismatch'
  | 'configuration-invalid'

const INCOMPATIBILITY_REASONS: Record<DependencyIncompatibilityCause, string> = {
  'shared-prepare-command': 'A prepare command cannot safely mutate shared dependencies.',
  'prepare-failed': 'The dependency prepare command failed.',
  'validation-failed': 'The dependency validation command failed.',
  'isolated-dependencies-required': 'Isolated mode requires dependencies inside this worktree.',
  'lockfile-mismatch': 'The worktree and dependency-owning checkout have different lockfiles.',
  'generator-input-mismatch': 'The worktree and dependency-owning checkout have different generator inputs; generated output compatibility is unproven.',
  'configuration-invalid': 'The dependency preparation configuration is missing or invalid.',
}

export function dependencyIncompatibilityReason(provenance: RunDependencyProvenance): string {
  return provenance.incompatibilityCause
    ? INCOMPATIBILITY_REASONS[provenance.incompatibilityCause]
    : 'Dependency preflight rejected this repository.'
}

export interface DependencyFingerprint {
  path: string
  sha256: string | null
}

/** Non-secret preparation evidence persisted before any service is spawned. */
export interface RunDependencyProvenance {
  repoName: string
  sourceRevision: string | null
  sourcePath: string
  worktreePath: string
  dependencyPath: string | null
  dependencyRealPath: string | null
  lockfile: DependencyFingerprint | null
  dependencyLockfile: DependencyFingerprint | null
  generatorInputs: DependencyFingerprint[]
  dependencyGeneratorInputs: DependencyFingerprint[]
  runtime: { node: string; packageManager: string | null }
  mode: 'shared' | 'isolated'
  verdict: DependencyVerdict
  /** Absent on historical records created before fresh boot preflights. */
  checkedAt?: string
  incompatibilityCause?: DependencyIncompatibilityCause
  validation?: {
    command: string
    cwd: string
    exitCode: number | null
    signal: string | null
    logPath: string
  }
  warning?: string
  remediation?: string
}
