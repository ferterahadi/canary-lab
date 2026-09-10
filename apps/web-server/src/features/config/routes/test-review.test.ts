import { afterEach, beforeEach, expect, it } from 'vitest'
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
afterEach(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }) })
const get = (query = 'file=e2e/a.spec.ts') => app.inject(`/api/features/alpha/test-review?${query}`)
it('returns full source and source-linked English from the same committed/current versions', async () => {
  const response = await get(); expect(response.statusCode).toBe(200)
  const result = response.json<TestFileReview>()
  expect(result.before.source).toBe(before); expect(result.after.source).toBe(after)
  expect(result.baseline).toBe('head')
  expect(result.after.tests[0]).toMatchObject({ line: 3, endLine: 11 })
  expect(result.after.tests[0].readable.story?.steps.length).toBeGreaterThan(0)
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
it('returns only a lightweight difference flag when full review context is not needed', async () => {
  expect((await get('file=e2e/a.spec.ts&summary=true')).json()).toEqual({ changed: true })
  git('add', '.'); git('commit', '-qm', 'accept edits')
  expect((await get('file=e2e/a.spec.ts&summary=true')).json()).toEqual({ changed: false })
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
