import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { testReviewRoutes } from './test-review'
import type { TestFileReview } from '../../../../../../shared/test-review'

let root: string
let suite: string
let app: FastifyInstance
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
const before = `import { test, expect } from '@playwright/test'
const sharedSetup = 'keep this context'
test('reads own scope', async ({ request }) => {
  const response = await request.get('/conversations')
  const body = await response.json()
  if (body.channel === 'line') {
    expect(body.data).toEqual([])
  } else {
    expect(body.total).toBe(0)
  }
})
`
const after = before.replace('toEqual([])', 'toEqual(["unexpected"])')
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-full-review-')))
  suite = path.join(root, 'features/alpha'); fs.mkdirSync(path.join(suite, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), `module.exports = { config: { name: 'alpha', featureDir: __dirname, envs: [], repos: [] } }`)
  fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), before)
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test'); git('add', '.'); git('commit', '-qm', 'baseline')
  fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), after)
  app = Fastify(); await testReviewRoutes(app, { featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs') })
})
afterEach(async () => { vi.restoreAllMocks(); await app.close(); fs.rmSync(root, { recursive: true, force: true }) })
const get = (query = 'file=e2e/a.spec.ts') => app.inject(`/api/features/alpha/test-review?${query}`)
it('returns full source and source-linked English from the same committed/current versions', async () => {
  const response = await get(); expect(response.statusCode).toBe(200)
  const result = response.json<TestFileReview>()
  expect(result.before.source).toBe(before); expect(result.after.source).toBe(after)
  expect(result.baseline).toBe('head')
  expect(result.after.tests[0]).toMatchObject({ line: 3, endLine: 11 })
  expect(result.after.tests[0].readable.story?.steps.length).toBeGreaterThan(0)
  expect(result.after.story?.steps.slice(0, 3).map((item) => item.text)).toEqual([
    'Import test, expect from "@playwright/test"',
    'Set constant sharedSetup to "keep this context"',
    'Test: "reads own scope"',
  ])
  expect(result.before.story?.steps[0].source).toMatchObject({ file: 'e2e/a.spec.ts', startLine: 1, endLine: 1 })
  expect(result.patch).toContain(" const sharedSetup = 'keep this context'")
  expect(result.assessment.tests[0].changes[0]).toMatchObject({ before: { line: 7 }, after: { line: 7 } })
})
it('reads the explicitly selected snapshot even when HEAD and another run differ, without rewriting evidence', async () => {
  const dir = path.join(root, 'logs/runs/run-1'); fs.mkdirSync(path.join(dir, 'suite/e2e'), { recursive: true })
  const snapshot = before.replace('toEqual([])', 'toEqual(["run version"])')
  fs.writeFileSync(path.join(dir, 'suite/e2e/a.spec.ts'), snapshot)
  const manifest = JSON.stringify({ runId: 'run-1', feature: 'alpha', status: 'passed', suiteSnapshot: { kind: 'taken', dir: path.join(dir, 'suite') } })
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest)
  const result = (await get('file=e2e/a.spec.ts&runId=run-1')).json<TestFileReview>()
  expect(result.baseline).toBe('run-start'); expect(result.before.source).toBe(snapshot)
  expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe(manifest)
  expect(fs.readFileSync(path.join(dir, 'suite/e2e/a.spec.ts'), 'utf8')).toBe(snapshot)
})
it('does not silently substitute HEAD when the selected snapshot is unavailable', async () => {
  const dir = path.join(root, 'logs/runs/run-1'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ feature: 'alpha', suiteSnapshot: { kind: 'unavailable' } }))
  expect((await get('file=e2e/a.spec.ts&runId=run-1')).statusCode).toBe(409)
  expect((await get('file=e2e/a.spec.ts&runId=missing')).statusCode).toBe(404)
})
it('represents added and removed files with actual empty sides', async () => {
  fs.writeFileSync(path.join(suite, 'e2e/new.spec.ts'), after)
  const added = (await get('file=e2e/new.spec.ts')).json<TestFileReview>()
  expect(added.before.source).toBe(''); expect(added.after.source).toBe(after)
  fs.unlinkSync(path.join(suite, 'e2e/a.spec.ts'))
  const removed = (await get()).json<TestFileReview>()
  expect(removed.before.source).toBe(before); expect(removed.after.source).toBe('')
})
it.each(['file=../a.spec.ts', 'file=/tmp/a.spec.ts', 'file=feature.config.cjs', 'file=e2e/a.spec.ts&runId=..', ''])('rejects invalid file/run queries: %s', async (query) => {
  expect((await get(query)).statusCode).toBe(400)
})
it('rejects symlink escapes even for missing files below an existing link', async () => {
  fs.symlinkSync(root, path.join(suite, 'outside'))
  expect((await get('file=outside/missing.spec.ts')).statusCode).toBe(400)
})
it('re-reads edits and committed baselines; commit clears the comparison but not snapshot differences', async () => {
  expect((await get()).json<TestFileReview>().patch).not.toBe('')
  git('add', '.'); git('commit', '-qm', 'accept edits')
  expect((await get()).json<TestFileReview>().patch).toBe('')
  fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), before)
  expect((await get()).json<TestFileReview>().after.source).toBe(before)
})
it('summarises which tests changed and how, without the full review context', async () => {
  // The Tests column marks individual cards from this, so the per-test narrowing
  // has to be the same rule the dirty-spec detector applies — one rule, not two
  // that can disagree about which card carries the mark.
  expect((await get('file=e2e/a.spec.ts&summary=true')).json())
    .toEqual({ changed: true, affectedTests: ['reads own scope'], verdict: 'unclassifiable' })
  expect((await get('file=e2e/a.spec.ts&summary=true')).json()).not.toHaveProperty('patch')
  git('add', '.'); git('commit', '-qm', 'accept edits')
  expect((await get('file=e2e/a.spec.ts&summary=true')).json()).toEqual({ changed: false })
})
it('attributes an edit outside every test body to all tests in the file', async () => {
  // Shared setup has no test of its own to blame, and it feeds every test here,
  // so narrowing to "no tests changed" would drop the mark entirely.
  fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), before.replace('keep this context', 'different context'))
  expect((await get('file=e2e/a.spec.ts&summary=true')).json())
    .toMatchObject({ changed: true, affectedTests: ['reads own scope'] })
})
it('answers 404 for a suite that does not exist rather than reviewing nothing', async () => {
  expect((await app.inject('/api/features/ghost/test-review?file=e2e/a.spec.ts')).statusCode).toBe(404)
})
it('surfaces a read failure that is not a missing file instead of reporting an empty test file', async () => {
  // A directory where a spec is expected reads as EISDIR. Swallowing it would
  // render the review as "the whole file was deleted".
  fs.mkdirSync(path.join(suite, 'e2e/folder.spec.ts'))
  expect((await get('file=e2e/folder.spec.ts')).statusCode).toBe(500)
})
it('carries the parse failure into the review instead of showing a file with no tests', async () => {
  // Nesting deep enough to overflow the extractor's recursive visitor is the
  // one input that makes it report `parseError` from real source.
  fs.writeFileSync(path.join(suite, 'e2e/deep.spec.ts'), `test('deep', async () => { const a = ${'('.repeat(2000)}x${')'.repeat(2000)} })\n`)
  const review = (await get('file=e2e/deep.spec.ts')).json<TestFileReview>()
  expect(review.after.parseError).toEqual(expect.any(String))
  expect(review.before.parseError).toBeUndefined()
})
it.each([
  { name: 'a suite that is not in a repository at all', init: false },
  { name: 'a repository with nothing committed yet', init: true },
])('refuses to invent a committed baseline for $name', async ({ init }) => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-nobase-')))
  const dir = path.join(bare, 'features/alpha'); fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), `module.exports = { config: { name: 'alpha', featureDir: __dirname, envs: [], repos: [] } }`)
  fs.writeFileSync(path.join(dir, 'e2e/a.spec.ts'), after)
  if (init) execFileSync('git', ['init', '-q'], { cwd: bare, stdio: 'pipe' })
  const bareApp = Fastify()
  await testReviewRoutes(bareApp, { featuresDir: path.join(bare, 'features'), logsDir: path.join(bare, 'logs') })
  try {
    const response = await bareApp.inject('/api/features/alpha/test-review?file=e2e/a.spec.ts')
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('No committed baseline')
  } finally { await bareApp.close(); fs.rmSync(bare, { recursive: true, force: true }) }
})
it.each([
  { name: 'the commit’s tree', object: () => git('rev-parse', 'HEAD^{tree}'), message: 'Could not read the committed test tree' },
  { name: 'the file’s blob', object: () => git('rev-parse', 'HEAD:features/alpha/e2e/a.spec.ts'), message: 'Could not read the committed test file' },
])('fails loudly when git cannot hand back $name, rather than showing the file as newly added', async ({ object, message }) => {
  // A repository missing objects it still references — a partial clone, or a
  // pruned one. Treating git's failure as "no committed version" would render
  // every line as an addition and hide what actually changed.
  const sha = object().trim()
  fs.rmSync(path.join(root, '.git/objects', sha.slice(0, 2), sha.slice(2)))
  const response = await get()
  expect(response.statusCode).toBe(500)
  expect(response.json().message).toBe(message)
})

