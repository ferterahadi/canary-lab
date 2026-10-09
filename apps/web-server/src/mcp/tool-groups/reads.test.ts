import { RunStore } from '../../features/runs/logic/run-store'
import { createRegistry } from '../../features/runs/logic/run-registry'
import fs from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decode } from '@toon-format/toon'
import type { RunDetail } from '../../../../../shared/run-detail'
import { registerReadTools } from './reads'
import { captureTools } from './__fixtures__/tool-group-harness'
import { writeFeatureFixture } from '../../../../../tools/test-helpers/feature-fixture'
import { trackTempDirs } from '../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-mcp-reads-')

// The read tools: the feature/run listings, the three run reads, and the Verify
// config CRUD.
//
// Two things here are load-bearing rather than incidental. First, the TOON
// packing: `list_features` flattens envs/repos into delimited scalars so the
// table stays one row per feature, and a regression there silently doubles the
// tokens every client spends on it. Second, every read refuses an unknown id by
// name — an empty result would read to an agent as "this run has no failures".

let tmpDir: string
let featuresDir: string
let logsDir: string

function writeFeature(name: string, extra: Record<string, unknown> = {}): void {
  writeFeatureFixture(featuresDir, name, { envs: ['local'], repos: [], ...extra })
}

function runDetail(over: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}): RunDetail {
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1', feature: 'checkout', env: 'local',
      startedAt: '2026-05-25T08:00:00.000Z', status: 'running',
      healCycles: 0, services: [],
      ...manifest,
    },
    summary: { complete: false, total: 1, passed: 0, failed: [] },
    lifecycleEvents: [{ phase: 'booting' }],
    playwrightArtifacts: [{ name: 'trace.zip' }],
    playbackEvents: [{ test: 'pays' }],
    attemptArtifacts: { '0': [{ name: 'test-failed-1.png' }] },
    unassignedArtifacts: [{ name: 'trace.zip', execution: 1 }],
    ...over,
  } as unknown as RunDetail
}

function harness(over: Record<string, unknown> = {}) {
  const published: unknown[] = []
  const tools = captureTools(registerReadTools, {
    featuresDir,
    projectRoot: tmpDir,
    store: { logsDir, list: () => [], get: () => undefined },
    broker: { getSession: () => null },
    workspaceEvents: { publish: (e: unknown) => published.push(e) },
    ...over,
  })
  return { ...tools, published }
}

