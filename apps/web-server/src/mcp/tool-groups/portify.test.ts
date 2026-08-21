import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from '../../features/runs/logic/run-store'
import { registerPortifyTools } from './portify'
import { captureTools } from './__fixtures__/tool-group-harness'

// The six port-ification tools, plus the two heal reads' not-found arms.
//
// Every one of these is a thin, deliberate wrapper: a dependency guard, a call,
// and a `next` that tells an external client what to do with the answer. That
// wrapper is exactly where the mistakes live — a missing dep that throws instead
// of explaining itself, a thrown Error surfaced as "[object Object]", or a
// `next` that sends the client to cancel_portify (throwing away verified work)
// when it should send it to revise. The runner, the double-boot and the overlay
// are covered against real worktrees in features/portify/logic.

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  workflowId: 'wf-1',
  feature: 'checkout',
  status: 'editing',
  attempts: 1,
  ...over,
})

const DIFF = [
  'diff --git a/src/server.ts b/src/server.ts',
  '--- a/src/server.ts',
  '+++ b/src/server.ts',
  '@@ -1,2 +1,2 @@',
  '-app.listen(4000)',
  '+app.listen(Number(process.env.PORT))',
].join('\n')

function harness(deps: Record<string, unknown>) {
  return captureTools(registerPortifyTools, { featuresDir: '/nowhere', ...deps })
}

describe('start_external_portify', () => {
  it('hands back the edit targets and what to do with them', async () => {
    const startExternalPortify = vi.fn(async () => ({
      workflowId: 'wf-1',
      configPath: '/features/checkout/feature.config.cjs',
      targets: [{ repo: 'shop', path: '/tmp/wt/shop/src/server.ts' }],
      instructions: 'declare a port slot per listener',
    }))
    const { call } = harness({ startExternalPortify })

    const out = await call('start_external_portify', {
      feature: 'checkout', session_id: 'sess-1', client_kind: 'claude',
      conversation_name: 'portify checkout', external_session_url: 'https://claude.ai/x',
    })

    expect(startExternalPortify).toHaveBeenCalledWith({
      feature: 'checkout', clientKind: 'claude', sessionId: 'sess-1',
      conversationName: 'portify checkout', sessionUrl: 'https://claude.ai/x',
    })
    expect(out).toMatchObject({
      workflowId: 'wf-1',
      status: 'editing',
      canaryLabBehavior: 'tracking-only',
      nextSteps: ['submit_external_portify'],
    })
    // The config path has to be in the steering: the slots are declared THERE,
    // and a client that only edits sources submits an unverifiable workflow.
    expect(String(out.next)).toContain('/features/checkout/feature.config.cjs')
    expect(String(out.next)).toContain('wf-1')
  })

  it('omits the optional identity fields the caller left out', async () => {
    const startExternalPortify = vi.fn(async () => ({ workflowId: 'wf-1', configPath: '/c', targets: [] }))
    const { call } = harness({ startExternalPortify })

    await call('start_external_portify', { feature: 'checkout', session_id: 'sess-1', client_kind: 'codex' })

    expect(startExternalPortify).toHaveBeenCalledWith({
      feature: 'checkout', clientKind: 'codex', sessionId: 'sess-1',
    })
  })

  it('reports a refusal in the words the runner used', async () => {
    const { text } = harness({
      startExternalPortify: async () => { throw new Error('a portify workflow already exists for checkout') },
    })

    expect(await text('start_external_portify', { feature: 'checkout', session_id: 's', client_kind: 'claude' }))
      .toContain('a portify workflow already exists for checkout')
  })

  it('stringifies a non-Error rejection rather than reporting an object', async () => {
    const { text } = harness({
      // The runner rejects with a plain object on some paths; "[object Object]"
      // would leave the client with nothing to act on.
      startExternalPortify: async () => { throw 'at capacity' },
    })

    expect(await text('start_external_portify', { feature: 'checkout', session_id: 's', client_kind: 'claude' }))
      .toContain('at capacity')
  })
})

describe('submit_external_portify', () => {
  it('returns the parked manifest and the poll instruction', async () => {
    const { call } = harness({ submitExternalPortify: async () => manifest({ status: 'verifying' }) })

    const out = await call('submit_external_portify', { workflowId: 'wf-1' })

    expect(out).toMatchObject({ workflowId: 'wf-1', status: 'verifying', nextSteps: ['get_portify'] })
    // The failure path has to be named here: submit is fire-and-forget, so a
    // client that only waits for "ready-to-save" hangs on a failed double-boot.
    expect(String(out.next)).toContain('if it returns to "editing"')
  })

  it('surfaces a rejected submit', async () => {
    const { text } = harness({
      submitExternalPortify: async () => { throw new Error('workflow wf-1 is not in editing') },
    })

    expect(await text('submit_external_portify', { workflowId: 'wf-1' }))
      .toContain('workflow wf-1 is not in editing')
  })
})

