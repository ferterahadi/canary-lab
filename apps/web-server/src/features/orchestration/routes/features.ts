import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../logic/feature-loader'
import { extractTestsFromSource, type ExtractedTest } from '../logic/ast-extractor'
import { listPlaywrightTests, type PlaywrightListSpawner } from '../logic/playwright-list'
import { parseDotenv } from '../logic/dotenv-edit'
import { overlayExists as portifyOverlayExists } from '../logic/runtime/portify/overlay'
import {
  getEnvSetsDir,
  loadConfig,
} from '../logic/runtime/env-switcher/switch'
import type { EnvSetsConfig } from '../logic/runtime/env-switcher/types'

export interface FeaturesRouteDeps {
  featuresDir: string
  // Optional override so tests can stub the Playwright `--list` invocation
  // without spawning a real `npx playwright test`.
  playwrightListSpawner?: PlaywrightListSpawner
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
    }))
  })

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