beforeEach(() => {
  tmpDir = tempDir()
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

describe('list_features', () => {
  it('packs envs and repos into one flat row per feature', async () => {
    writeFeature('checkout', {
      envs: ['local', 'staging'],
      repos: [
        { name: 'shop', localPath: '/repo/shop', branch: 'main' },
        { name: 'api', localPath: '/repo/api' },
      ],
    })
    const { text } = harness()

    const rows = decode(await text('list_features')) as Array<Record<string, string>>

    // Delimited scalars, not nested lists: the nested form drops TOON out of its
    // tabular shape and roughly doubles the tokens.
    expect(rows).toEqual([{
      name: 'checkout',
      description: 'd',
      envs: 'local|staging',
      repos: 'shop@/repo/shop@main|api@/repo/api@',
    }])
  })

  it('renders a feature with no envs, repos, or description', async () => {
    writeFeature('bare', { envs: undefined, repos: undefined, description: undefined })
    const { text } = harness()

    expect(decode(await text('list_features'))).toEqual([
      { name: 'bare', description: '', envs: '', repos: '' },
    ])
  })

  it('lists nothing for an empty workspace', async () => {
    const { text } = harness()

    expect(decode(await text('list_features'))).toEqual([])
  })
})

describe('list_runs', () => {
  const rows = [
    { runId: 'r3', feature: 'checkout', status: 'passed' },
    { runId: 'r2', feature: 'search', status: 'failed' },
    { runId: 'r1', feature: 'checkout', status: 'passed' },
  ]

  it('passes the feature filter through and caps at the limit', async () => {
    const list = vi.fn(() => rows)
    const { text } = harness({ store: { logsDir, list, get: () => undefined } })

    const out = decode(await text('list_runs', { feature: 'checkout', limit: 2 })) as unknown[]

    expect(list).toHaveBeenCalledWith({ feature: 'checkout' })
    expect(out).toHaveLength(2)
  })

  it('lists across every feature when none is named', async () => {
    const list = vi.fn(() => rows)
    const { text } = harness({ store: { logsDir, list, get: () => undefined } })

    await text('list_runs', { limit: 20 })

    expect(list).toHaveBeenCalledWith({})
  })
})

describe('get_run', () => {
  it('reports an unknown run by id', async () => {
    const { text } = harness()

    expect(await text('get_run', { runId: 'nope', includeRaw: false })).toBe('run not found: nope')
  })

  it('omits the bulky arrays by default, and says how to get them', async () => {
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail() } })

    const out = await call('get_run', { runId: 'run-1', includeRaw: false })

    expect(out).not.toHaveProperty('lifecycleEvents')
    expect(out).not.toHaveProperty('playwrightArtifacts')
    expect(out).not.toHaveProperty('playbackEvents')
    // Per-execution media grows with every rerun: an agent asks for it.
    expect(out).not.toHaveProperty('attemptArtifacts')
    expect(out).not.toHaveProperty('unassignedArtifacts')
    expect(out).toMatchObject({
      artifactsBase: '/api/runs/run-1/artifacts/',
      raw: { omitted: ['lifecycleEvents', 'playwrightArtifacts', 'playbackEvents', 'attemptArtifacts', 'unassignedArtifacts'] },
    })
    // A running run has no next step to recommend yet.
    expect(out).not.toHaveProperty('next')
  })

  it('inlines the raw arrays on request', async () => {
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail() } })

    const out = await call('get_run', { runId: 'run-1', includeRaw: true })

    expect(out.lifecycleEvents).toEqual([{ phase: 'booting' }])
    expect(out).not.toHaveProperty('raw')
  })

  for (const status of ['passed', 'failed'] as const) {
    it(`points a ${status} run at the evaluation export`, async () => {
      const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail({}, { status }) } })

      const out = await call('get_run', { runId: 'run-1', includeRaw: false })

      // Reviewing the export IS the loop, so a terminal run says so — including
      // a failed one, which must be exportable as-is rather than healed first.
      expect(String(out.next)).toContain('/canary-lab-export run-1')
      expect(String(out.next)).not.toContain('npx canary-lab export run-1')
      expect(String(out.next)).toContain('start_external_evaluation_export')
      expect(String(out.next)).toContain(status)
    })
  }

  it('lifts pending spec edits to a top-level warning with next steps', async () => {
    const manifest = {
      status: 'passed',
      specEdits: {
        checkedAt: 't',
        pending: [{ file: 'e2e/voucher.spec.ts', change: 'modified', affectedTests: ['applies voucher'] }],
        adopted: [],
      },
      integrity: { hints: [], disclosure: 'd' },
    }
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail({}, manifest) } })

    const out = await call('get_run', { runId: 'run-1', includeRaw: false })

    // The manifest already carries the raw record; the top-level block is what
    // tells an agent reading the core view what to do about it.
    expect(out.specEdits).toMatchObject({
      pending: [{ file: 'e2e/voucher.spec.ts', change: 'modified' }],
      nextSteps: [expect.stringContaining('ask the human to adopt')],
    })
  })

  it('keeps the specEdits block on the includeRaw path too', async () => {
    const manifest = {
      specEdits: { checkedAt: 't', pending: [{ file: 'e2e/voucher.spec.ts', change: 'added', affectedTests: [] }], adopted: [] },
    }
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail({}, manifest) } })

    const out = await call('get_run', { runId: 'run-1', includeRaw: true })

    expect(out.specEdits).toMatchObject({ pending: [{ file: 'e2e/voucher.spec.ts' }], hints: [] })
  })

  it('has no specEdits block when the run recorded none', async () => {
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail() } })

    expect(await call('get_run', { runId: 'run-1', includeRaw: false })).not.toHaveProperty('specEdits')
  })

  it('keeps the terminal steer on the includeRaw path too', async () => {
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail({}, { status: 'passed' }) } })

    expect(String((await call('get_run', { runId: 'run-1', includeRaw: true })).next))
      .toContain('/canary-lab-export run-1')
  })
})

describe('get_run_snapshot', () => {
  it('reports an unknown run by id', async () => {
    const { text } = harness()

    expect(await text('get_run_snapshot', { runId: 'nope' })).toBe('run not found: nope')
  })

  it('returns the slim snapshot for a real run', async () => {
    const { call } = harness({ store: { logsDir, list: () => [], get: () => runDetail() } })

    const out = await call('get_run_snapshot', { runId: 'run-1' })

    expect(out).toMatchObject({ runId: 'run-1', feature: 'checkout' })
  })
})

