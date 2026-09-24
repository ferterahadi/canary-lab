import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { registerMcpRoutes } from './server'
import { runsRoutes } from '../features/runs/routes/runs'
import { createRegistry, RunStore } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { makeHealLoopContext } from '../features/runs/logic/runtime/__fixtures__/heal-loop-context'
import { adoptSpecEdits, recordSpecEdits, restoreSpecEdits, snapshotSuite } from '../features/runs/logic/runtime/run-suite-snapshot'
import { writeManifest } from '../features/runs/logic/runtime/manifest'
import { waitForTestReview } from './test-review-wait'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function harness(answer: (live: string) => { action: 'accept' | 'cancel' | 'decline'; content?: { choice: string } }, legacy = false, elicitation = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-review-http-'))
  cleanups.push(async () => fs.rmSync(root, { recursive: true, force: true }))
  const store = new RunStore(path.join(root, 'logs'), createRegistry())
  const { ctx } = makeHealLoopContext({ root, opts: { runStateSink: store } })
  fs.mkdirSync(path.join(ctx.feature.featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(ctx.feature.featureDir, 'e2e/a.spec.ts'), "test('a', () => expect(1).toBe(1))\n")
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ctx.feature.featureDir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Canary Test')
  git('add', '.')
  git('commit', '-qm', 'initial')
  fs.mkdirSync(ctx.paths.runDir, { recursive: true })
  writeManifest(ctx.paths.manifestPath, { runId: ctx.runId, feature: 'demo', featureDir: ctx.feature.featureDir, startedAt: 'now', status: 'healing', services: [], healCycles: 1, repoPaths: ['/editable-app'] })
  snapshotSuite(ctx)
  const live = path.join(ctx.feature.featureDir, 'e2e/a.spec.ts')
  const changed = "test('a', () => { expect(1).toBe(1); expect(2).toBe(2) })\n"
  fs.writeFileSync(live, changed)
  recordSpecEdits(ctx)
  ctx.signalGate.beginWaiting()
  store.registry.set(ctx.runId, {
    runId: ctx.runId, stop: async () => {},
    pauseAndHeal: async () => ({ ok: false, reason: 'already-healing' }),
    cancelHeal: async () => ({ ok: false, reason: 'no-agent-running' }),
    adoptSpecEdits: (revision, gitReceipt) => adoptSpecEdits(ctx, revision, gitReceipt), restoreSpecEdits: (revision) => restoreSpecEdits(ctx, revision),
  })
  const events: string[] = []
  store.on('event', (event) => events.push(event.kind))
  const broker = new ExternalHealBroker({ now: Date.now, emit: () => {}, patchManifest: (id, patch) => store.patchManifest(id, patch), audit: () => {} })
  const app = Fastify()
  await app.register(runsRoutes, { featuresDir: path.join(root, 'features'), store, startRun: async () => { throw new Error('not used') } })
  const requests: string[] = []
  await app.register(registerMcpRoutes, {
    projectRoot: root, featuresDir: path.join(root, 'features'), store, broker,
    startRun: async () => { throw new Error('not used') },
    testReviewRequest: async (request) => {
      requests.push(request.method)
      const response = await app.inject({ method: request.method, url: request.url, payload: request.payload as Record<string, unknown> | undefined })
      return { statusCode: response.statusCode, body: response.json() }
    },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(async () => app.close())
  const client = new Client({ name: 'test-review-human', version: '1' }, { capabilities: elicitation ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: legacy ? 'legacy' : { pin: '2026-07-28' } } })
  const reply = vi.fn(async () => answer(live))
  if (elicitation) client.setRequestHandler('elicitation/create', reply)
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))
  cleanups.push(async () => client.close())
  const call = async (command: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'exec', arguments: { command, arguments: args } })
    const content = result.content as Array<{ text: string }>
    return JSON.parse(content[0].text)
  }
  return { call, ctx, changed, store, events, requests, reply, app }
}

