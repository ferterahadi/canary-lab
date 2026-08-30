import { describe, expect, it } from 'vitest'
import {
  REPO_PATH_OVERRIDES_ENV,
  applyRepoPathOverridesToFeatureConfig,
  parseRepoPathOverrides,
  resolveRunRepoPath,
} from './repo-path-overrides'
import { installRepoPathOverridePreload } from './repo-path-preload'

describe('repo path overrides', () => {
  it('parses only non-empty string paths and falls back safely on malformed input', () => {
    expect(parseRepoPathOverrides('{bad json')).toEqual({})
    expect(parseRepoPathOverrides(JSON.stringify({ app: '/worktree/app', empty: '', count: 2 })))
      .toEqual({ app: '/worktree/app' })
  })

  it('resolves an isolated path without changing direct Playwright use', () => {
    expect(resolveRunRepoPath('app', '/source/app', {
      [REPO_PATH_OVERRIDES_ENV]: JSON.stringify({ app: '/worktree/app' }),
    })).toBe('/worktree/app')
    expect(resolveRunRepoPath('app', '/source/app', {})).toBe('/source/app')
  })

  it('clones a feature config and leaves the cached source export unchanged', () => {
    const original = {
      config: {
        repos: [
          { name: 'app', localPath: '/source/app', command: 'npm start' },
          { name: 'other', localPath: '/source/other' },
        ],
      },
      marker: true,
    }
    const rewritten = applyRepoPathOverridesToFeatureConfig(original, { app: '/worktree/app' })

    expect(rewritten).toEqual({
      config: {
        repos: [
          { name: 'app', localPath: '/worktree/app', command: 'npm start' },
          { name: 'other', localPath: '/source/other' },
        ],
      },
      marker: true,
    })
    expect(original.config.repos[0].localPath).toBe('/source/app')
  })

  it('leaves malformed config shapes and unsupported repo entries unchanged', () => {
    expect(parseRepoPathOverrides(undefined)).toEqual({})
    expect(parseRepoPathOverrides(JSON.stringify(['not', 'a config']))).toEqual({})
    expect(parseRepoPathOverrides(JSON.stringify(null))).toEqual({})

    const noRepos = { config: { title: 'feature' } }
    expect(applyRepoPathOverridesToFeatureConfig(noRepos, { app: '/worktree/app' })).toEqual(noRepos)
    expect(applyRepoPathOverridesToFeatureConfig({ config: null }, { app: '/worktree/app' })).toEqual({ config: null })
    expect(applyRepoPathOverridesToFeatureConfig(null, { app: '/worktree/app' })).toBeNull()

    const config = {
      default: {
        repos: [null, 'not-a-repo', [], { name: 7, localPath: '/source/number' }, { name: 'app', localPath: '/source/app' }],
      },
    }
    expect(applyRepoPathOverridesToFeatureConfig(config, { app: '/worktree/app' })).toEqual({
      default: {
        repos: [null, 'not-a-repo', [], { name: 7, localPath: '/source/number' }, { name: 'app', localPath: '/worktree/app' }],
      },
    })
    expect(applyRepoPathOverridesToFeatureConfig({ repos: [] }, { app: '/worktree/app' })).toEqual({ repos: [] })
  })

  it('rewrites only feature config loads and restores the original loader', () => {
    const originalLoad = () => ({ config: { repos: [{ name: 'app', localPath: '/source/app' }] } })
    const loader = {
      _load: originalLoad,
      _resolveFilename: (request: string) => request,
    }
    const restore = installRepoPathOverridePreload(loader, {
      [REPO_PATH_OVERRIDES_ENV]: JSON.stringify({ app: '/worktree/app' }),
    })

    expect(loader._load('/suite/feature.config.cjs', null, false)).toEqual({
      config: { repos: [{ name: 'app', localPath: '/worktree/app' }] },
    })
    expect(loader._load('/suite/helper.cjs', null, false)).toEqual({
      config: { repos: [{ name: 'app', localPath: '/source/app' }] },
    })
    restore()
    expect(loader._load).toBe(originalLoad)
  })

  it('keeps a later loader hook in place and returns unchanged modules when resolution fails', () => {
    const originalLoad = () => ({ config: { repos: [{ name: 'app', localPath: '/source/app' }] } })
    const replacementLoad = () => ({ replacement: true })
    const loader = {
      _load: originalLoad,
      _resolveFilename: () => { throw new Error('unresolved') },
    }
    const restore = installRepoPathOverridePreload(loader, {
      [REPO_PATH_OVERRIDES_ENV]: JSON.stringify({ app: '/worktree/app' }),
    })

    expect(loader._load('/suite/feature.config.cjs', null, false)).toEqual({
      config: { repos: [{ name: 'app', localPath: '/source/app' }] },
    })
    loader._load = replacementLoad
    restore()
    expect(loader._load).toBe(replacementLoad)
  })

  it('does not install a hook when no repo override is configured', () => {
    const originalLoad = () => ({ config: { repos: [] } })
    const loader = { _load: originalLoad, _resolveFilename: (request: string) => request }

    const restore = installRepoPathOverridePreload(loader, {})

    restore()
    expect(loader._load).toBe(originalLoad)
  })
})