describe('revise_external_portify', () => {
  it('reopens the verified worktree and says the edits are still there', async () => {
    const reviseExternalPortify = vi.fn(() => ({
      manifest: manifest({ status: 'editing', diff: DIFF }),
      instructions: 'ports only; never touch test files',
    }))
    const { call } = harness({ reviseExternalPortify })

    const out = await call('revise_external_portify', { workflowId: 'wf-1', feedback: 'use 4100' })

    expect(reviseExternalPortify).toHaveBeenCalledWith('wf-1', 'use 4100')
    expect(out).toMatchObject({
      workflowId: 'wf-1',
      status: 'editing',
      prompt: 'ports only; never touch test files',
      diffOmitted: true,
      diffStats: { files: 1, additions: 1, deletions: 1 },
    })
    // Not a fresh start: telling the client to start over is how verified work
    // gets thrown away.
    expect(String(out.next)).toContain('do not start over')
    expect(out).not.toHaveProperty('diff')
  })

  it('omits the diff summary when the workflow has no diff yet', async () => {
    const { call } = harness({
      reviseExternalPortify: () => ({ manifest: manifest({ status: 'editing' }), instructions: 'go' }),
    })

    const out = await call('revise_external_portify', { workflowId: 'wf-1', feedback: 'x' })

    expect(out).not.toHaveProperty('diffStats')
    expect(out).not.toHaveProperty('diffOmitted')
  })

  it('surfaces a revise refused because the workflow is not verified', async () => {
    const { text } = harness({
      reviseExternalPortify: () => { throw new Error('workflow wf-1 is not ready-to-save') },
    })

    expect(await text('revise_external_portify', { workflowId: 'wf-1', feedback: 'x' }))
      .toContain('workflow wf-1 is not ready-to-save')
  })
})

describe('get_portify', () => {
  it('summarizes the diff by default and inlines it on request', async () => {
    const deps = { getPortify: () => manifest({ status: 'ready-to-save', diff: DIFF }) }

    const omitted = await harness(deps).call('get_portify', { workflowId: 'wf-1', includeDiff: false })
    expect(omitted).toMatchObject({ diffOmitted: true, diffStats: { files: 1 } })
    expect(omitted).not.toHaveProperty('diff')

    const inlined = await harness(deps).call('get_portify', { workflowId: 'wf-1', includeDiff: true })
    expect(inlined.diff).toBe(DIFF)
    expect(inlined).not.toHaveProperty('diffOmitted')
  })

  it('reads a diff-less workflow without inventing stats', async () => {
    const { call } = harness({ getPortify: () => manifest({ status: 'planning' }) })

    const out = await call('get_portify', { workflowId: 'wf-1', includeDiff: false })

    expect(out).toMatchObject({ status: 'planning' })
    expect(out).not.toHaveProperty('diffStats')
  })

  it('rides the retry playbook when the double-boot failed', async () => {
    const deps = {
      getPortify: () => manifest({ status: 'editing', verification: { ok: false, failureDetail: 'port 4000 in use' } }),
      externalPortifyRetryPrompt: () => 're-scan the non-HTTP listeners',
    }

    const out = await harness(deps).call('get_portify', { workflowId: 'wf-1', includeDiff: false })

    expect(out).toMatchObject({ prompt: 're-scan the non-HTTP listeners', nextSteps: ['submit_external_portify'] })
    expect(String(out.next)).toContain('Verification FAILED')

    // And it survives the includeDiff path, which returns a different shape.
    const inlined = await harness(deps).call('get_portify', { workflowId: 'wf-1', includeDiff: true })
    expect(inlined.prompt).toBe('re-scan the non-HTTP listeners')
  })

  it('adds no retry framing when there is no failure to explain', async () => {
    const { call } = harness({
      getPortify: () => manifest({ status: 'ready-to-save' }),
      externalPortifyRetryPrompt: () => null,
    })

    const out = await call('get_portify', { workflowId: 'wf-1', includeDiff: false })

    expect(out).not.toHaveProperty('prompt')
  })

  it('works on a build with no retry-prompt dependency at all', async () => {
    const { call } = harness({ getPortify: () => manifest({ status: 'editing' }) })

    expect(await call('get_portify', { workflowId: 'wf-1', includeDiff: false })).not.toHaveProperty('prompt')
  })

  it('reports an unknown workflow id', async () => {
    const { text } = harness({ getPortify: () => null })

    expect(await text('get_portify', { workflowId: 'nope', includeDiff: false }))
      .toContain('port-ification workflow not found: nope')
  })
})

