export const DIAGNOSIS_POLICIES = ['per-failure', 'parent-only', 'adaptive'] as const
export type DiagnosisPolicy = typeof DIAGNOSIS_POLICIES[number]

export function diagnosisPolicy(value: unknown): DiagnosisPolicy {
  if (value === undefined) return 'per-failure'
  if (DIAGNOSIS_POLICIES.includes(value as DiagnosisPolicy)) return value as DiagnosisPolicy
  throw new Error(`Unsupported diagnosis policy: ${String(value)}`)
}
