import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { FileRunStateSink } from './features/runs/logic/runtime/run-state-sink'
import { runDirFor } from './features/runs/logic/runtime/run-paths'
import { pendingRunReview } from './features/runs/logic/runtime/run-review-gate'
import { digestOfSpecHashes } from './features/runs/logic/runtime/run-suite-snapshot'
import { hashFeatureSpecs } from './features/runs/logic/dirty-specs/detect'
import type { WorkspaceNotification } from '../../../shared/notifications/types'
import { trackTempDirs } from '../../../tools/test-helpers/temp-dir'
import { initGitRepo, git } from '../../../tools/test-helpers/git-repo'

const tempDir = trackTempDirs('canary-review-server-')

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('preserves exact review identity, refusal, persisted acceptance and agent catch-up through production wiring', async () => {
  const root = tempDir()
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'shop')
  const logsDir = path.join(root, 'logs')
  const runId = 'recorded-review'
  const snapshot = path.join(runDirFor(logsDir, runId), 'suite')
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "exports.config = { name: 'shop', description: 'Review fixture', featureDir: __dirname, repos: [] }")
  const file = path.join(featureDir, 'e2e/contract.spec.ts')
  fs.writeFileSync(file, "test('contract', () => expect(1).toBe(1))\n")
  initGitRepo(featureDir)
  fs.cpSync(featureDir, snapshot, { recursive: true, filter: (source) => path.basename(source) !== '.git' })
  new FileRunStateSink(logsDir).bootstrap({
    runId, feature: 'shop', featureDir, status: 'aborted', startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:00Z', services: [], healCycles: 0,
    suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: '2026-01-01T00:00:00Z', digest: digestOfSpecHashes(hashFeatureSpecs(snapshot)) },
  })
  fs.appendFileSync(file, '// first candidate\n')
  const ptyFactory = vi.fn(() => { throw new Error('Review verification must not spawn agents') })
  const { app, runStore } = await createServer({ projectRoot: root, featuresDir, logsDir, ptyFactory })
  cleanups.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const connect = async () => {
    const client = new Client({ name: 'review-observer', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
    cleanups.push(() => client.close())
    return client
  }
  const client = await connect()
  const call = async (connection: Client, name: string, args: Record<string, unknown>) => {
    const result = await connection.callTool({ name, arguments: args })
    expect(result.isError).not.toBe(true)
    if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text response')
    return JSON.parse(result.content[0].text)
  }
  const frames: Array<{ type: string }> = []
  const socket = await app.injectWS('/ws/workspace', {}, {
    onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
  })
  cleanups.push(() => socket.close())
  const notifications = (): WorkspaceNotification[] => JSON.parse(fs.readFileSync(path.join(logsDir, 'notifications/state.json'), 'utf8')).items
  await expect.poll(() => notifications().some((item) => !item.resolvedAt && item.target?.kind === 'test-review')).toBe(true)
  const initial = await call(client, 'get_test_review', { runId })
  const rest = await app.inject(`/api/runs/${runId}/test-review?summary=true`)
  expect(rest.json()).toMatchObject({ review_revision: initial.review_revision, files: initial.files })
  expect(pendingRunReview(runStore, 'shop', featureDir)).toMatchObject({ review_revision: initial.review_revision, changedFileCount: 1 })

  fs.appendFileSync(file, '// second candidate\n')
  const refused = await app.inject({ method: 'POST', url: `/api/runs/${runId}/accept-test-review`, payload: { expectedRevision: initial.review_revision } })
  expect(refused.statusCode).toBe(409)
  expect(refused.json()).toMatchObject({ reason: 'review-changed' })
  expect(runStore.get(runId)?.manifest.specEdits?.reviewDecisions).toBeUndefined()
  const current = await call(client, 'get_test_review', { runId })
  expect(current.review_revision).not.toBe(initial.review_revision)
  const beforeListeners = runStore.listenerCount('event')
  const waiting = call(client, 'review_test_changes', {
    runId, review_revision: current.review_revision, browser_wait_token: current.browser_wait_token,
    wait_for_decision: true, timeout_ms: 5000,
  }).then((result) => ({ result }), (error: unknown) => ({ error }))
  await expect.poll(() => runStore.listenerCount('event')).toBeGreaterThan(beforeListeners)
  frames.length = 0
  const accepted = await app.inject({ method: 'POST', url: `/api/runs/${runId}/accept-test-review`, payload: { expectedRevision: current.review_revision } })
  expect(accepted.statusCode).toBe(202)
  expect(accepted.json()).toMatchObject({ decision: 'accepted', review_revision: current.review_revision, git: { status: 'committed' }, execution: { status: 'new-run-required' } })
  expect(await waiting).toMatchObject({ result: { status: 'approved-for-new-run', review_revision: current.review_revision } })
  expect(pendingRunReview(runStore, 'shop', featureDir)).toBeUndefined()
  expect(git(featureDir, 'show', 'HEAD:e2e/contract.spec.ts')).toContain('second candidate')
  const saved = JSON.parse(fs.readFileSync(path.join(runDirFor(logsDir, runId), 'manifest.json'), 'utf8'))
  expect(saved.specEdits.reviewDecisions).toContainEqual(expect.objectContaining({ revision: current.review_revision, receipt: accepted.json() }))
  await expect.poll(() => notifications().filter((item) => !item.resolvedAt)).toEqual([])
  await expect.poll(() => frames.some((frame) => frame.type === 'notifications-changed')).toBe(true)
  const agent = await call(client, 'wait_for_feature_change', { feature: 'shop', timeout_ms: 0 })
  expect(agent.notificationUpdate).toMatchObject({ attentionCount: 0 })
  const reconnected = await connect()
  const recovered = await call(reconnected, 'get_test_review', { runId })
  expect(recovered).toMatchObject({ review_revision: current.review_revision, reviewState: 'settled', receipt: accepted.json() })
  expect(await call(reconnected, 'review_test_changes', {
    runId, review_revision: recovered.review_revision, browser_wait_token: recovered.browser_wait_token, wait_for_decision: true,
  })).toMatchObject({ status: 'approved-for-new-run' })
  expect(ptyFactory).not.toHaveBeenCalled()
})
