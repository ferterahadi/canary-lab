export const DIAGNOSIS_POLICIES = ['per-failure', 'parent-only', 'adaptive'] as const
export type DiagnosisPolicy = typeof DIAGNOSIS_POLICIES[number]

// Parent-only beat per-failure delegation on time and tokens in every matched
// pair of the 2026-10-01 unfamiliar-repository benchmark, with equal correctness.
export const DEFAULT_DIAGNOSIS_POLICY: DiagnosisPolicy = 'parent-only'

export function diagnosisPolicy(value: unknown): DiagnosisPolicy {
  if (value === undefined) return DEFAULT_DIAGNOSIS_POLICY
  if (DIAGNOSIS_POLICIES.includes(value as DiagnosisPolicy)) return value as DiagnosisPolicy
  throw new Error(`Unsupported diagnosis policy: ${String(value)}`)
}
