import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDraft, readDraft, type DraftRecord } from '../../features/wizard/logic/draft-store'
import { registerExternalDraftTools } from './authoring-drafts'
import { captureTools } from './__fixtures__/tool-group-harness'

// The external-draft record lifecycle: create → stage updates → apply.
//
// Real filesystem in a tmpdir, because the draft store and the spec writer ARE
// filesystem work — a mocked fs here would only prove the mock. What each test
// pins is the guard: an external client can only move records it owns, and only
// into a feature that exists, because these tools write into the user's
// features/ tree on its word.

let tmpDir: string
let featuresDir: string
let logsDir: string

function writeFeature(name: string, repos: Array<{ name: string; localPath: string; branch?: string }> = []): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: '${name}', description: 'd', envs: ['local'], featureDir: __dirname, repos: ${JSON.stringify(repos)} } }`,
  )
}

/** A feature config with no `repos` key at all — what a bare scaffold writes. */
function writeRepolessFeature(name: string): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: '${name}', description: 'd', envs: ['local'], featureDir: __dirname } }`,
  )
}

/** A draft this MCP surface does NOT own — the internal wizard's own record. */
function seedInternalDraft(over: Partial<DraftRecord> = {}): string {
  const record = createDraft(logsDir, {
    draftId: 'internal-1',
    prdText: 'internal',
    prdDocuments: [],
    repos: [],
    featureName: 'checkout',
    ...over,
  } as never)
  return record.draftId
}

