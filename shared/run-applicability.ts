/** Only reporter-observed skips with a declaration captured before execution
 * may settle a test for another environment. Ordinary skips stay incomplete. */
export interface EnvironmentExclusion {
  id: string
  name: string
  environment: string
  environments: string[]
}

export interface ApplicabilitySummary {
  environment?: unknown
  environmentExclusions?: unknown
  skippedNames?: unknown
  skippedIds?: unknown
  knownTests?: unknown
  failed?: Array<{ name?: unknown; id?: unknown }>
}

export function environmentExclusions(summary: ApplicabilitySummary): EnvironmentExclusion[] {
  if (typeof summary.environment !== 'string' || !summary.environment) return []
  const skippedNames = new Set(Array.isArray(summary.skippedNames) ? summary.skippedNames : [])
  const skippedIds = new Set(Array.isArray(summary.skippedIds) ? summary.skippedIds : [])
  const failed = Array.isArray(summary.failed) ? summary.failed : []
  const failedNames = new Set(failed.map((test) => test?.name))
  const failedIds = new Set(failed.map((test) => test?.id))
  const known = Array.isArray(summary.knownTests) ? summary.knownTests : []
  const seen = new Set<string>()
  return (Array.isArray(summary.environmentExclusions) ? summary.environmentExclusions : []).filter((entry): entry is EnvironmentExclusion => {
    if (!entry || typeof entry !== 'object') return false
    const { id, name, environment, environments } = entry
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || seen.has(id)) return false
    if (environment !== summary.environment || !Array.isArray(environments) || environments.length === 0) return false
    if (!environments.every((env: unknown) => typeof env === 'string' && env.length > 0) || environments.includes(environment)) return false
    if (!skippedNames.has(name) || !skippedIds.has(id) || failedNames.has(name) || failedIds.has(id)) return false
    const matches = known.filter((test) => test?.name === name)
    if (matches.length !== 1 || matches[0].id !== id) return false
    seen.add(id)
    return true
  })
}

/** The annotation is part of the frozen suite, not an explanation invented
 * after a failure. Multiple declarations are ambiguous and fail closed. */
export function declaredEnvironments(annotations: readonly { type: string; description?: string }[]): string[] {
  const declarations = annotations.filter((annotation) => annotation.type === 'canary:environments')
  if (declarations.length !== 1) return []
  try {
    const parsed: unknown = JSON.parse(declarations[0].description ?? '')
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((env) => typeof env === 'string' && env.trim() === env && env.length > 0)
      ? [...new Set(parsed)] : []
  } catch {
    return [] // Invalid applicability declarations must never excuse a skipped test.
  }
}