describe('get_run_actions', () => {
  it('reports an unknown run by id', async () => {
    const { text } = harness()

    expect(await text('get_run_actions', { runId: 'nope' })).toBe('run not found: nope')
  })

  it('offers the signal kinds on an active run, and the export on a terminal one', async () => {
    const active = harness({ store: { logsDir, list: () => [], get: () => runDetail({}, { status: 'healing' }) } })
    const out = await active.call('get_run_actions', { runId: 'run-1' })
    expect(out).toMatchObject({
      status: 'healing',
      signal: { rerun: true, restart: true, heal: true },
      evaluationExport: { available: false },
    })

    const done = harness({ store: { logsDir, list: () => [], get: () => runDetail({}, { status: 'passed' }) } })
    expect(await done.call('get_run_actions', { runId: 'run-1' })).toMatchObject({
      signal: { rerun: false, restart: false, heal: false },
      evaluationExport: { available: true },
    })
  })

  it('carries whoever currently owns the heal claim', async () => {
    const session = { sessionId: 'sess-1', clientKind: 'claude' }
    const { call } = harness({
      store: { logsDir, list: () => [], get: () => runDetail({}, { status: 'healing' }) },
      broker: { getSession: () => session },
    })

    expect((await call('get_run_actions', { runId: 'run-1' })).externalClaim).toEqual(session)
  })
})