describe('human test review through the real MCP and REST path', () => {
  it('lets a form-capable client observe a browser decision without opening another question', async () => {
    const { call, ctx, app, store, reply } = await harness(() => ({ action: 'cancel' }), true, true)
    const review = await call('get_test_review', { runId: ctx.runId })
    const before = store.listenerCount('event')
    const waiting = call('review_test_changes', { runId: ctx.runId, review_revision: review.review_revision, browser_wait_token: review.browser_wait_token, wait_for_decision: true })
    await vi.waitFor(() => expect(store.listenerCount('event')).toBeGreaterThan(before))
    const accepted = await app.inject({ method: 'POST', url: `/api/runs/${ctx.runId}/accept-test-review`, payload: { expectedRevision: review.review_revision } })
    expect(accepted.statusCode).toBe(202)
    expect(await waiting).toMatchObject({ status: 'adopted', decision: 'accepted', git: { status: 'committed' } })
    expect(reply).not.toHaveBeenCalled()
  })

  it.each(['adopted', 'restored'] as const)('resumes a non-eliciting agent when the human chooses %s in the browser', async (decision) => {
    const { call, ctx, app, store, reply } = await harness(() => ({ action: 'cancel' }), false, false)
    const review = await call('get_test_review', { runId: ctx.runId })
    const args = { runId: ctx.runId, review_revision: review.review_revision }
    const fallback = await call('review_test_changes', args)
    expect(fallback).toMatchObject({ reason: 'elicitation-unavailable', review_revision: review.review_revision })
    expect(fallback.next).toContain('wait_for_decision:true')
    const listeners = store.listenerCount('event')
    const pending = call('review_test_changes', { ...args, browser_wait_token: fallback.browser_wait_token, wait_for_decision: true })
    await vi.waitFor(() => expect(store.listenerCount('event')).toBeGreaterThan(listeners))
    const action = decision === 'adopted' ? 'accept-test-review' : 'restore-spec-edits'
    expect((await app.inject({ method: 'POST', url: `/api/runs/${ctx.runId}/${action}`, payload: { expectedRevision: review.review_revision } })).statusCode).toBe(decision === 'adopted' ? 202 : 200)
    expect(await pending).toMatchObject({ status: decision, nextSteps: ['wait_for_heal_task'] })
    expect(reply).not.toHaveBeenCalled()
    expect(store.listenerCount('event')).toBe(listeners)
    // The click can precede the wait or a reconnect. Re-reading the persisted
    // receipt must still return it without another prompt or action.
    recordSpecEdits(ctx)
    const reloaded = new RunStore(store.logsDir, createRegistry())
    expect(await waitForTestReview(reloaded, ctx.runId, review.review_revision)).toMatchObject({ status: decision })
    expect(ctx.signalGate.consume()?.kind ?? null).toBe(decision === 'adopted' ? 'rerun' : null)
  })

  it('waits without approving, detects changed source, and cleans up on timeout or run end', async () => {
    const { call, ctx, store, requests } = await harness(() => ({ action: 'cancel' }), false, false)
    const review = await call('get_test_review', { runId: ctx.runId })
    const first = { runId: ctx.runId, review_revision: review.review_revision, wait_for_decision: true, timeout_ms: 1 }
    const fallback = await call('review_test_changes', first)
    expect(fallback).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable' })
    const args = { ...first, browser_wait_token: fallback.browser_wait_token }
    const listeners = store.listenerCount('event')
    expect(await call('review_test_changes', args)).toMatchObject({ status: 'still_waiting' })
    expect(store.listenerCount('event')).toBe(listeners)
    fs.appendFileSync(path.join(ctx.feature.featureDir, 'e2e/a.spec.ts'), '// later edit\n')
    expect(await call('review_test_changes', args)).toMatchObject({ status: 'review-changed' })
    expect(store.listenerCount('event')).toBe(listeners)
    store.patchManifest(ctx.runId, { status: 'aborted' })
    expect(await call('review_test_changes', args)).toMatchObject({ status: 'run-ended' })
    expect(await call('review_test_changes', { ...args, runId: 'missing' })).toMatchObject({ status: 'run-unavailable' })
    expect(requests).not.toContain('POST')
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it.each([false, true])('adopts the reviewed bytes and emits run updates after acceptance (legacy=%s)', async (legacy) => {
    const { call, ctx, changed, store, events, requests, reply } = await harness(() => ({ action: 'accept', content: { choice: 'Accept & commit' } }), legacy)
    const review = await call('get_test_review', { runId: ctx.runId })
    expect(review.patch).toContain('+test')
    expect(fs.readFileSync(review.patchPath, 'utf8')).toBe(review.patch)
    expect(requests).toEqual(['GET'])
    // The exact regression: an agent's first wait must still ask the human.
    const result = await call('review_test_changes', { runId: ctx.runId, review_revision: review.review_revision, wait_for_decision: true })
    expect(result).toMatchObject({
      status: 'adopted', decision: 'accepted', review_revision: review.review_revision,
      git: { status: 'committed', commit: expect.stringMatching(/^[a-f0-9]{40}$/) },
      execution: { status: 'rerun-requested', runId: ctx.runId },
    })
    expect(reply).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/a.spec.ts'), 'utf8')).toBe(changed)
    expect(store.get(ctx.runId)?.manifest.specEdits?.adopted).toMatchObject([{ by: 'human', reviewRevision: review.review_revision }])
    expect(events).toContain('changed')
    expect(ctx.signalGate.consume()?.kind).toBe('rerun')
    expect(store.get(ctx.runId)?.manifest.status).toBe('healing')
    expect(await call('review_test_changes', { runId: ctx.runId, review_revision: review.review_revision })).toMatchObject({ status: 'adopted' })
    expect(reply).toHaveBeenCalledTimes(1)
    expect(requests.filter((method) => method === 'POST')).toHaveLength(1)
  })

  it.each(['Accept & commit', 'Restore recorded files'])('elicits a fixture-only change and records %s without browser interaction', async (choice) => {
    const { call, ctx, store, reply } = await harness(() => ({ action: 'accept', content: { choice } }))
    fs.copyFileSync(path.join(ctx.suiteDir, 'e2e/a.spec.ts'), path.join(ctx.feature.featureDir, 'e2e/a.spec.ts'))
    fs.writeFileSync(path.join(ctx.suiteDir, 'e2e/fixture.ts'), 'export const ready = false\n')
    fs.writeFileSync(path.join(ctx.feature.featureDir, 'e2e/fixture.ts'), 'export const ready = true\n')
    const review = await call('get_test_review', { runId: ctx.runId })
    expect(review.files).toEqual([{ file: 'e2e/fixture.ts', change: 'modified' }])
    const result = await call('review_test_changes', { runId: ctx.runId, review_revision: review.review_revision, wait_for_decision: true })
    const decision = choice === 'Accept & commit' ? 'adopted' : 'restored'
    expect(result).toMatchObject({ status: decision, nextSteps: ['wait_for_heal_task'] })
    expect(reply).toHaveBeenCalledTimes(1)
    expect(store.get(ctx.runId)?.manifest.specEdits?.reviewDecisions).toContainEqual(expect.objectContaining({ revision: review.review_revision, decision }))
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/fixture.ts'), 'utf8')).toBe(fs.readFileSync(path.join(ctx.feature.featureDir, 'e2e/fixture.ts'), 'utf8'))
    expect(ctx.signalGate.consume()?.kind ?? null).toBe(decision === 'adopted' ? 'rerun' : null)
  })

  it.each(['cancel', 'decline'] as const)('does not mutate or rerun on %s', async (action) => {
    const { call, ctx, requests } = await harness(() => ({ action }))
    const review = await call('get_test_review', { runId: ctx.runId })
    expect(await call('review_test_changes', { runId: ctx.runId, review_revision: review.review_revision })).toMatchObject({ status: 'needs-input' })
    expect(requests).not.toContain('POST')
    expect(ctx.signalGate.consume()).toBeNull()
    expect(fs.readFileSync(path.join(ctx.suiteDir, 'e2e/a.spec.ts'), 'utf8')).not.toContain('expect(2)')
  })

  it('refuses stale acceptance after the user edits the file while reviewing', async () => {
    const { call, ctx, requests } = await harness((live) => {
      fs.appendFileSync(live, '// changed after review\n')
      return { action: 'accept', content: { choice: 'Accept & commit' } }
    })
    const review = await call('get_test_review', { runId: ctx.runId })
    expect(await call('review_test_changes', { runId: ctx.runId, review_revision: review.review_revision })).toMatchObject({ status: 'needs-input', reason: expect.stringContaining('changed') })
    expect(requests).not.toContain('POST')
    expect(ctx.signalGate.consume()).toBeNull()
  })

  it('returns large patches by path without truncation and refuses unavailable snapshots', async () => {
    const { call, ctx, app } = await harness(() => ({ action: 'cancel' }))
    fs.writeFileSync(path.join(ctx.feature.featureDir, 'helper.ts'), Array.from({ length: 1000 }, (_, n) => `export const value${n} = ${n}`).join('\n'))
    const review = await call('get_test_review', { runId: ctx.runId })
    expect(review).not.toHaveProperty('patch')
    expect(fs.readFileSync(review.patchPath, 'utf8')).toContain('value999')
    expect((await app.inject({ method: 'GET', url: '/api/runs/missing/test-review' })).statusCode).toBe(404)
    fs.rmSync(ctx.suiteDir, { recursive: true })
    expect((await app.inject({ method: 'GET', url: `/api/runs/${ctx.runId}/test-review` })).statusCode).toBe(409)
  })
})
