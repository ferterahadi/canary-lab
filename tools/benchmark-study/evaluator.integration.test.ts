import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { baseConfig } from '../../shared/configs/playwright.base'
import { buildScenario, plainSuite, scenarios } from './scenarios'
import { copy, sourceRoot } from './files'
import { evaluate } from './evaluator'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-study-evaluator-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

it('boots all three real services and independently verifies original/plain parity, seeded failures, and a repaired candidate', async () => {
  const deps = path.join(root, 'runtime/node_modules')
  fs.mkdirSync(deps, { recursive: true })
  // Repository dependencies only; this test never discovers a user's workspace.
  for (const name of fs.readdirSync(path.join(sourceRoot, 'node_modules'))) {
    if (name === 'canary-lab') continue
    fs.symlinkSync(path.join(sourceRoot, 'node_modules', name), path.join(deps, name))
  }
  fs.symlinkSync(sourceRoot, path.join(deps, 'canary-lab'))
  const original = path.join(root, 'original')
  const plain = path.join(root, 'plain')
  const template = path.join(sourceRoot, 'templates/project/features/storefront-journey')
  copy(template, original)
  plainSuite(template, plain, { ...baseConfig, workers: 4, maxFailures: 4, use: { ...baseConfig.use, video: 'off' } })
  const source = path.join(sourceRoot, 'templates/project/demo-app')
  for (const [id, omitted] of [['reference', []], ['single-service', [2]], ['cross-service', [0, 1, 2]]] as const) {
    const app = path.join(root, id)
    buildScenario(source, app, [...omitted])
    const a = await evaluate(root, app, original, path.join(root, `${id}-original`), id === 'reference')
    const b = await evaluate(root, app, plain, path.join(root, `${id}-plain`), id === 'reference')
    expect(a).toEqual(b)
    expect(a.roster).toHaveLength(7)
    expect(a.skipped).toHaveLength(0)
    if (id === 'reference') {
      expect(a.code).toBe(0); expect(a.passed).toHaveLength(7); expect(a.extras).toBe(true)
    } else {
      expect(a.code).toBe(1)
      expect(a.failed.map((title) => title.split(' ')[0]).sort()).toEqual([...scenarios[id].failedJourneys].sort())
    }
  }
}, 180_000)
