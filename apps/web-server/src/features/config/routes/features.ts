import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../../config/logic/feature-loader'
import { extractTestsFromSource, type ExtractedTest } from '../../config/logic/ast-extractor'
import { getGitRoot, runGit } from '../../../shared/git-repo'
import type { DirtySpecStore } from '../../runs/logic/dirty-specs/store'
import { diffChangedLines } from '../../runs/logic/dirty-specs/text-diff'
import { listPlaywrightTests, type PlaywrightListSpawner } from '../../runs/logic/playwright-list'
import { parseDotenv } from '../../config/logic/dotenv-edit'
import { overlayExists as portifyOverlayExists } from '../../portify/logic/runtime/overlay'
import {
  getEnvSetsDir,
  loadConfig,
} from '../../runs/logic/runtime/env-switcher/switch'
import type { EnvSetsConfig } from '../../runs/logic/runtime/env-switcher/types'

export interface FeaturesRouteDeps {
  featuresDir: string
  // Optional override so tests can stub the Playwright `--list` invocation
  // without spawning a real `npx playwright test`.
  playwrightListSpawner?: PlaywrightListSpawner
  // Test-file integrity store. Absent in tests that don't exercise dirty state;
  // when present, the feature list carries a `dirty` summary and the approve /
  // commit routes are live. Mutations emit store change events which the server
  // bridges to a `tests-dirty-changed` WorkspaceEvent (no direct publish here).
  dirtySpecStore?: DirtySpecStore
}

// Compact dirty summary folded into each feature-list row. Clean when the store
// has no record yet (cold load before the watcher's first recompute) or the
// feature has no modified specs.
function dirtySummary(store: DirtySpecStore | undefined, featureName: string): {
  status: 'clean' | 'dirty'
  specs: { file: string; affectedTests: string[] }[]
} {
  const rec = store?.get(featureName)
  if (!rec || rec.status !== 'dirty') return { status: 'clean', specs: [] }
  return { status: 'dirty', specs: rec.dirtySpecs.map((s) => ({ file: s.file, affectedTests: s.affectedTests })) }
}

