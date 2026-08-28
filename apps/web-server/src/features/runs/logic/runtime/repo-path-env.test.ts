import { describe, expect, it } from 'vitest'
import { REPO_PATH_OVERRIDES_ENV } from '../../../../../../../shared/e2e-runner/repo-path-overrides'
import { REPO_PATH_PRELOAD_PATH, repoPathOverrideEnv } from './repo-path-env'

describe('repoPathOverrideEnv', () => {
  it('injects the worktree map and appends the preload to existing Node options', () => {
    expect(repoPathOverrideEnv({ app: '/worktree/app' }, '--trace-warnings')).toEqual({
      [REPO_PATH_OVERRIDES_ENV]: JSON.stringify({ app: '/worktree/app' }),
      NODE_OPTIONS: `--trace-warnings --require ${JSON.stringify(REPO_PATH_PRELOAD_PATH)}`,
    })
  })

  it('does not alter ordinary in-place runs', () => {
    expect(repoPathOverrideEnv({}, '--trace-warnings')).toEqual({})
  })
})
