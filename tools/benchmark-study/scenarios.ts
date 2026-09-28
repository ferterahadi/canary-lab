import fs from 'node:fs'
import path from 'node:path'
import type { Attempt, ScenarioId, StudySelection, StudyDesign, Workflow, Agent } from './types'
import { balancedOrders, random, shuffle, validateDesign } from './design'
import { changed, copy, hashes, write } from './files'
// The smoke gate and study must derive fixes from the same authoritative recipes.
// @ts-expect-error The contributor repair recipes are an existing JavaScript module.
import { repairSteps } from '../storefront-repairs.mjs'

export const scenarios: Record<ScenarioId, { omitted: number[]; failedJourneys: string[] }> = {
  'single-service': { omitted: [2], failedJourneys: ['J2', 'J4', 'J5'] },
  'cross-service': { omitted: [0, 1, 2], failedJourneys: ['J1', 'J2', 'J4', 'J5'] },
}
export function schedule(selection?: StudySelection, design?: StudyDesign): Attempt[] {
  if (selection && (!['codex', 'claude'].includes(selection.agent) || (selection.scenario !== undefined && !Object.hasOwn(scenarios, selection.scenario)))) throw new Error('Invalid study agent/scenario selection')
  if (design) {
    validateDesign(design)
    const next = random(design.seed)
    const pairs: Attempt[][] = []
    // Replay uses one structural agent slot; reports label it scripted, not Codex.
    const agents: Agent[] = design.mode === 'replay' ? [selection?.agent ?? 'codex'] : ['codex', 'claude']
    for (const agent of agents) for (const scenario of Object.keys(scenarios) as ScenarioId[]) {
      if (selection && (selection.agent !== agent || (selection.scenario !== undefined && selection.scenario !== scenario))) continue
      if (design.variants) {
        balancedOrders(design.variants, design.repetitions, next).forEach((order, index) => pairs.push(order.map((variant) => ({
          id: `${agent}-${scenario}-${index + 1}-canary-${variant.id}`, agent, scenario, repetition: index + 1, workflow: 'canary', variant: { ...variant },
        }))))
        continue
      }
      const first = shuffle(Array.from({ length: design.repetitions }, (_, i): Workflow => i % 2 ? 'plain' : 'canary'), next)
      first.forEach((workflow, index) => pairs.push([workflow, workflow === 'canary' ? 'plain' : 'canary'].map((arm) => ({
        id: `${agent}-${scenario}-${index + 1}-${arm}`, agent, scenario, repetition: index + 1, workflow: arm as Workflow,
      }))))
    }
    return shuffle(pairs, next).flat()
  }
  return (['codex', 'claude'] as const).flatMap((agent) =>
    (Object.keys(scenarios) as ScenarioId[]).flatMap((scenario) => [1, 2].flatMap((repetition) =>
      (repetition === 1 ? ['canary', 'plain'] as const : ['plain', 'canary'] as const).map((workflow) => ({
        id: `${agent}-${scenario}-${repetition}-${workflow}`, agent, scenario, repetition, workflow,
      })),
    )),
  ).filter((attempt) => !selection || (attempt.agent === selection.agent && (selection.scenario === undefined || attempt.scenario === selection.scenario)))
}
export function buildScenario(source: string, target: string, omitted: number[]): void {
  copy(source, target)
  repairSteps.forEach((repair: { apply: (root: string) => void }, index: number) => {
    if (!omitted.includes(index)) repair.apply(target)
  })
}
export function replayPatch(snapshot: string, reference: string): Array<{ file: string; content: string }> {
  return changed(hashes(snapshot), hashes(reference)).map((file) => {
    if (!/^(catalog-service|inventory-service|checkout-service|shared)\/.+\.ts$/.test(file)) throw new Error(`Unsupported replay repair: ${file}`)
    return { file, content: fs.readFileSync(path.join(reference, file), 'utf8') }
  })
}
export function plainSuite(source: string, target: string, baseConfig: object): void {
  copy(source, target)
  const spec = path.join(target, 'e2e/storefront.spec.ts')
  const original = fs.readFileSync(spec, 'utf8')
  const needle = "from 'canary-lab/feature-support/log-marker-fixture'"
  if (original.split(needle).length !== 2) throw new Error('Expected exactly one Canary fixture import')
  write(spec, original.replace(needle, "from '@playwright/test'"))
  // Preserve resolved execution settings, rather than approximating baseConfig.
  write(path.join(target, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test'\nconst config = ${JSON.stringify(baseConfig, null, 2)}\nexport default defineConfig({ ...config, reporter: [...config.reporter, ['./study-observer.cjs']] })\n`)
  write(path.join(target, 'study-observer.cjs'), `const fs = require('node:fs'); const path = require('node:path');\nmodule.exports = class { onBegin() { fs.appendFileSync(path.join(__dirname, '../test-executions.jsonl'), JSON.stringify({ startedAt: new Date().toISOString() }) + '\\n'); } };\n`)
  fs.rmSync(path.join(target, 'feature.config.cjs'))
}