export async function featuresRoutes(app: FastifyInstance, deps: FeaturesRouteDeps): Promise<void> {
  app.get('/api/features', async () => {
    const features = loadFeatures(deps.featuresDir)
    return features.map((f) => ({
      name: f.name,
      description: f.description,
      repos: (f.repos ?? []).map((r) => ({ name: r.name, localPath: r.localPath })),
      envs: f.envs ?? [],
      // A saved port overlay exists → the feature boots concurrently. Surfaced
      // as the "Portified" badge in the features column.
      portified: portifyOverlayExists(f.featureDir),
      // Test-file integrity: 'dirty' when a spec changed since the last green
      // (or run-start) and hasn't been approved/committed. Drives the red cue.
      dirty: dirtySummary(deps.dirtySpecStore, f.name),
    }))
  })

  // Approve the current spec content as intended (Canary-local). Records the
  // current hashes as the accepted baseline so the cue clears without a commit.
  app.post<{ Params: { name: string } }>('/api/features/:name/approve-dirty', async (req, reply) => {
    const feature = loadFeatures(deps.featuresDir).find((f) => f.name === req.params.name)
    if (!feature || !feature.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    if (!deps.dirtySpecStore) {
      reply.code(503)
      return { error: 'test-file integrity tracking is not available' }
    }
    const rec = await deps.dirtySpecStore.approve(feature.name, feature.featureDir)
    return { status: rec.status, dirtySpecs: rec.dirtySpecs }
  })

  // Commit the modified specs to git — the durable, reviewable acknowledgment.
  // Stages + commits exactly the dirty spec files (not the whole working tree),
  // then recomputes; HEAD now matches the working tree so the cue clears. An
  // external commit (user's own terminal) clears the same way via the .git watch.
  app.post<{ Params: { name: string } }>('/api/features/:name/commit-dirty', async (req, reply) => {
    const feature = loadFeatures(deps.featuresDir).find((f) => f.name === req.params.name)
    if (!feature || !feature.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    if (!deps.dirtySpecStore) {
      reply.code(503)
      return { error: 'test-file integrity tracking is not available' }
    }
    const specs = deps.dirtySpecStore.get(feature.name)?.dirtySpecs ?? []
    if (specs.length === 0) {
      const rec = await deps.dirtySpecStore.recompute(feature.name, feature.featureDir)
      return { committed: false, reason: 'no modified specs', status: rec.status }
    }
    const root = await getGitRoot(feature.featureDir)
    if (!root) {
      reply.code(409)
      return { error: 'feature is not inside a git repository' }
    }
    const realDir = fs.realpathSync(feature.featureDir)
    const repoRelPaths = specs.map((s) => path.relative(root, path.join(realDir, s.file)))
    const add = await runGit(root, ['add', '--', ...repoRelPaths])
    if (add.code !== 0) {
      reply.code(500)
      return { error: (add.stderr || add.stdout).trim() || 'git add failed' }
    }
    const message = `test: accept modified specs for "${feature.name}" via Canary Lab`
    const commit = await runGit(root, ['commit', '-m', message, '--', ...repoRelPaths])
    if (commit.code !== 0) {
      reply.code(500)
      return { error: (commit.stderr || commit.stdout).trim() || 'git commit failed' }
    }
    const rec = await deps.dirtySpecStore.recompute(feature.name, feature.featureDir)
    return { committed: true, status: rec.status }
  })

  // Per-test line-diff for a dirty spec, against the committed (HEAD) version —
  // the same comparison an editor's own git-diff view already shows. Diffing
  // happens here (git itself, via `diffChangedLines`), not on the client — the
  // client just renders the line numbers it's given. Empty when the feature
  // isn't in git, the file has no HEAD entry yet (never committed), or a test
  // has no changed lines — nothing to highlight rather than an error.
  app.get<{ Params: { name: string }; Querystring: { file?: string } }>(
    '/api/features/:name/dirty-diff',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature || !feature.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const rel = req.query.file
      if (!rel) {
        reply.code(400)
        return { error: 'file query param required' }
      }
      const root = await getGitRoot(feature.featureDir)
      if (!root) return { tests: [] }
      const realDir = fs.realpathSync(feature.featureDir)
      const abs = path.join(realDir, rel)
      let currentSource = ''
      try { currentSource = fs.readFileSync(abs, 'utf8') } catch { /* unreadable — no tests to diff */ }
      const { tests: currentTests } = extractTestsFromSource(rel, currentSource)

      const repoRel = path.relative(root, abs)
      const head = await runGit(root, ['show', `HEAD:${repoRel}`])
      // The file itself has never been committed — nothing to diff against yet
      // (mirrors the dirty-detection bootstrap rule: no baseline at all reads
      // clean, not "everything changed"). A test missing from an otherwise
      // tracked file is a different case, handled per-test below.
      if (head.code !== 0) return { tests: [] }
      const { tests: headTests } = extractTestsFromSource(rel, head.stdout)

      const results = await Promise.all(currentTests.map(async (t) => {
        const headBody = headTests.find((h) => h.name === t.name)?.bodySource
        const changedLines = headBody === undefined
          ? Array.from({ length: t.bodySource ? t.bodySource.split('\n').length : 0 }, (_, i) => i + 1)
          : [...await diffChangedLines(headBody, t.bodySource)]
        return { name: t.name, changedLines }
      }))
      return { tests: results.filter((r) => r.changedLines.length > 0) }
    },
  )

  app.get<{ Params: { name: string } }>('/api/features/:name/config', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature || !feature.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const candidates: Array<{ name: string; format: 'cjs' | 'js' | 'ts' }> = [
      { name: 'feature.config.cjs', format: 'cjs' },
      { name: 'feature.config.js', format: 'js' },
      { name: 'feature.config.ts', format: 'ts' },
    ]
    for (const c of candidates) {
      const p = path.join(feature.featureDir, c.name)
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8')
        return { path: p, content, format: c.format }
      }
    }
    reply.code(404)
    return { error: 'config file not found' }
  })

  app.get<{ Params: { name: string } }>('/api/features/:name/tests', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const specFiles = listSpecFiles(feature.featureDir)

    // 1. Run AST over each spec to gather (line -> { bodySource, steps }) for
    //    enrichment. This is the single source of body/step extraction.
    const astByFile = new Map<string, ReturnType<typeof extractTestsFromSource>>()
    for (const file of specFiles) {
      let source = ''
      try { source = fs.readFileSync(file, 'utf-8') } catch { /* unreadable */ }
      astByFile.set(file, extractTestsFromSource(file, source))
    }

    // 2. Ask Playwright to enumerate the resolved test list (loops expanded,
    //    `${var}` substituted). On failure, fall back to AST-only output.
    const pwList = await listPlaywrightTests(feature.featureDir, {
      spawner: deps.playwrightListSpawner,
      env: envsetProcessEnv(feature.featureDir, feature.envs?.[0], (err) => {
        app.log.warn({ err, feature: feature.name }, 'ignoring invalid feature envset config while listing tests')
      }),
    })

    if (pwList === null) {
      return specFiles.map((file) => {
        // astByFile has an entry for every specFile (populated above).
        const result = astByFile.get(file)!
        return {
          file,
          tests: result.tests,
          ...(result.parseError ? { parseError: result.parseError } : {}),
        }
      })
    }

    // 3. Group Playwright entries by spec file, then emit one ExtractedTest
    //    per resolved entry. Body/steps come from the AST entry whose `line`
    //    matches the call site (multiple loop iterations share the same body).
    const pwByFile = new Map<string, typeof pwList>()
    for (const entry of pwList) {
      const arr = pwByFile.get(entry.file) ?? []
      arr.push(entry)
      pwByFile.set(entry.file, arr)
    }

    // AST-extract any origin file we encounter that isn't already in
    // astByFile (i.e. helper files referenced by `entry.originFile`). The
    // ExtractedTest body/steps for helper-defined tests come from these.
    const originAstByFile = new Map<string, ReturnType<typeof extractTestsFromSource>>()
    for (const entry of pwList) {
      if (!entry.originFile || entry.originFile === entry.file) continue
      if (astByFile.has(entry.originFile) || originAstByFile.has(entry.originFile)) continue
      let source = ''
      try { source = fs.readFileSync(entry.originFile, 'utf-8') } catch { /* unreadable */ }
      originAstByFile.set(entry.originFile, extractTestsFromSource(entry.originFile, source))
    }

    function lookupAstByLine(file: string, line: number): ExtractedTest | undefined {
      // `file` is always either a specFile (in astByFile) or an originFile we
      // AST-extracted into originAstByFile above, so one of them resolves.
      const ast = (astByFile.get(file) ?? originAstByFile.get(file))!
      return ast.tests.find((t) => t.line === line)
    }

    return specFiles.map((file) => {
      // astByFile has an entry for every specFile (populated above).
      const ast = astByFile.get(file)!

      const pwEntries = pwByFile.get(file)
      if (!pwEntries || pwEntries.length === 0) {
        return {
          file,
          tests: ast.tests,
          ...(ast.parseError ? { parseError: ast.parseError } : {}),
        }
      }

      const tests: ExtractedTest[] = pwEntries
        .slice()
        .sort((a, b) => a.line - b.line || a.title.localeCompare(b.title))
        .map((entry) => {
          const isHelperDefined = entry.originFile && entry.originFile !== entry.file
          const fromAst = isHelperDefined
            ? lookupAstByLine(entry.originFile, entry.originLine)
            : lookupAstByLine(file, entry.line)
          const test: ExtractedTest = {
            name: entry.title,
            line: isHelperDefined ? entry.originLine : entry.line,
            bodySource: fromAst?.bodySource ?? '',
            steps: fromAst?.steps ?? [],
          }
          if (isHelperDefined) test.sourceFile = entry.originFile
          return test
        })
      return {
        file,
        tests,
        ...(ast.parseError ? { parseError: ast.parseError } : {}),
      }
    })
  })
}