describe('the Verify config CRUD', () => {
  const CONFIG = { name: 'Beta', targetUrls: { web: 'https://beta.example.com' }, playwrightEnvsetId: 'local' }

  it('refuses every call for an unknown feature', async () => {
    const { text } = harness()

    expect(await text('list_verification_configs', { featureId: 'ghost' })).toBe('feature not found: ghost')
    expect(await text('get_verification_config', { featureId: 'ghost', configId: 'c1' })).toBe('feature not found: ghost')
    expect(await text('create_verification_config', { featureId: 'ghost', ...CONFIG })).toBe('feature not found: ghost')
    expect(await text('update_verification_config', { featureId: 'ghost', configId: 'c1', ...CONFIG })).toBe('feature not found: ghost')
  })

  it('creates, lists, reads and updates one config', async () => {
    writeFeature('checkout')
    const { call, published } = harness()

    const created = await call('create_verification_config', { featureId: 'checkout', ...CONFIG })
    const configId = String(created.id)
    expect(created).toMatchObject({ name: 'Beta' })
    expect(published.length).toBeGreaterThan(0)

    // The list is the array itself, not a { configs } envelope.
    const listed = await call('list_verification_configs', { featureId: 'checkout' }) as unknown as Array<Record<string, unknown>>
    expect(listed).toMatchObject([{ id: configId, name: 'Beta' }])

    expect(await call('get_verification_config', { featureId: 'checkout', configId }))
      .toMatchObject({ id: configId, name: 'Beta' })

    expect(await call('update_verification_config', {
      featureId: 'checkout', configId, ...CONFIG, name: 'Staging',
    })).toMatchObject({ id: configId, name: 'Staging' })
  })

  it('reports a write failure instead of letting it escape as a tool crash', async () => {
    writeFeature('checkout')
    const featureDir = path.join(featuresDir, 'checkout')
    fs.chmodSync(featureDir, 0o500)
    try {
      const { text } = harness()

      // A read-only feature directory. The config writer has no try/catch of its
      // own, so the throw lands in the tool; letting it escape would hand the
      // client a protocol error with no message it can act on.
      expect(await text('create_verification_config', { featureId: 'checkout', ...CONFIG }))
        .toMatch(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(featureDir, 0o700)
    }
  })

  it('reports an update write failure the same way', async () => {
    writeFeature('checkout')
    const { call } = harness()
    const created = await call('create_verification_config', { featureId: 'checkout', ...CONFIG })
    // The configs live in one file directly under the feature dir, so making
    // the DIRECTORY read-only is what blocks the atomic tmp-write + rename.
    const featureDir = path.join(featuresDir, 'checkout')
    fs.chmodSync(featureDir, 0o500)
    try {
      const { text } = harness()

      expect(await text('update_verification_config', {
        featureId: 'checkout', configId: String(created.id), ...CONFIG, name: 'Staging',
      })).toMatch(/EACCES|permission denied/i)
    } finally {
      fs.chmodSync(featureDir, 0o700)
    }
  })

  it('reports an unknown config id on read and on update', async () => {
    writeFeature('checkout')
    const { text } = harness()

    expect(await text('get_verification_config', { featureId: 'checkout', configId: 'nope' }))
      .toBe('verification config not found: nope')
    expect(await text('update_verification_config', { featureId: 'checkout', configId: 'nope', ...CONFIG }))
      .toBe('verification config not found: nope')
  })
})

describe('execute_verification', () => {
  it('says so when the verification runner is not wired', async () => {
    const { text } = harness()

    expect(await text('execute_verification', { featureId: 'checkout' }))
      .toBe('startVerification dependency is not configured')
  })

  it('forwards only the inputs the caller supplied', async () => {
    const startVerification = vi.fn(async () => ({ runId: 'verify-1' }))
    const { call } = harness({ startVerification })

    await call('execute_verification', { featureId: 'checkout' })
    expect(startVerification).toHaveBeenLastCalledWith('checkout', {})

    await call('execute_verification', {
      featureId: 'checkout', configId: 'c1',
      targetUrls: { web: 'https://beta' }, playwrightEnvsetId: 'local',
    })
    expect(startVerification).toHaveBeenLastCalledWith('checkout', {
      configId: 'c1', targetUrls: { web: 'https://beta' }, playwrightEnvsetId: 'local',
    })
  })

  it('reports a queued execution when the record has not landed yet', async () => {
    const { call } = harness({ startVerification: async () => ({ runId: 'verify-1' }) })

    const out = await call('execute_verification', {
      featureId: 'checkout', targetUrls: { web: 'https://beta' }, playwrightEnvsetId: 'local',
    })

    // The run is started but its manifest is not written yet; answering with the
    // id and `queued` beats answering "not found" for something just created.
    expect(out).toEqual({
      executionId: 'verify-1',
      executionType: 'verify',
      status: 'queued',
      targetUrls: { web: 'https://beta' },
      playwrightEnvsetId: 'local',
    })
  })

  it('defaults the echoed inputs when the caller passed none', async () => {
    const { call } = harness({ startVerification: async () => ({ runId: 'verify-1' }) })

    expect(await call('execute_verification', { featureId: 'checkout' }))
      .toMatchObject({ targetUrls: {}, playwrightEnvsetId: '' })
  })

  it('returns the real result once the record exists', async () => {
    const detail = runDetail({}, { executionType: 'verify', status: 'passed' })
    const { call } = harness({
      startVerification: async () => ({ runId: 'run-1' }),
      store: { logsDir, list: () => [], get: () => detail },
    })

    expect(await call('execute_verification', { featureId: 'checkout' }))
      .toMatchObject({ executionId: 'run-1' })
  })

  it('surfaces a rejected start', async () => {
    const { text } = harness({
      startVerification: async () => { throw new Error('no playwright envset named local') },
    })

    expect(await text('execute_verification', { featureId: 'checkout' }))
      .toBe('no playwright envset named local')
  })
})

describe('get_verification_result', () => {
  it('reports an unknown execution id', async () => {
    const { text } = harness()

    expect(await text('get_verification_result', { executionId: 'nope' }))
      .toBe('verification result not found: nope')
  })

  it('refuses a run that is not a verification', async () => {
    const { text } = harness({ store: { logsDir, list: () => [], get: () => runDetail() } })

    // A plain test run has different semantics (it heals, it has services), so
    // rendering it through the Verify shape would misreport it.
    expect(await text('get_verification_result', { executionId: 'run-1' }))
      .toBe('execution is not verify: run-1')
  })

  it('returns the verification result for a verify execution', async () => {
    const detail = runDetail({}, { executionType: 'verify', status: 'failed' })
    const { call } = harness({ store: { logsDir, list: () => [], get: () => detail } })

    expect(await call('get_verification_result', { executionId: 'run-1' }))
      .toMatchObject({ executionId: 'run-1' })
  })
})

it('reads current persisted completed-run evidence after direct external writes', async () => {
  const store = new RunStore(logsDir, createRegistry())
  const manifest = runDetail({}, { status: 'passed' }).manifest
  store.bootstrap(manifest)
  const { call } = harness({ store })
  expect(await call('get_run', { runId: 'run-1', includeRaw: true })).toMatchObject({ manifest: { status: 'passed' } })
  const dir = path.join(logsDir, 'runs', 'run-1')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, status: 'failed' }))
  const event = { id: 'external', phase: 'completed', headline: 'Direct file evidence', updatedAt: '2026-01-01T00:00:00Z' }
  fs.writeFileSync(path.join(dir, 'lifecycle-events.jsonl'), JSON.stringify(event) + '\npartial')
  fs.writeFileSync(path.join(dir, 'diagnosis-journal.md'), 'external journal')
  expect(await call('get_run', { runId: 'run-1', includeRaw: true })).toMatchObject({ manifest: { status: 'failed' }, lifecycleEvents: [event] })
  const snapshot = await call('get_run_snapshot', { runId: 'run-1' })
  expect(snapshot).toMatchObject({ runId: 'run-1', status: 'failed' })
  expect(JSON.stringify(snapshot)).toContain('diagnosis-journal.md')
})
