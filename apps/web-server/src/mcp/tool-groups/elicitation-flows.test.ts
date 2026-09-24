import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerContext, InputRequiredResult, CallToolResult } from '@modelcontextprotocol/server'
import { captureTools } from './__fixtures__/tool-group-harness'
import { registerFlightTools } from './flight'
import { registerPortifyTools } from './portify'
import { registerReadTools } from './reads'

const facts = { surface: 'codex' as const, canFanOut: false, sampling: false, elicitation: { form: true, url: true } }
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'domain-tests', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const text = (result: CallToolResult | InputRequiredResult) => (result.content as Array<{ text: string }>)[0].text
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function feature() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-input-flow-'))
  roots.push(projectRoot)
  const featuresDir = path.join(projectRoot, 'features')
  const dir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), "module.exports = { config: { name: 'checkout', repos: [], envs: ['local'], featureDir: __dirname } }")
  return { projectRoot, featuresDir, dir }
}

describe('elicited domain input', () => {
  it('saves validated target URLs once and rejects credentials and placeholders', async () => {
    const f = feature()
    const published = vi.fn()
    const tools = captureTools(registerReadTools, { ...f, workspaceEvents: { publish: published } }, facts)
    const args = { featureId: 'checkout', name: 'Staging', playwrightEnvsetId: 'local' }
    const opened = await tools.raw('create_verification_config', args, context()) as InputRequiredResult
    expect(fs.existsSync(path.join(f.dir, 'verification.configs.json'))).toBe(false)
    for (const invalid of ['ftp://example.com', 'https://replace.invalid', 'https://user:password@example.com']) {
      const rejected = await tools.raw('create_verification_config', args, context(opened.requestState, { action: 'accept', content: { default: invalid } }))
      expect(rejected.isError).toBe(true)
      expect(fs.existsSync(path.join(f.dir, 'verification.configs.json'))).toBe(false)
    }
    const accepted = context(opened.requestState, { action: 'accept', content: { default: 'https://staging.example.com' } })
    const first = await tools.raw('create_verification_config', args, accepted)
    const again = await tools.raw('create_verification_config', args, accepted)
    expect(again).toEqual(first)
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'verification.configs.json'), 'utf8')).configs).toHaveLength(1)
    expect(published).toHaveBeenCalledTimes(1)
  })

  it('does not elicit URLs that were already supplied', async () => {
    const tools = captureTools(registerReadTools, feature(), facts)
    const result = await tools.raw('create_verification_config', { featureId: 'checkout', name: 'Staging', playwrightEnvsetId: 'local', targetUrls: { default: 'https://staging.example.com' } }, context())
    expect(result).not.toHaveProperty('inputRequests')
    expect(JSON.parse(text(result)).targetUrls.default).toBe('https://staging.example.com')
  })

  // An update omitting targetUrls asks for them the same way a create does, and
  // the answer is written against the configuration that was on disk when the
  // question was asked.
  it('elicits target URLs for an update that omits them, then saves the answer', async () => {
    const f = feature()
    const tools = captureTools(registerReadTools, f, facts)
    const created = JSON.parse(text(await tools.raw('create_verification_config', { featureId: 'checkout', name: 'Staging', playwrightEnvsetId: 'local', targetUrls: { default: 'https://staging.example.com' } }, context())))
    const args = { featureId: 'checkout', configId: created.id, name: 'Beta', playwrightEnvsetId: 'local' }
    const opened = await tools.raw('update_verification_config', args, context()) as InputRequiredResult
    expect(opened.resultType).toBe('input_required')
    const saved = await tools.raw('update_verification_config', args, context(opened.requestState, { action: 'accept', content: { default: 'https://beta.example.com' } }))
    expect(JSON.parse(text(saved))).toMatchObject({ id: created.id, name: 'Beta', targetUrls: { default: 'https://beta.example.com' } })
  })

  it('uses the current flight options, rejects stale replies, and leaves agent work alone', async () => {
    const f = feature()
    let manifest = { flightId: 'flight', feature: 'checkout', status: 'waiting-for-approval', updatedAt: 'v1', stages: [{ key: 'similarity', status: 'waiting-for-approval', checkpoint: { kind: 'similarity-choice', message: 'Reuse or create?', options: ['rerun', 'new'] } }] }
    const posted: unknown[] = []
    const tools = captureTools(registerFlightTools, { ...f, flightsRequest: async (input: { method: string; payload?: unknown }) => {
      if (input.method === 'POST') posted.push(input.payload)
      return { statusCode: 200, body: manifest }
    } }, facts)
    const args = { flightId: 'flight' }
    const opened = await tools.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    expect(opened.inputRequests).toMatchObject({ answer: { params: { requestedSchema: { properties: { choice: { enum: ['rerun', 'new'] } } } } } })
    manifest = { ...manifest, updatedAt: 'v2' }
    const stale = await tools.raw('respond_flight_checkpoint', args, context(opened.requestState, { action: 'accept', content: { choice: 'new' } }))
    expect(text(stale)).toContain('changed')
    expect(posted).toHaveLength(0)
    const fresh = await tools.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    await tools.raw('respond_flight_checkpoint', args, context(fresh.requestState, { action: 'accept', content: { choice: 'new' } }))
    expect(posted).toEqual([{ response: { choice: 'new', expectedUpdatedAt: 'v2' } }])
    manifest.stages = [{ key: 'scout', status: 'waiting-for-approval', checkpoint: { kind: 'external-work', message: 'Scout', options: ['submit'] } }]
    const work = await tools.raw('respond_flight_checkpoint', args, context())
    expect(work).not.toHaveProperty('inputRequests')
    expect(text(work)).toContain('agent work')
  })

  it('requests environment secrets only through URL mode', async () => {
    const tools = captureTools(registerFlightTools, { ...feature(), getUiUrl: () => 'http://localhost:1234', flightsRequest: async () => ({ statusCode: 200, body: {
      flightId: 'env-flight', feature: 'checkout', status: 'waiting-for-approval', updatedAt: 'v1', stages: [{ key: 'env-capture', status: 'waiting-for-approval', checkpoint: { kind: 'missing-env', message: 'API_KEY missing', options: ['retry', 'waive'] } }],
    } }) }, facts)
    const result = await tools.raw('respond_flight_checkpoint', { flightId: 'env-flight' }, context()) as InputRequiredResult
    expect(result.inputRequests).toMatchObject({ answer: { method: 'elicitation/create', params: { mode: 'url', url: expect.stringContaining('inputToken=') } } })
    expect(JSON.stringify(result)).not.toContain('requestedSchema')
    expect(JSON.stringify(result)).not.toContain('API_KEY')
  })

  it.each(['accept', 'cancel'])('resumes the original URL input after the flight advances: %s', async (action) => {
    let manifest = { flightId: 'url-flight', feature: 'checkout', status: 'waiting-for-approval', updatedAt: 'v1', stages: [{ key: 'env-capture', status: 'waiting-for-approval', checkpoint: { kind: 'missing-env', message: 'Environment required', options: ['retry'] } }] }
    const posted = vi.fn()
    const tools = captureTools(registerFlightTools, { ...feature(), getUiUrl: () => 'http://localhost:1234', flightsRequest: async (input: { method: string }) => {
      if (input.method === 'POST') posted()
      return { statusCode: 200, body: manifest }
    } }, facts)
    const args = { flightId: 'url-flight' }
    const opened = await tools.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    manifest = { ...manifest, status: 'running', updatedAt: 'v2', stages: [] }
    const resumed = await tools.raw('respond_flight_checkpoint', args, context(opened.requestState, { action }))
    expect(resumed).not.toHaveProperty('inputRequests')
    expect(JSON.parse(text(resumed))).toMatchObject(action === 'accept'
      ? { status: 'running', next: expect.stringContaining('get_flight') }
      : { status: 'needs-input', reason: expect.stringContaining('cancel') })
    expect(posted).not.toHaveBeenCalled()
  })

  it('returns a portify review decision without bypassing the existing mutation gates', async () => {
    const manifest = { workflowId: 'w1', feature: 'checkout', status: 'ready-to-save', verification: { ok: true, instances: [{ ok: true }, { ok: true }] }, diff: '' }
    const savePortify = vi.fn()
    const tools = captureTools(registerPortifyTools, { getPortify: () => manifest, savePortify }, facts)
    const args = { workflowId: 'w1' }
    const opened = await tools.raw('review_portify', args, context()) as InputRequiredResult
    const invalid = await tools.raw('review_portify', args, context(opened.requestState, { action: 'accept', content: { choice: 'revise' } }))
    expect(invalid.isError).toBe(true)
    const accepted = await tools.raw('review_portify', args, context(opened.requestState, { action: 'accept', content: { choice: 'save' } }))
    expect(JSON.parse(text(accepted))).toMatchObject({ decision: 'save', next: expect.stringContaining('confirm:true') })
    expect(savePortify).not.toHaveBeenCalled()
    manifest.diff = 'changed after review'
    const stale = await tools.raw('save_portify', { workflowId: 'w1', confirm: true, review_revision: JSON.parse(text(accepted)).review_revision }, context())
    expect(text(stale)).toContain('changed')
    expect(savePortify).not.toHaveBeenCalled()
  })

  it('carries a revise decision and its feedback to the command that needs both', async () => {
    const manifest = { workflowId: 'w1', feature: 'checkout', status: 'ready-to-save', verification: { ok: true, instances: [{ ok: true }] } }
    const tools = captureTools(registerPortifyTools, { getPortify: () => manifest }, facts)
    const args = { workflowId: 'w1' }
    const opened = await tools.raw('review_portify', args, context()) as InputRequiredResult
    // No diff on this manifest: the review still reports diff stats rather than
    // failing to summarize, because the verification is the proof being reviewed.
    expect(JSON.stringify(opened.inputRequests)).toContain('diffStats')
    const revised = JSON.parse(text(await tools.raw('review_portify', args, context(opened.requestState, { action: 'accept', content: { choice: 'revise', feedback: 'use the sibling overlay' } }))))
    expect(revised).toMatchObject({ decision: 'revise', feedback: 'use the sibling overlay', next: expect.stringContaining('revise_external_portify') })
  })

  it('points a discard decision at cancel_portify, not save_portify', async () => {
    const manifest = { workflowId: 'w1', feature: 'checkout', status: 'ready-to-save', verification: { ok: true, instances: [] }, diff: '' }
    const tools = captureTools(registerPortifyTools, { getPortify: () => manifest }, facts)
    const args = { workflowId: 'w1' }
    const opened = await tools.raw('review_portify', args, context()) as InputRequiredResult
    const discarded = JSON.parse(text(await tools.raw('review_portify', args, context(opened.requestState, { action: 'accept', content: { choice: 'discard' } }))))
    expect(discarded).toMatchObject({ decision: 'discard', next: expect.stringContaining('cancel_portify') })
    expect(discarded).not.toHaveProperty('feedback')
  })

  // The review asks about a VERIFIED diff. Without one there is nothing to
  // decide, so neither of these may open a question the user could answer wrongly.
  it.each([
    ['the workflow is gone', undefined, /not found: w1/],
    ['it has not been verified yet', { workflowId: 'w1', feature: 'checkout', status: 'running' }, /The workflow is running/],
  ])('refuses to ask for a decision when %s', async (_case, manifest, expected) => {
    const tools = captureTools(registerPortifyTools, { getPortify: () => manifest }, facts)
    const result = await tools.raw('review_portify', { workflowId: 'w1' }, context())
    expect(result).not.toHaveProperty('inputRequests')
    expect(text(result)).toMatch(expected)
  })

  it('hands the verified proof to the agent to ask in chat when the client has no form', async () => {
    const manifest = { workflowId: 'w1', feature: 'checkout', status: 'ready-to-save', verification: { ok: true, instances: [{ ok: true }] }, diff: '--- a\n+++ b\n' }
    const tools = captureTools(registerPortifyTools, { getPortify: () => manifest }, { surface: 'other', canFanOut: false, sampling: false })
    const result = JSON.parse(text(await tools.raw('review_portify', { workflowId: 'w1' }, context())))
    expect(result).toMatchObject({ workflowId: 'w1', status: 'needs-input', reason: 'elicitation-unavailable', verification: { ok: true } })
    expect(result.next).toMatch(/revise_external_portify requires their feedback/)
  })

  // Target URLs are the one verification input the user must supply, and a client
  // with no form has to be told to ask rather than pick something plausible.
  it('asks in chat for target URLs when the client cannot show a form', async () => {
    const f = feature()
    const tools = captureTools(registerReadTools, f, { surface: 'other', canFanOut: false, sampling: false })
    const result = JSON.parse(text(await tools.raw('create_verification_config', { featureId: 'checkout', name: 'Staging', playwrightEnvsetId: 'local' }, context())))
    expect(result).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable' })
    expect(result.targets.length).toBeGreaterThan(0)
    expect(result.next).toMatch(/Never invent URLs or select production implicitly/)
    expect(fs.existsSync(path.join(f.dir, 'verification.configs.json'))).toBe(false)
  })
})
