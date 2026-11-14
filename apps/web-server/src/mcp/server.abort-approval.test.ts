import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { registerMcpRoutes } from './server'
import { RunStore } from '../features/runs/logic/run-store'
import { createRegistry } from '../features/runs/logic/run-registry'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

// "Stop this run?" end to end, the way a Desktop chat client meets it: the
// client declines the native form on its own, the human answers in Canary's
// Notifications, and the agent waits with wait_for_approval. The orchestrator
// is a double; everything between the HTTP answer and its stop call is real.

const tempDir = trackTempDirs('canary-abort-approval-')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

const RUN_ID = '2026-11-14T0523-abcd'

async function harness() {
  const projectRoot = tempDir()
  const featuresDir = path.join(projectRoot, 'features')
  fs.mkdirSync(path.join(featuresDir, 'checkout'), { recursive: true })
  const logsDir = path.join(projectRoot, 'logs')
  fs.mkdirSync(path.join(logsDir, 'runs', RUN_ID), { recursive: true })
  fs.writeFileSync(path.join(logsDir, 'runs', RUN_ID, 'manifest.json'), JSON.stringify({
    runId: RUN_ID, feature: 'checkout', env: 'local', startedAt: '2026-11-14T05:23:29.706Z',
    status: 'healing', healCycles: 2, services: [], healMode: 'external',
    // The client went stale long before the human answered.
    externalHealSession: { sessionId: 'agent-1', clientKind: 'claude', claimedAt: '2026-11-14T05:23:29.537Z', lastHeartbeatAt: '2026-11-14T05:25:14.757Z', status: 'disconnected', cycleCount: 1 },
  }))
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const orch = {
    runId: RUN_ID,
    stop: vi.fn(async (status?: string) => { store.finalize(RUN_ID, status as 'aborted', new Date().toISOString(), 2) }),
    cancelHeal: vi.fn(async () => ({ ok: true as const })),
    pauseAndHeal: vi.fn(),
  }
  registry.set(RUN_ID, orch as never)
  const broker = new ExternalHealBroker({ now: Date.now, emit: () => {}, patchManifest: (id, patch) => store.patchManifest(id, patch), audit: () => {} })
  const app = Fastify()
  await app.register(registerMcpRoutes, { projectRoot, featuresDir, store, broker })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(async () => { await app.close() })
  const client = new Client({ name: 'declining-desktop', version: '1' }, { capabilities: { elicitation: { form: {} } } })
  client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' as const }))
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))
  cleanups.push(async () => client.close())
  const exec = async (command: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'exec', arguments: { command, arguments: args } })
    return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>
  }
  const askToStop = async () => {
    const asked = await exec('abort_run', { runId: RUN_ID, confirm: true })
    expect(asked).toMatchObject({ status: 'needs-input', approvalId: expect.any(String) })
    return String(asked.approvalId)
  }
  const answer = (id: string, action: 'keep' | 'abort') => fetch(new URL(`/api/approvals/${id}/answer`, address), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(address).origin },
    body: JSON.stringify({ answer: { action } }),
  })
  const approvals = async () => await (await fetch(new URL('/api/approvals', address))).json() as Array<Record<string, unknown>>
  const manifest = () => store.get(RUN_ID)!.manifest
  return { exec, askToStop, answer, approvals, manifest, orch, store, logsDir }
}

describe('Stop this run? answered in Notifications', () => {
  it('stops a healing run as aborted and hands the waiting agent the stop result', async () => {
    const h = await harness()
    const id = await h.askToStop()
    expect((await h.answer(id, 'abort')).status).toBe(200)
    expect(h.orch.stop).toHaveBeenCalledExactlyOnceWith('aborted')
    expect(h.orch.cancelHeal).not.toHaveBeenCalled()
    expect(h.manifest().status).toBe('aborted')
    expect(await h.exec('wait_for_approval', { approvalId: id, timeout_ms: 0 })).toEqual({ aborted: true, runId: RUN_ID })
    expect(await h.approvals()).toMatchObject([{ id, status: 'answered', answer: { action: 'abort' } }])
  })

  it('records Keep running as the answer and tells the agent not to ask again', async () => {
    const h = await harness()
    const id = await h.askToStop()
    await h.answer(id, 'keep')
    expect(h.orch.stop).not.toHaveBeenCalled()
    expect(h.manifest().status).toBe('healing')
    expect(await h.exec('wait_for_approval', { approvalId: id, timeout_ms: 0 })).toMatchObject({ aborted: false, kept: true, runId: RUN_ID })
    expect(await h.approvals()).toMatchObject([{ id, status: 'answered' }])
  })

  it('closes the question as soon as its run ends some other way, so nobody is asked again', async () => {
    const h = await harness()
    const id = await h.askToStop()
    // Stop Heal, a pass, or a server exit: the run reaches a terminal status
    // without this question.
    h.store.finalize(RUN_ID, 'failed', new Date().toISOString(), 2)
    expect(await h.approvals()).toMatchObject([{ id, status: 'expired', error: expect.stringContaining('already ended (failed)') }])
    expect(await h.exec('wait_for_approval', { approvalId: id, timeout_ms: 0 }))
      .toMatchObject({ aborted: false, runId: RUN_ID, status: 'failed', reason: 'run-already-ended' })
    // A late click is refused with the reason instead of silently staying open.
    const late = await h.answer(id, 'abort')
    expect(late.status).toBe(409)
    expect(h.orch.stop).not.toHaveBeenCalled()
  })

  it('gives the agent the same stop result when the human stops the run from the Run panel', async () => {
    const h = await harness()
    const id = await h.askToStop()
    expect(await h.store.abort(RUN_ID)).toEqual({ ok: true })
    expect(h.manifest().status).toBe('aborted')
    expect(await h.exec('wait_for_approval', { approvalId: id, timeout_ms: 0 }))
      .toMatchObject({ aborted: true, runId: RUN_ID, status: 'aborted', reason: 'run-already-ended' })
    expect(await h.approvals()).toMatchObject([{ id, status: 'expired' }])
  })

  it('closes the question of a run deleted from history', async () => {
    const h = await harness()
    const id = await h.askToStop()
    h.store.registry.delete(RUN_ID)
    fs.rmSync(path.join(h.logsDir, 'runs', RUN_ID), { recursive: true })
    h.store.emit('event', { kind: 'removed', runId: RUN_ID })
    expect(await h.exec('wait_for_approval', { approvalId: id, timeout_ms: 0 })).toMatchObject({ status: 'deleted', reason: 'run-already-ended' })
  })

  it('answers a fresh question after an earlier one for the same run expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    cleanups.push(async () => { vi.useRealTimers() })
    const h = await harness()
    const first = await h.askToStop()
    vi.setSystemTime(Date.now() + 31 * 60_000)
    expect(await h.exec('wait_for_approval', { approvalId: first, timeout_ms: 0 })).toMatchObject({ id: first, status: 'expired' })
    const second = await h.askToStop()
    expect(second).not.toBe(first)
    await h.answer(second, 'abort')
    expect(h.manifest().status).toBe('aborted')
    expect(await h.exec('wait_for_approval', { approvalId: second, timeout_ms: 0 })).toEqual({ aborted: true, runId: RUN_ID })
  })
})