describe('save_portify', () => {
  it('saves and announces the feature change', async () => {
    const published: unknown[] = []
    const { call } = harness({
      savePortify: async () => manifest({ status: 'saved' }),
      workspaceEvents: { publish: (e: unknown) => published.push(e) },
    })

    const out = await call('save_portify', { workflowId: 'wf-1', confirm: true })

    expect(out).toMatchObject({ status: 'saved' })
    // Without the event the Ports tab keeps showing the feature as unportified
    // until a reload — the whole point of the WS-driven state rule.
    expect(published).toEqual([{ type: 'features-changed' }])
    expect(String(out.next)).toContain('features/checkout/portify/')
  })

  it('saves on a build with no workspace event bus wired', async () => {
    const { call } = harness({ savePortify: async () => manifest({ status: 'saved' }) })

    expect(await call('save_portify', { workflowId: 'wf-1', confirm: true })).toMatchObject({ status: 'saved' })
  })

  it('surfaces a save refused because the workflow is not verified', async () => {
    const { text } = harness({
      savePortify: async () => { throw new Error('workflow wf-1 is not ready-to-save') },
    })

    expect(await text('save_portify', { workflowId: 'wf-1', confirm: true }))
      .toContain('workflow wf-1 is not ready-to-save')
  })

  it('gates on confirm and is not marked destructive', async () => {
    const { configs } = harness({ savePortify: async () => manifest() })

    // Saving is additive — the overlay is written, nothing is discarded — so it
    // asks for confirmation without claiming to destroy anything.
    expect(Object.keys(configs.get('save_portify')!.inputSchema!)).toContain('confirm')
    expect(configs.get('save_portify')!.annotations).toMatchObject({ destructiveHint: false })
  })
})

describe('cancel_portify and remove_portification', () => {
  it('cancels and returns the discarded workflow', async () => {
    const cancelPortify = vi.fn(async () => manifest({ status: 'aborted' }))
    const { call } = harness({ cancelPortify })

    expect(await call('cancel_portify', { workflowId: 'wf-1', confirm: true })).toMatchObject({ status: 'aborted' })
    expect(cancelPortify).toHaveBeenCalledWith('wf-1')
  })

  it('surfaces a cancel refusal', async () => {
    const { text } = harness({ cancelPortify: async () => { throw new Error('already aborted') } })

    expect(await text('cancel_portify', { workflowId: 'wf-1', confirm: true })).toContain('already aborted')
  })

  it('un-portifies a feature and announces it', async () => {
    const published: unknown[] = []
    const { call } = harness({
      removePortification: () => ({ name: 'checkout', portified: false, reverted: true }),
      workspaceEvents: { publish: (e: unknown) => published.push(e) },
    })

    expect(await call('remove_portification', { feature: 'checkout', confirm: true }))
      .toEqual({ name: 'checkout', portified: false, reverted: true })
    expect(published).toEqual([{ type: 'features-changed' }])
  })

  it('surfaces a failed un-portify', async () => {
    const { text } = harness({
      removePortification: () => { throw new Error('feature not found: ghost') },
    })

    expect(await text('remove_portification', { feature: 'ghost', confirm: true }))
      .toContain('feature not found: ghost')
  })

  it('marks both as destructive, and only the idempotent one as idempotent', async () => {
    const { configs } = harness({})

    expect(configs.get('cancel_portify')!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false })
    // Removing a portification twice lands on the same state, so a retry after a
    // dropped response is safe to make.
    expect(configs.get('remove_portification')!.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true })
  })
})

describe('every portify tool refuses cleanly with its dependency missing', () => {
  const CASES: Array<[string, string, Record<string, unknown>]> = [
    ['start_external_portify', 'startExternalPortify', { feature: 'checkout', session_id: 's', client_kind: 'claude' }],
    ['submit_external_portify', 'submitExternalPortify', { workflowId: 'wf-1' }],
    ['revise_external_portify', 'reviseExternalPortify', { workflowId: 'wf-1', feedback: 'x' }],
    ['get_portify', 'getPortify', { workflowId: 'wf-1', includeDiff: false }],
    ['save_portify', 'savePortify', { workflowId: 'wf-1', confirm: true }],
    ['cancel_portify', 'cancelPortify', { workflowId: 'wf-1', confirm: true }],
    ['remove_portification', 'removePortification', { feature: 'checkout', confirm: true }],
  ]

  for (const [tool, dep, args] of CASES) {
    it(`${tool} names the missing ${dep}`, async () => {
      const { text } = harness({})

      // These deps are wired by the web server; a CLI-only MCP boot registers
      // the tools without them and must say so rather than throwing.
      expect(await text(tool, args)).toBe(`${dep} dependency is not configured`)
    })
  }
})

