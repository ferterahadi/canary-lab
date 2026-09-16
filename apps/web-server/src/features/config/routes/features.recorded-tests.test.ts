import { afterEach, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { featuresRoutes } from './features'
import { writeManifest } from '../../runs/logic/runtime/manifest'
import legacy from '../../../../../web/src/features/runs/utils/__fixtures__/run-legacy-roster.json'
import { saveSuiteTestRoster } from '../../runs/logic/suite-test-roster'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('lists the full saved suite for different envsets and preserves the filtered result records', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'full-recorded-suite-')))
  roots.push(root)
  const featureDir = path.join(root, 'features/merchant')
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'merchant', featureDir: __dirname, repos: [], envs: ['local', 'meta'] } }")
  fs.writeFileSync(path.join(featureDir, 'e2e/new.spec.ts'), "test('only in current source', () => {})")
  const summaries = new Map<string, string>()
  for (const env of ['local', 'meta']) {
    const runDir = path.join(root, 'logs/runs', env)
    const snapshot = path.join(runDir, 'suite')
    fs.mkdirSync(path.join(snapshot, 'e2e'), { recursive: true })
    const file = path.join(snapshot, 'e2e/all.spec.ts')
    fs.writeFileSync(file, "test('local case', () => { expect(1).toBe(1) })\ntest('meta case', () => { expect(2).toBe(2) })\n")
    // Both the legacy reconstruction and newly saved inventory must have the
    // same meaning, even though their reporters recorded different subsets.
    if (env === 'local') saveSuiteTestRoster(snapshot)
    writeManifest(path.join(runDir, 'manifest.json'), { runId: env, feature: 'merchant', featureDir, env, startedAt: 'now', status: 'passed', services: [], healCycles: 0, suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: 'now', digest: 'digest' } })
    const summary = JSON.stringify({ complete: true, total: 1, passed: 1, passedNames: [`test-case-${env}-case`], failed: [], knownTests: [{ id: env, title: `${env} case`, name: `test-case-${env}-case`, location: `${file}:${env === 'local' ? 1 : 2}` }] })
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), summary)
    summaries.set(runDir, summary)
  }
  const spawner = vi.fn(() => { throw new Error('Historical modules must not execute') })
  const app = Fastify()
  await featuresRoutes(app, { featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs'), playwrightListSpawner: spawner })
  try {
    for (const env of ['local', 'meta']) {
      const response = await app.inject(`/api/features/merchant/tests?runId=${env}`)
      expect(response.statusCode).toBe(200)
      expect(response.json()[0].tests.map((test: { name: string }) => test.name)).toEqual(['local case', 'meta case'])
      expect(response.body).not.toContain('only in current source')
    }
    for (const [dir, summary] of summaries) expect(fs.readFileSync(path.join(dir, 'e2e-summary.json'), 'utf8')).toBe(summary)
    expect(spawner).not.toHaveBeenCalled()
  } finally { await app.close() }
})

