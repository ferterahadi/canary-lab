import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { checked, copy, digest, files, inside, json, readJson, sha, sourceRoot } from './files'
import { evaluate } from './evaluator'
import { buildScenario, plainSuite, replayPatch, scenarios, schedule } from './scenarios'
import type { Agent, ModelPin, StorefrontScenarioId, StudyManifest, StudySelection, StudyDesign } from './types'
import { EFFORT_LEVELS, KNOWN_MODEL_OPTIONS } from '../../shared/agent-models'
import { resolveCodexToolArgs } from './tool-policy'
import { resolveAgentBinary } from '../../apps/web-server/src/features/agent-sessions/logic/agent-binary'
import { configurationDigest, policyDigests } from './experiment'

export function sourceFingerprint(): string {
  const study = path.join(sourceRoot, 'tools/benchmark-study')
  const implementation = fs.readdirSync(study).sort().filter((name) => fs.statSync(path.join(study, name)).isFile())
    .map((name) => `${name}:${sha(fs.readFileSync(path.join(study, name)))}`).join('\n')
  return sha(implementation + digest(path.join(study, 'repository')) + ['apps/web-server/src', 'apps/web-server/prompts', 'shared'].map((directory) => digest(path.join(sourceRoot, directory))).join('\n') +
    ['tools/storefront-repairs.mjs', 'package.json', 'package-lock.json'].map((file) => sha(fs.readFileSync(path.join(sourceRoot, file)))).join('\n'))
}
export function dependencyFingerprint(root: string): string {
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (!inside(root, fs.realpathSync(file))) throw new Error(`Dependency symlink escapes the snapshot: ${file}`)
      return [`${path.relative(root, file)}:${fs.readlinkSync(file)}`]
    }
    return entry.isDirectory() ? visit(file) : [`${path.relative(root, file)}:${sha(fs.readFileSync(file))}`]
  })
  return sha(visit(root).join('\n'))
}
export function validatePins(pins: Record<Agent, { model: string; effort: string }>): void {
  for (const agent of ['codex', 'claude'] as const) {
    const pin = pins[agent]
    if (!pin?.model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]+$/.test(pin.model) || !(EFFORT_LEVELS[agent] as readonly string[]).includes(pin.effort)) throw new Error(`Explicit ${agent} model and supported effort are required`)
    if (KNOWN_MODEL_OPTIONS[agent].some((option) => option.value === pin.model) || /^(auto|default|latest)$/.test(pin.model)) throw new Error(`Use an exact ${agent} model identifier, not the moving alias ${pin.model}`)
  }
}
export async function prepare(options: { workspace: string; output: string; pins: Record<Agent, { model: string; effort: string }>; selection?: StudySelection; design?: StudyDesign; maxTokens?: number }): Promise<StudyManifest> {
  if (options.design?.mode !== 'replay') validatePins(options.pins)
  const attempts = schedule(options.selection, options.design)
  if (options.design?.variants && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens! <= 0)) throw new Error('Variant campaigns require a positive --max-tokens dispatch ceiling')
  const started = Date.now()
  const workspace = fs.realpathSync(options.workspace)
  const root = path.join(fs.realpathSync(path.dirname(path.resolve(options.output))), path.basename(options.output))
  if (/[\n\r`$\\]/.test(root + workspace)) throw new Error('Study/demo paths cannot contain shell interpolation characters')
  if (inside(sourceRoot, root) || inside(workspace, root) || inside(root, sourceRoot) || inside(root, workspace)) throw new Error('Study output must be outside the source checkout and demo workspace')
  if (fs.existsSync(root)) throw new Error('Output already exists; choose a fresh study directory')
  const app = path.join(workspace, 'demo-app')
  const suite = path.join(workspace, 'features/storefront-journey')
  for (const required of [app, suite, path.join(workspace, 'package-lock.json'), path.join(workspace, 'node_modules')]) {
    if (!fs.existsSync(required)) throw new Error(`Missing demo input: ${required}`)
  }
  const pins = {} as Record<Agent, ModelPin>
  for (const agent of ['codex', 'claude'] as const) {
    if (options.design?.mode === 'replay') { pins[agent] = { model: 'scripted', effort: 'none', version: 'no-cloud-agent' }; continue }
    const resolved = resolveAgentBinary(agent)
    if (!resolved) throw new Error(`Cannot resolve the ${agent} executable`)
    const executable = fs.realpathSync(resolved)
    pins[agent] = { ...options.pins[agent], executable, version: await checked(executable, ['--version'], workspace) }
  }
  const require = createRequire(path.join(workspace, 'package.json'))
  const { default: sourceConfig } = require(path.join(suite, 'playwright.config.ts'))
  const config = JSON.parse(JSON.stringify(sourceConfig, (_key, value) => {
    if (typeof value === 'function' || value instanceof RegExp) throw new Error('Study expects the shipped demo config; dynamic configuration is unsupported')
    return value
  }))
  if (config.testDir !== './e2e' || config.projects || config.webServer || config.globalSetup || config.globalTeardown) {
    throw new Error('Study expects the shipped storefront Playwright configuration')
  }
  const frozen = path.join(root, 'frozen')
  fs.mkdirSync(frozen, { recursive: true })
  copy(suite, path.join(frozen, 'original-suite'))
  plainSuite(suite, path.join(frozen, 'plain-suite'), config)
  fs.copyFileSync(path.join(workspace, 'package-lock.json'), path.join(frozen, 'package-lock.json'))
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.cpSync(path.join(workspace, 'node_modules'), path.join(root, 'runtime/node_modules'), { recursive: true, verbatimSymlinks: true })
  const dependencyVersions = Object.fromEntries(['@playwright/test', 'tsx', 'canary-lab'].map((name) => [name,
    readJson<{ version: string }>(path.join(root, 'runtime/node_modules', name, 'package.json')).version]))
  dependencyVersions.node = process.version
  dependencyVersions.platform = `${process.platform}/${process.arch}`
  const manifest: StudyManifest = {
    schemaVersion: 1, status: 'preparing', root, createdAt: new Date().toISOString(), sourceWorkspace: workspace,
    sourceRevision: await checked('git', ['rev-parse', 'HEAD'], sourceRoot), sourceDigest: sourceFingerprint(),
    dependencyDigest: dependencyFingerprint(path.join(root, 'runtime/node_modules')), dependencyVersions, pins, budgetMs: 15 * 60_000,
    codexToolArgs: options.design?.mode === 'replay' ? [] : await resolveCodexToolArgs(root, pins.codex.executable),
    preparationMs: 0, preparation: {}, snapshots: { 'single-service': '', 'cross-service': '' }, frozenDigest: '',
    attempts, ...(options.design ? { design: options.design } : {}), ...(options.selection ? { selection: options.selection } : {}), results: [], active: null,
  }
  json(path.join(root, 'study.json'), manifest)
  buildScenario(app, path.join(root, 'reference'), [])
  for (const scenario of Object.keys(scenarios) as StorefrontScenarioId[]) {
    const output = path.join(frozen, scenario)
    buildScenario(app, output, scenarios[scenario].omitted)
    manifest.snapshots[scenario] = digest(output)
    if (options.design?.mode === 'replay') json(path.join(frozen, `replay-${scenario}.json`), replayPatch(output, path.join(root, 'reference')))
  }
  for (const scenario of ['reference', ...Object.keys(scenarios)] as const) {
    const appPath = scenario === 'reference' ? path.join(root, 'reference') : path.join(frozen, scenario)
    const results = []
    for (const mode of ['original', 'plain']) {
      const evidence = await evaluate(root, appPath, path.join(frozen, `${mode}-suite`), path.join(root, 'preparation', `${scenario}-${mode}`), scenario === 'reference')
      if (evidence.roster.length !== 7) throw new Error(`Expected seven declared journeys for ${scenario}/${mode}`)
      if (scenario === 'reference') {
        if (evidence.code !== 0 || evidence.passed.length !== 7 || evidence.extras !== true) throw new Error(`Repaired reference failed: ${mode}`)
      } else {
        const expected = scenarios[scenario as StorefrontScenarioId].failedJourneys
        const actual = evidence.failed.map((title) => title.split(' ')[0]).sort()
        if (evidence.code !== 1 || JSON.stringify(actual) !== JSON.stringify([...expected].sort()) || evidence.skipped.length) {
          throw new Error(`Scenario drift ${scenario}/${mode}: expected ${expected}, got ${actual}`)
        }
      }
      results.push(evidence)
    }
    if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw new Error(`Original/plain suite outcomes differ: ${scenario}`)
    manifest.preparation[scenario] = results
  }
  // The copied assertions must differ only at their fixture import.
  const original = fs.readFileSync(path.join(frozen, 'original-suite/e2e/storefront.spec.ts'), 'utf8')
  const plain = fs.readFileSync(path.join(frozen, 'plain-suite/e2e/storefront.spec.ts'), 'utf8')
  if (plain !== original.replace("from 'canary-lab/feature-support/log-marker-fixture'", "from '@playwright/test'")) throw new Error('Assertion parity failed')
  manifest.preparation.originalInputs = files(app)
  manifest.preparation.toolPolicy = 'Shell and installed Playwright CLI in both workflows; optional browser MCP and inherited connectors disabled'
  manifest.preparation.repairsHash = sha(fs.readFileSync(path.join(sourceRoot, 'tools/storefront-repairs.mjs')))
  manifest.frozenDigest = digest(frozen)
  if (options.design?.variants) {
    manifest.experiment = { configurationDigest: '', promptDigests: policyDigests(manifest), maxTokens: options.maxTokens! }
    manifest.experiment.configurationDigest = configurationDigest(manifest)
  }
  manifest.preparationMs = Date.now() - started
  manifest.status = 'ready'
  json(path.join(root, 'study.json'), manifest)
  return manifest
}
