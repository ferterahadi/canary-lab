export function normalizeEnvironmentName(env: string): string {
  const clean = env.trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) throw new Error(`invalid env name: ${env}`)
  return clean
}

export function normalizeEnvironmentNames(envs: string[] | undefined): string[] {
  const clean = (envs ?? []).filter((env) => env.trim()).map(normalizeEnvironmentName)
  return clean.length > 0 ? [...new Set(clean)] : ['local']
}