it('serves every recorded legacy test without reading current workspace source', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-tests-')))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, legacy.manifest.feature)
  const runDir = path.join(root, 'logs/runs', legacy.manifest.runId)
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: '${legacy.manifest.feature}', featureDir: __dirname, repos: [], envs: ['local'] } }`)
  writeManifest(path.join(runDir, 'manifest.json'), { ...legacy.manifest, featureDir, status: 'passed', startedAt: 'now', services: [], healCycles: 0 })
  fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify(legacy.summary))
  const spawner = vi.fn(() => { throw new Error('Historical modules must not execute') })
  const app = Fastify()
  await featuresRoutes(app, { featuresDir, logsDir: path.join(root, 'logs'), playwrightListSpawner: spawner })
  try {
    const response = await app.inject(`/api/features/${legacy.manifest.feature}/tests?runId=${legacy.manifest.runId}`)
    expect(response.statusCode).toBe(200)
    const specs = response.json()
    expect(specs.every((spec: { recordedSourceUnavailable?: boolean }) => spec.recordedSourceUnavailable)).toBe(true)
    const tests = specs.flatMap((spec: { tests: Array<{ name: string; bodySource: string; steps: unknown[] }> }) => spec.tests)
    expect(tests.map((test: { name: string }) => test.name).sort()).toEqual(legacy.summary.knownTests.map((test) => test.title).sort())
    expect(tests).toHaveLength(23)
    expect(tests.every((test: { bodySource: string; steps: unknown[] }) => test.bodySource === '' && test.steps.length === 0)).toBe(true)
    expect(spawner).not.toHaveBeenCalled()
  } finally { await app.close() }
})

it('reads historical names and bodies without executing specs or including new workspace tests', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-tests-')))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'merchant')
  const runDir = path.join(root, 'logs/runs/run1')
  const snapshot = path.join(runDir, 'suite')
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.mkdirSync(path.join(snapshot, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'merchant', featureDir: __dirname, repos: [], envs: ['local'] } }")
  fs.writeFileSync(path.join(featureDir, 'e2e/a.spec.ts'), "test('renamed current test', async () => { expect(false).toBe(true) })")
  const file = path.join(snapshot, 'e2e/a.spec.ts')
  fs.writeFileSync(file, "for (const title of historicalCases) test(title, async () => { expect(201).toBe(201) })\n")
  writeManifest(path.join(runDir, 'manifest.json'), { runId: 'run1', feature: 'merchant', featureDir, startedAt: 'now', status: 'failed', services: [], healCycles: 0, suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: 'now', digest: 'digest' } })
  const roster = { complete: true, total: 2, passed: 1, failed: [], knownTests: [
    { id: 'one', title: 'old test case one', name: 'test-case-old-test-case-one', location: `${file}:1` },
    { id: 'two', title: 'old test case two', name: 'test-case-old-test-case-two', location: `${file}:1` },
  ] }
  fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify(roster))
  const spawner = vi.fn(() => { throw new Error('Historical modules must not execute') })
  const app = Fastify()
  await featuresRoutes(app, { featuresDir, logsDir: path.join(root, 'logs'), playwrightListSpawner: spawner })
  try {
    const response = await app.inject('/api/features/merchant/tests?runId=run1')
    expect(response.statusCode).toBe(200)
    expect(response.json()[0].tests.map((test: { name: string }) => test.name)).toEqual(['old test case one', 'old test case two'])
    expect(response.json()[0].tests[0].bodySource).toContain('expect(201)')
    expect(response.body).not.toContain('renamed current test')
    expect(spawner).not.toHaveBeenCalled()
    expect((await app.inject('/api/features/merchant/tests?runId=..')).statusCode).toBe(400)
    expect((await app.inject('/api/features/merchant/tests?runId=absent')).statusCode).toBe(404)

    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({ ...roster, knownTests: [{ ...roster.knownTests[0], location: `${featureDir}/e2e/a.spec.ts:1` }] }))
    expect((await app.inject('/api/features/merchant/tests?runId=run1')).statusCode).toBe(409)
    fs.rmSync(snapshot, { recursive: true })
    const missingSource = await app.inject('/api/features/merchant/tests?runId=run1')
    expect(missingSource.statusCode).toBe(200)
    expect(missingSource.json()[0]).toMatchObject({ recordedSourceUnavailable: true, tests: [{ name: roster.knownTests[0].title, bodySource: '', steps: [] }] })
    expect(missingSource.body).not.toContain('expect(false)')
    expect(missingSource.body).not.toContain('renamed current test')
    expect(spawner).not.toHaveBeenCalled()

    // A queued run can be aborted before the reporter ever saves a roster.
    fs.rmSync(path.join(runDir, 'e2e-summary.json'))
    const noRoster = await app.inject('/api/features/merchant/tests?runId=run1')
    expect(noRoster.statusCode).toBe(200)
    expect(noRoster.json()).toEqual([])
    expect(spawner).not.toHaveBeenCalled()
  } finally { await app.close() }
})