describe('the two heal reads', () => {
  let logsDir: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-heal-')))
    logsDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const detail = (): RunDetail => ({
    runId: 'run-1',
    manifest: {
      runId: 'run-1',
      feature: 'checkout',
      env: 'local',
      startedAt: '2026-05-25T08:00:00.000Z',
      status: 'healing',
      healMode: 'external',
      healCycles: 1,
      services: [],
    },
    summary: {
      complete: false,
      total: 1,
      passed: 0,
      failed: [{ name: 'checkout fails', error: { message: 'boom' }, location: 'e2e/checkout.spec.ts:1:1' }],
    },
  } as unknown as RunDetail)

  const missingStore = { get: () => undefined, logsDir: '/logs' }

  it('get_heal_context reports the missing run', async () => {
    const { text } = harness({ store: missingStore, projectRoot: '/root' })

    expect(await text('get_heal_context', { runId: 'nope', client_kind: 'claude' }))
      .toBe('run not found: nope')
  })

  it('get_failure_detail reports the missing run before looking for the failure', async () => {
    const { text } = harness({ store: missingStore, projectRoot: '/root' })

    expect(await text('get_failure_detail', { runId: 'nope', failureId: 'a test', client_kind: 'claude' }))
      .toBe('run not found: nope')
  })

  it('reads a heal context without a session, touching no heartbeat', async () => {
    const touch = vi.fn()
    const { call } = harness({
      store: { get: () => detail(), logsDir },
      broker: { touch },
      projectRoot: tmpDir,
    })

    const out = await call('get_heal_context', { runId: 'run-1', client_kind: 'claude' })

    expect(out).toMatchObject({ runId: 'run-1', feature: 'checkout' })
    // `session_id` is what identifies a claim; without one there is no session
    // to keep alive, and touching an unowned run would forge liveness.
    expect(touch).not.toHaveBeenCalled()
  })

  it('reads one failure without a session', async () => {
    const touch = vi.fn()
    const { call } = harness({
      store: { get: () => detail(), logsDir },
      broker: { touch },
      projectRoot: tmpDir,
    })

    const out = await call('get_failure_detail', { runId: 'run-1', failureId: 'checkout fails', client_kind: 'claude' })

    expect(out).toMatchObject({ failureId: 'checkout fails' })
    expect(touch).not.toHaveBeenCalled()
  })

  it('claims and heartbeats the session on both reads when one is supplied', async () => {
    const touch = vi.fn()
    const claim = vi.fn(() => ({ accepted: true, session: {} }))
    const deps = {
      store: { get: () => detail(), logsDir },
      // No session held yet, and the run is in external heal mode, so the read
      // adopts the claim rather than working anonymously — that is what makes a
      // later signal_run from this session recognised as the owner.
      broker: { touch, claim, getSession: () => null },
      projectRoot: tmpDir,
    }

    await harness(deps).call('get_heal_context', { runId: 'run-1', session_id: 'sess-1', client_kind: 'claude' })
    await harness(deps).call('get_failure_detail', {
      runId: 'run-1', failureId: 'checkout fails', session_id: 'sess-1', client_kind: 'claude',
    })

    expect(claim).toHaveBeenCalledWith('run-1', { sessionId: 'sess-1', clientKind: 'claude' })
    // Heartbeat AFTER the read succeeds: a failed lookup must not keep a session
    // looking alive.
    expect(touch.mock.calls).toEqual([['run-1', 'sess-1'], ['run-1', 'sess-1']])
  })

  it('does not heartbeat when the failure lookup fails', async () => {
    const touch = vi.fn()
    const { text } = harness({
      store: { get: () => detail(), logsDir },
      broker: { touch, claim: vi.fn(() => ({ accepted: true, session: {} })), getSession: () => null },
      projectRoot: tmpDir,
    })

    expect(await text('get_failure_detail', {
      runId: 'run-1', failureId: 'no such test', session_id: 'sess-1', client_kind: 'claude',
    })).toContain('failure not found')
    expect(touch).not.toHaveBeenCalled()
  })

  it('names the failureId that did not match, and where to get a real one', async () => {
    const { text } = harness({ store: { get: () => detail(), logsDir }, broker: { touch: vi.fn() }, projectRoot: tmpDir })

    expect(await text('get_failure_detail', { runId: 'run-1', failureId: 'no such test', client_kind: 'claude' }))
      .toContain('failure not found: no such test')
  })
})