function harness(over: Record<string, unknown> = {}) {
  const published: unknown[] = []
  const tools = captureTools(registerExternalDraftTools, {
    featuresDir,
    store: { logsDir },
    workspaceEvents: { publish: (e: unknown) => published.push(e) },
    ...over,
  })
  return { ...tools, published }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-mcp-drafts-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('start_external_draft', () => {
  it('refuses a feature that does not exist', async () => {
    const { text } = harness()

    expect(await text('start_external_draft', {
      feature: 'ghost', stage: 'scaffolding', session_id: 's', client_kind: 'claude',
    })).toBe('feature not found: ghost')
  })

  it('records the feature\'s repos, carrying a pinned branch and dropping an absent one', async () => {
    writeFeature('checkout', [
      { name: 'shop', localPath: '/repo/shop', branch: 'main' },
      { name: 'api', localPath: '/repo/api' },
    ])
    const { call } = harness()

    const out = await call('start_external_draft', {
      feature: 'checkout', stage: 'scaffolding', session_id: 'sess-1', client_kind: 'claude',
    })

    const stored = readDraft(logsDir, String(out.draftId))!
    expect(stored.repos).toEqual([
      { name: 'shop', localPath: '/repo/shop', branch: 'main' },
      { name: 'api', localPath: '/repo/api' },
    ])
    expect(out).toMatchObject({ canaryLabBehavior: 'tracking-only', feature: 'checkout' })
  })

  it('handles a feature config that declares no repos key at all', async () => {
    writeRepolessFeature('checkout')
    const { call } = harness()

    const out = await call('start_external_draft', {
      feature: 'checkout', stage: 'scaffolding', session_id: 'sess-1', client_kind: 'claude',
    })

    expect(readDraft(logsDir, String(out.draftId))!.repos).toEqual([])
  })

  it('stores the conversation identity when the client supplies it', async () => {
    writeFeature('checkout')
    const { call } = harness()

    const out = await call('start_external_draft', {
      feature: 'checkout', stage: 'authoring-tests', session_id: 'sess-1', client_kind: 'codex',
      conversation_name: 'author checkout specs', external_session_url: 'https://codex/x',
    })

    // The GUI lists these records as external sessions; without the name and
    // URL the row is an anonymous task nobody can trace back to a conversation.
    expect(readDraft(logsDir, String(out.draftId))).toMatchObject({
      externalConversationName: 'author checkout specs',
      externalSessionUrl: 'https://codex/x',
      externalClientKind: 'codex',
      externalSessionId: 'sess-1',
      producer: 'external',
    })
  })

  it('omits the identity fields the client left out', async () => {
    writeFeature('checkout')
    const { call } = harness()

    const out = await call('start_external_draft', {
      feature: 'checkout', stage: 'scaffolding', session_id: 'sess-1', client_kind: 'claude',
    })

    const stored = readDraft(logsDir, String(out.draftId))!
    expect(stored).not.toHaveProperty('externalConversationName')
    expect(stored).not.toHaveProperty('externalSessionUrl')
  })
})

describe('update_external_draft_stage', () => {
  async function seed(): Promise<string> {
    writeFeature('checkout')
    const { call } = harness()
    const out = await call('start_external_draft', {
      feature: 'checkout', stage: 'scaffolding', session_id: 'sess-1', client_kind: 'claude',
    })
    return String(out.draftId)
  }

  it('refuses an unknown draft', async () => {
    const { text } = harness()

    expect(await text('update_external_draft_stage', { draftId: 'nope', stage: 'ready' }))
      .toBe('draft not found: nope')
  })

  it('refuses to move a draft the internal wizard owns', async () => {
    const draftId = seedInternalDraft()
    const { text } = harness()

    // Two producers writing one record would race the GUI's stage display, and
    // an external client has no business steering the internal agent's work.
    expect(await text('update_external_draft_stage', { draftId, stage: 'ready' }))
      .toBe('draft is not external-owned')
  })

  it('advances the stage and the derived status together', async () => {
    const draftId = await seed()
    const { call } = harness()

    const out = await call('update_external_draft_stage', { draftId, stage: 'validating' })

    expect(out).toMatchObject({ draftId, externalStage: 'validating' })
    expect(readDraft(logsDir, draftId)).toMatchObject({ externalStage: 'validating' })
  })

  it('keeps the message only on an error stage', async () => {
    const draftId = await seed()
    const { call } = harness()

    await call('update_external_draft_stage', { draftId, stage: 'ready', message: 'ignore me' })
    expect(readDraft(logsDir, draftId)).not.toHaveProperty('errorMessage')

    await call('update_external_draft_stage', { draftId, stage: 'error', message: 'tsc failed' })
    expect(readDraft(logsDir, draftId)).toMatchObject({ errorMessage: 'tsc failed' })
  })

  it('records an error stage with no message at all', async () => {
    const draftId = await seed()
    const { call } = harness()

    await call('update_external_draft_stage', { draftId, stage: 'error' })

    expect(readDraft(logsDir, draftId)).not.toHaveProperty('errorMessage')
  })
})

describe('apply_external_draft', () => {
  // The fixture import is mandatory — it is what makes a run's per-test log
  // markers line up with the spec that produced them.
  const SPEC = "import { test } from 'canary-lab/feature-support/log-marker-fixture'\ntest('pays', async () => {})\n"

  async function seedExternal(): Promise<string> {
    writeFeature('checkout')
    const { call } = harness()
    const out = await call('start_external_draft', {
      feature: 'checkout', stage: 'ready', session_id: 'sess-1', client_kind: 'claude',
    })
    return String(out.draftId)
  }

  it('refuses an unknown draft', async () => {
    const { text } = harness()

    expect(await text('apply_external_draft', { draftId: 'nope', confirm: true }))
      .toBe('draft not found: nope')
  })

  it('refuses to apply a draft the internal wizard owns', async () => {
    const draftId = seedInternalDraft()
    const { text } = harness()

    expect(await text('apply_external_draft', { draftId, confirm: true }))
      .toBe('draft is not external-owned')
  })

  it('refuses a draft that never named a feature to apply into', async () => {
    const draftId = seedInternalDraft({ producer: 'external', featureName: undefined })
    const { text } = harness()

    expect(await text('apply_external_draft', { draftId, confirm: true }))
      .toBe('external draft has no featureName')
  })

  it('applies the specs already on disk when the client sends no files', async () => {
    const draftId = await seedExternal()
    const e2e = path.join(featuresDir, 'checkout', 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    fs.writeFileSync(path.join(e2e, 'existing.spec.ts'), SPEC, 'utf8')
    const { call } = harness()

    const out = await call('apply_external_draft', { draftId, confirm: true })

    // A client that wrote the files itself (the documented flow) applies with no
    // payload; the draft still has to end up marked applied.
    expect(out).toMatchObject({ status: 'applied' })
    expect(readDraft(logsDir, draftId)).toMatchObject({ externalStage: 'applied' })
  })

  it('writes the specs into the feature, keeps a copy, and announces the change', async () => {
    const draftId = await seedExternal()
    const { call, published } = harness()

    const out = await call('apply_external_draft', {
      draftId, confirm: true, files: [{ path: 'e2e/checkout.spec.ts', content: SPEC }],
    })

    expect(out).toMatchObject({ draftId, feature: 'checkout', status: 'applied' })
    expect(fs.readFileSync(path.join(featuresDir, 'checkout', 'e2e', 'checkout.spec.ts'), 'utf8')).toBe(SPEC)
    // The record keeps its own copy of what it applied, so the GUI can show the
    // draft's output after the feature has moved on.
    expect(readDraft(logsDir, draftId)).toMatchObject({ externalStage: 'applied', status: 'accepted' })
    // Without this the suite list stays stale until a reload.
    expect(published).toEqual([{ type: 'tests-changed', feature: 'checkout' }])
  })

  it('surfaces a rejected spec rather than writing it', async () => {
    const draftId = await seedExternal()
    const { text } = harness()

    const out = await text('apply_external_draft', {
      draftId, confirm: true, files: [{ path: '../../escape.ts', content: 'x' }],
    })

    expect(out).toContain('..')
    expect(fs.existsSync(path.join(tmpDir, 'escape.ts'))).toBe(false)
    // The record must not claim it applied anything.
    expect(readDraft(logsDir, draftId)).not.toMatchObject({ externalStage: 'applied' })
  })

  it('refuses a draft whose feature has been deleted since', async () => {
    const draftId = await seedExternal()
    fs.rmSync(path.join(featuresDir, 'checkout'), { recursive: true, force: true })
    const { text } = harness()

    expect(await text('apply_external_draft', { draftId, confirm: true, files: [] }))
      .toBe('feature not found: checkout')
  })

  it('is marked destructive — it overwrites files in the user\'s features tree', async () => {
    const { configs } = harness()

    expect(configs.get('apply_external_draft')!.annotations).toMatchObject({ destructiveHint: true })
    expect(Object.keys(configs.get('apply_external_draft')!.inputSchema!)).toContain('confirm')
  })
})
