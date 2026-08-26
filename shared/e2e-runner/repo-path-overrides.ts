export const REPO_PATH_OVERRIDES_ENV = 'CANARY_LAB_REPO_PATH_OVERRIDES'

export function parseRepoPathOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].length > 0),
  )
}

/** Resolve a feature-config repo path to this run's isolated checkout.
 * Direct Playwright use has no override, so authored specs keep working outside
 * Canary Lab. */
export function resolveRunRepoPath(
  repoName: string,
  configuredPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return parseRepoPathOverrides(env[REPO_PATH_OVERRIDES_ENV])[repoName] ?? configuredPath
}

interface ConfigRepo {
  name?: unknown
  localPath?: unknown
  [key: string]: unknown
}

interface FeatureConfigLike {
  repos?: unknown
  [key: string]: unknown
}

function overrideConfigRepos(value: unknown, overrides: Readonly<Record<string, string>>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const config = value as FeatureConfigLike
  if (!Array.isArray(config.repos)) return value
  return {
    ...config,
    repos: config.repos.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
      const repo = candidate as ConfigRepo
      const override = typeof repo.name === 'string' ? overrides[repo.name] : undefined
      return override ? { ...repo, localPath: override } : repo
    }),
  }
}

/** Clone the common CJS feature-config export shapes while replacing only
 * repo local paths. The original cached module remains untouched. */
export function applyRepoPathOverridesToFeatureConfig(
  moduleExports: unknown,
  overrides: Readonly<Record<string, string>>,
): unknown {
  if (!moduleExports || typeof moduleExports !== 'object' || Array.isArray(moduleExports)) {
    return moduleExports
  }
  const root = moduleExports as Record<string, unknown>
  if ('config' in root) return { ...root, config: overrideConfigRepos(root.config, overrides) }
  if ('default' in root) return { ...root, default: overrideConfigRepos(root.default, overrides) }
  return overrideConfigRepos(root, overrides)
}
