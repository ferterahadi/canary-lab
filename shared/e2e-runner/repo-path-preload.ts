import Module from 'node:module'
import path from 'node:path'
import {
  REPO_PATH_OVERRIDES_ENV,
  applyRepoPathOverridesToFeatureConfig,
  parseRepoPathOverrides,
} from './repo-path-overrides'

interface CommonJsLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown
  _resolveFilename(request: string, parent: unknown, isMain: boolean): unknown
}

function isFeatureConfig(filename: unknown): filename is string {
  return typeof filename === 'string' && /^feature\.config\.(?:cjs|js)$/.test(path.basename(filename))
}

/** Install the narrow CJS load hook used by Playwright and heal-agent child
 * processes. Existing authored specs may require feature.config.cjs directly;
 * rewriting its returned copy closes that path without modifying user files. */
export function installRepoPathOverridePreload(
  loader: CommonJsLoader = Module as unknown as CommonJsLoader,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const overrides = parseRepoPathOverrides(env[REPO_PATH_OVERRIDES_ENV])
  if (Object.keys(overrides).length === 0) return () => {}

  const originalLoad = loader._load
  const patchedLoad: CommonJsLoader['_load'] = function patched(request, parent, isMain) {
    const loaded = originalLoad.call(loader, request, parent, isMain)
    let filename: unknown
    try {
      filename = loader._resolveFilename(request, parent, isMain)
    } catch {
      return loaded
    }
    return isFeatureConfig(filename)
      ? applyRepoPathOverridesToFeatureConfig(loaded, overrides)
      : loaded
  }
  loader._load = patchedLoad
  return () => {
    if (loader._load === patchedLoad) loader._load = originalLoad
  }
}

installRepoPathOverridePreload()