function envsetProcessEnv(
  featureDir: string,
  envName: string | undefined,
  warn: (err: unknown) => void,
): NodeJS.ProcessEnv {
  if (!envName) return {}
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return {}

  let config: EnvSetsConfig
  try {
    config = loadConfig(featureDir)
    if (!isEnvSetsConfig(config)) {
      warn(new Error('envsets.config.json is missing required feature.slots or slots fields'))
      return {}
    }
  } catch (err) {
    warn(err)
    return {}
  }

  const env: NodeJS.ProcessEnv = {}
  for (const slot of config.feature.slots) {
    const sourcePath = path.join(envSetsDir, envName, slot)
    if (!fs.existsSync(sourcePath)) continue
    try {
      const parsed = parseDotenv(fs.readFileSync(sourcePath, 'utf-8'))
      for (const entry of parsed.entries) {
        env[entry.key] = entry.value
      }
    } catch { /* ignore unreadable envset slots */ }
  }
  return env
}

// `config` is the parsed envsets.config.json (loadConfig returns a typed but
// unvalidated object); this checks the runtime shape we actually depend on.
function isEnvSetsConfig(config: EnvSetsConfig): boolean {
  const value = config as Partial<EnvSetsConfig>
  return Boolean(value.feature)
    && typeof value.feature === 'object'
    && Array.isArray(value.feature.slots)
    && value.feature.slots.every((slot) => typeof slot === 'string')
    && Boolean(value.slots)
    && typeof value.slots === 'object'
    && !Array.isArray(value.slots)
}
