import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../shared/launcher/types'

/** The in-memory `demo` suite the run orchestrator tests drive: one `api` repo
 *  checked out at `root`, with one health-checked service. The command never
 *  runs — the tests hand the orchestrator a fake PTY factory — so only its shape
 *  matters. `over` replaces whole top-level fields, never merges into them. */
export function demoFeature(root: string, over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(root, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: root,
        startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
    ...over,
  }
}

/** A config value that `writeFeatureFixture` writes as the `__dirname`
 *  expression rather than a path string. Node resolves `__dirname` through
 *  symlinks, so a repo pointed here is the suite directory exactly as the
 *  feature loader will see it — on macOS a path string built from `os.tmpdir()`
 *  would name the `/var` side of the `/private/var` link instead. */
export const FEATURE_DIR = '\u0000feature-dir'

/** The config most suites need: one local env and one repo, `r`, that is the
 *  suite's own directory. */
export const SELF_REPO_CONFIG = { envs: ['local'], repos: [{ name: 'r', localPath: FEATURE_DIR }] }

export interface FeatureFixtureFiles {
  /** Files under `e2e/`, by name. */
  specs?: Record<string, string>
  /** Files under `docs/`, by relative path. */
  docs?: Record<string, string>
}

/** A real `<featuresDir>/<name>/feature.config.cjs` that `loadFeatures`
 *  requires, plus any spec and doc files. `config` is merged over
 *  `{ name, description: 'd' }`; `featureDir` is always the suite's own
 *  directory. A directory is created only when a file is written into it, so a
 *  suite with no `docs` really has no `docs/`. Returns the suite directory. */
export function writeFeatureFixture(
  featuresDir: string,
  name: string,
  config: object = {},
  { specs = {}, docs = {} }: FeatureFixtureFiles = {},
): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const literal = JSON.stringify({ name, description: 'd', ...config }).split(JSON.stringify(FEATURE_DIR)).join('__dirname')
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), `module.exports = { config: { ...${literal}, featureDir: __dirname } }`)
  for (const [subdir, files] of [['e2e', specs], ['docs', docs]] as const) {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, subdir, rel)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
  }
  return dir
}
