import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { loadFeatures, listSpecFiles } from '../lib/feature-loader'
import { extractTestsFromSource, type ExtractedTest } from '../lib/ast-extractor'
import { listPlaywrightTests, type PlaywrightListSpawner } from '../lib/playwright-list'
import { parseDotenv } from '../lib/dotenv-edit'
import {
  getEnvSetsDir,
  loadConfig,
} from '../lib/runtime/env-switcher/switch'

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
      env: envsetProcessEnv(feature.featureDir, feature.envs?.[0]),
    })

    if (pwList === null) {
      return specFiles.map((file) => {
        const result = astByFile.get(file) ?? { file, tests: [] as ExtractedTest[] }
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

    return specFiles.map((file) => {
      const ast = astByFile.get(file)
      const astByLine = new Map<number, ExtractedTest>()
      for (const t of ast?.tests ?? []) astByLine.set(t.line, t)

      const pwEntries = pwByFile.get(file)
      if (!pwEntries || pwEntries.length === 0) {
        return {
          file,
          tests: ast?.tests ?? [],
          ...(ast?.parseError ? { parseError: ast.parseError } : {}),
        }
      }

      const tests: ExtractedTest[] = pwEntries
        .slice()
        .sort((a, b) => a.line - b.line || a.title.localeCompare(b.title))
        .map((entry) => {
          const fromAst = astByLine.get(entry.line)
          return {
            name: entry.title,
            line: entry.line,
            bodySource: fromAst?.bodySource ?? '',
            steps: fromAst?.steps ?? [],
          }
        })
      return {
        file,
        tests,
        ...(ast?.parseError ? { parseError: ast.parseError } : {}),
      }
    })
  })
}

function envsetProcessEnv(featureDir: string, envName: string | undefined): NodeJS.ProcessEnv {
  if (!envName) return {}
  const envSetsDir = getEnvSetsDir(featureDir)
  if (!fs.existsSync(path.join(envSetsDir, 'envsets.config.json'))) return {}

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(featureDir)
  } catch {
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