function saveSnapshot() {
  const dir = path.join(root, 'logs/runs/run-1')
  fs.mkdirSync(path.join(dir, 'suite/e2e'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'suite/e2e/a.spec.ts'), before)
  fs.copyFileSync(path.join(suite, 'feature.config.cjs'), path.join(dir, 'suite/feature.config.cjs'))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ feature: 'alpha', suiteSnapshot: { kind: 'taken', dir: path.join(dir, 'suite') } }))
  return dir
}
it('includes a fixture-only change in the comparison and exposes its complete recorded/current bytes', async () => {
  const dir = saveSnapshot()
  fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), before)
  fs.writeFileSync(path.join(dir, 'suite/e2e/fixture.ts'), 'export const ready = false\n')
  fs.writeFileSync(path.join(suite, 'e2e/fixture.ts'), 'export const ready = true\n')
  const comparison = (await app.inject('/api/features/alpha/test-source-comparison?runId=run-1')).json()
  expect(comparison).toMatchObject({ state: 'ready', files: ['e2e/a.spec.ts', 'e2e/fixture.ts'],
    differences: [{ file: 'e2e/fixture.ts', affectedTests: [] }], changes: { added: [], changed: [], removed: [] } })
  const response = await get('file=e2e/fixture.ts&runId=run-1')
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ supportingFile: true, baseline: 'run-start',
    before: { source: 'export const ready = false\n', tests: [] }, after: { source: 'export const ready = true\n', tests: [] } })
  expect(response.json().before.story.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: expect.stringContaining('ready'), source: expect.objectContaining({ file: 'e2e/fixture.ts', startLine: 1 }) }),
  ]))
  expect(response.json().after.story.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: expect.stringContaining('ready'), source: expect.objectContaining({ file: 'e2e/fixture.ts', startLine: 1 }) }),
  ]))
  expect(response.json().patch).toContain('+export const ready = true')
  fs.mkdirSync(path.join(suite, 'envsets'))
  fs.writeFileSync(path.join(suite, 'envsets/secret.env'), 'PRIVATE')
  expect((await get('file=envsets/secret.env&runId=run-1')).statusCode).toBe(400)
})
it('leaves generated coverage integrity state out of the human comparison', async () => {
  const dir = saveSnapshot()
  const file = 'docs/_coverage-state.json'
  const recorded = JSON.stringify({ verificationRequiredAfter: '2026-09-18T06:48:09.623Z', requirementsHash: 'same', mappingInference: { tests: { checkout: { fingerprint: 'old' } } } }, null, 2) + '\n'
  const current = JSON.stringify({ verificationRequiredAfter: '2026-09-18T09:14:42.594Z', requirementsHash: 'same', mappingInference: { tests: { checkout: { fingerprint: 'new' } } } }, null, 2) + '\n'
  fs.mkdirSync(path.join(dir, 'suite/docs'), { recursive: true })
  fs.mkdirSync(path.join(suite, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'suite', file), recorded)
  fs.writeFileSync(path.join(suite, file), current)

  const comparison = (await app.inject('/api/features/alpha/test-source-comparison?runId=run-1')).json()
  expect(comparison.files).not.toContain(file)
  expect(comparison.differences).not.toContainEqual(expect.objectContaining({ file }))
  expect((await get(`file=${file}&runId=run-1`)).statusCode).toBe(400)
})
it('compares retained checks across a rename and reports only the real assertion addition', async () => {
  saveSnapshot()
  fs.writeFileSync(path.join(suite, 'e2e/a.spec.ts'), before.replace('reads own scope', 'reads local scope').replace('  const body = await response.json()', '  const body = await response.json()\n  expect(body.ready).toBe(true)'))
  const comparison = (await app.inject('/api/features/alpha/test-source-comparison?runId=run-1')).json()
  expect(comparison.changes).toMatchObject({ added: [], removed: [], changed: [{ name: 'reads local scope', previous: { name: 'reads own scope' } }] })
  const review = (await get('file=e2e/a.spec.ts&runId=run-1')).json<TestFileReview>()
  expect(review.assessment.tests.flatMap((test) => test.changes).map((change) => change.kind)).toEqual(['added'])
})
it('compares declarations in both source trees without relying on a runtime roster', async () => {
  const dir = saveSnapshot()
  fs.writeFileSync(path.join(dir, 'suite/e2e/deleted.spec.ts'), "test('gone', () => {})")
  fs.writeFileSync(path.join(suite, 'e2e/new.spec.ts'), "for (const id of [1,2,3]) { test(`case ${id}`, () => {}) }")
  const result = await app.inject('/api/features/alpha/test-source-comparison?runId=run-1')
  expect(result.statusCode).toBe(200)
  expect(result.json()).toMatchObject({ state: 'ready', files: ['e2e/a.spec.ts', 'e2e/deleted.spec.ts', 'e2e/new.spec.ts'], changes: {
    added: [{ file: 'e2e/new.spec.ts', name: 'case ${id}', line: 1, endLine: 1 }],
    changed: [{ file: 'e2e/a.spec.ts', name: 'reads own scope', line: 3, endLine: 11 }],
    removed: [{ file: 'e2e/deleted.spec.ts', name: 'gone', line: 1, endLine: 1 }],
  } })
  expect(fs.readFileSync(path.join(dir, 'suite/e2e/a.spec.ts'), 'utf8')).toBe(before)
})
it('rejects missing, mismatched and unavailable source comparison baselines', async () => {
  const getComparison = (suiteName: string, query: string) => app.inject(`/api/features/${suiteName}/test-source-comparison?${query}`)
  expect((await getComparison('alpha', '')).statusCode).toBe(400)
  expect((await getComparison('alpha', 'runId=..')).statusCode).toBe(400)
  expect((await getComparison('ghost', 'runId=run-1')).statusCode).toBe(404)
  expect((await getComparison('alpha', 'runId=missing')).statusCode).toBe(404)
  const dir = saveSnapshot()
  fs.rmSync(path.join(dir, 'suite'), { recursive: true })
  expect((await getComparison('alpha', 'runId=run-1')).statusCode).toBe(409)
})
// A spec that is absent reads as empty on purpose — a deleted test is a real
// comparison. A spec that exists and cannot be read is not: folding it into the
// same silence would show "no change" for a file nobody could look at.
it('fails the comparison when a spec exists but cannot be read', async () => {
  saveSnapshot()
  const real = fs.readFileSync as (file: fs.PathOrFileDescriptor, options?: unknown) => unknown
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (typeof file === 'string' && file.endsWith('a.spec.ts')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return real(file, options)
  }) as typeof fs.readFileSync)
  const result = await app.inject('/api/features/alpha/test-source-comparison?runId=run-1')
  expect(result.statusCode).toBe(500)
  expect(result.json().message).toContain('EACCES')
})
it('does not read outside a source tree through a linked e2e directory', async () => {
  saveSnapshot()
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.spec.ts'), "test('private', () => {})")
  fs.rmSync(path.join(suite, 'e2e'), { recursive: true }); fs.symlinkSync(outside, path.join(suite, 'e2e'))
  const result = await app.inject('/api/features/alpha/test-source-comparison?runId=run-1')
  expect(result.statusCode).toBe(400)
  expect(result.body).not.toContain('private')
})
