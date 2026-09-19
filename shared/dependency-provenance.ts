export type DependencyVerdict = 'compatible' | 'incompatible' | 'unknown'

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
