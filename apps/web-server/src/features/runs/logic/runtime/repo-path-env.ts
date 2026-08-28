import path from 'path'
import { REPO_PATH_OVERRIDES_ENV } from '../../../../../../../shared/e2e-runner/repo-path-overrides'

export const REPO_PATH_PRELOAD_PATH = path.resolve(
  __dirname,
  '../../../../../../../shared/e2e-runner/repo-path-preload.js',
)

/** Environment shared by Playwright and its repair agent. The preload covers
 * existing specs that load feature.config.cjs themselves; newly authored specs
 * can also call resolveRunRepoPath explicitly. */
export function repoPathOverrideEnv(
  overrides: Readonly<Record<string, string>>,
  existingNodeOptions: string | undefined = process.env.NODE_OPTIONS,
): Record<string, string> {
  if (Object.keys(overrides).length === 0) return {}
  const preload = `--require ${JSON.stringify(REPO_PATH_PRELOAD_PATH)}`
  return {
    [REPO_PATH_OVERRIDES_ENV]: JSON.stringify(overrides),
    NODE_OPTIONS: existingNodeOptions?.trim()
      ? `${existingNodeOptions.trim()} ${preload}`
      : preload,
  }
}
