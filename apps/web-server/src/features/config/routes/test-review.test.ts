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
