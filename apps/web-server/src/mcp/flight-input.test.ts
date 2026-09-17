import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { captureTools } from './tool-groups/__fixtures__/tool-group-harness'
import { registerFlightTools } from './tool-groups/flight'
import { computeDocsHash } from '../features/coverage/logic/coverage/docs-collection'
import { documentHash, documentResolutionInput, writeDocumentSelection } from '../features/coverage/logic/coverage/document-resolution'
import { inputFingerprint } from './elicitation'
import type { McpClientFacts } from './client-surface'

// `respond_flight_checkpoint` with no choice/values/data is the human-question
// path, and every branch below is a shape of question (or non-question) the
// flight store can hand it. The flight itself is a fake `flightsRequest`: what
// these branches read is the MANIFEST, so booting a server would add a port per
// assertion and prove nothing extra.

const formAndUrl: McpClientFacts = { surface: 'codex', canFanOut: false, sampling: false, elicitation: { form: true, url: true } }
const formOnly: McpClientFacts = { ...formAndUrl, elicitation: { form: true, url: false } }
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'flight-input', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const text = (result: CallToolResult | InputRequiredResult) => (result.content as Array<{ text: string }>)[0].text
const json = (result: CallToolResult | InputRequiredResult) => JSON.parse(text(result)) as Record<string, unknown>

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function workspace() {
  // realpath: the resolved-source check compares real paths, and macOS reports
  // the temp dir through /var → /private/var.
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-flight-input-')))
  roots.push(projectRoot)
  const featuresDir = path.join(projectRoot, 'features')
  const featureDir = path.join(featuresDir, 'checkout')
  const repoDir = path.join(projectRoot, 'repo')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'checkout', repos: [], envs: ['local'], featureDir: __dirname } }")
  return { projectRoot, featuresDir, featureDir, repoDir }
}

type Ws = ReturnType<typeof workspace>
type Get = { statusCode: number; body?: unknown }

/** Register the flight tools against a scripted flights API. `get` answers each
 *  read in turn, so a test can change the flight between the read that opens a
 *  question and the read that commits its answer. */
function tools(ws: Ws, get: () => Get, options: { uiUrl?: string; facts?: McpClientFacts } = {}) {
  const posted: unknown[] = []
  const reads: Get[] = []
  const captured = captureTools(registerFlightTools, {
    projectRoot: ws.projectRoot,
    featuresDir: ws.featuresDir,
    ...(options.uiUrl ? { getUiUrl: () => options.uiUrl } : {}),
    flightsRequest: async (input: { method: string; payload?: unknown }) => {
      if (input.method === 'POST') {
        posted.push(input.payload)
        return { statusCode: 200, body: { flightId: 'fl', feature: 'checkout', status: 'running', currentStage: 'docs', stages: [] } }
      }
      const read = get()
      reads.push(read)
      return read
    },
  }, options.facts ?? formAndUrl)
  return { ...captured, posted, reads }
}

const flight = (overrides: Record<string, unknown> = {}) => ({
  flightId: 'fl', feature: 'checkout', status: 'waiting-for-approval', currentStage: 'docs', updatedAt: 'v1', ...overrides,
})
const parked = (stage: string, checkpoint: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  flight({ stages: [{ key: stage, status: 'waiting-for-approval', checkpoint }], ...overrides })
const ok = (body: unknown): Get => ({ statusCode: 200, body })

describe('respond_flight_checkpoint — there is nothing to answer', () => {
  // Every one of these leaves the work pending rather than erroring: the agent
  // asked a legitimate question about a flight that has since moved, and the
  // correct behaviour is to go read it, not to retry this call.
  it.each([
    ['the flight is gone', { statusCode: 404, body: { error: 'no such flight' } } as Get],
    ['the flight is not parked', ok(flight({ status: 'running', stages: [] }))],
    ['no stage is waiting', ok(flight({ stages: [{ key: 'docs', status: 'done' }] }))],
    ['the parked stage carries no checkpoint', ok(flight({ stages: [{ key: 'docs', status: 'waiting-for-approval' }] }))],
  ])('parks when %s', async (_case, read) => {
    const t = tools(workspace(), () => read)
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl' }, context())
    expect(json(result)).toMatchObject({ status: 'needs-input', reason: expect.stringContaining('no open checkpoint') })
    expect(t.posted).toHaveLength(0)
  })
})

describe('respond_flight_checkpoint — falling back to chat', () => {
  // The fallback text is the whole point of these branches: a secret must never
  // be routed into chat or a form, while an ordinary choice must be.
  it('sends a secret checkpoint to the Canary UI, never to chat, when there is no UI to link', async () => {
    const t = tools(workspace(), () => ok(parked('env-capture', { kind: 'missing-env', message: 'API_KEY missing', options: ['retry'] })))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl' }, context())
    expect(json(result)).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable' })
    expect(json(result).next).toMatch(/Never request secrets in chat or a form elicitation/)
  })

  it('asks in chat for a checkpoint whose options the flight never supplied', async () => {
    const t = tools(workspace(), () => ok(parked('similarity', { kind: 'similarity-choice', message: 'Reuse or create?' })))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl' }, context())
    expect(json(result).next).toMatch(/ASK THE USER for the checkpoint choice/)
    expect(result).not.toHaveProperty('inputRequests')
  })

  // An oversized payload is reviewed in the UI rather than pasted into the
  // conversation — but it is not a secret, so the prose must not say so.
  it('hands an oversized checkpoint its UI link when the client cannot open URLs', async () => {
    const data = { diff: 'x'.repeat(9000) }
    const t = tools(workspace(), () => ok(parked('portify', { kind: 'portify-apply', message: 'Review', options: ['apply'], data })),
      { uiUrl: 'http://127.0.0.1:7420', facts: formOnly })
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl' }, context())
    expect(json(result)).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable', url: expect.stringContaining('inputToken=') })
    expect(json(result).next).toMatch(/Never paste credentials into chat/)
    expect(text(result)).not.toContain(data.diff)
  })
})

describe('respond_flight_checkpoint — form answers', () => {
  it('requires feedback with a revise choice, and carries it through once supplied', async () => {
    const t = tools(workspace(), () => ok(parked('portify', { kind: 'portify-apply', message: 'Review the diff', options: ['apply', 'revise'] })))
    const args = { flightId: 'fl' }
    const opened = await t.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    const bare = await t.raw('respond_flight_checkpoint', args, context(opened.requestState, { action: 'accept', content: { choice: 'revise' } }))
    expect(bare.isError).toBe(true)
    expect(t.posted).toHaveLength(0)
    const withFeedback = await t.raw('respond_flight_checkpoint', args, context(opened.requestState, { action: 'accept', content: { choice: 'revise', feedback: 'rename the slot' } }))
    expect(withFeedback.isError).toBeUndefined()
    expect(t.posted).toEqual([{ response: { choice: 'revise', feedback: 'rename the slot', expectedUpdatedAt: 'v1' } }])
  })

  it('reports that opening the input URL did not answer the question', async () => {
    const t = tools(workspace(), () => ok(parked('env-capture', { kind: 'missing-env', message: 'API_KEY missing', options: ['retry'] })), { uiUrl: 'http://127.0.0.1:7420' })
    const args = { flightId: 'fl' }
    const opened = await t.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    const resumed = await t.raw('respond_flight_checkpoint', args, context(opened.requestState, { action: 'accept' }))
    expect(json(resumed).reason).toMatch(/Opening the URL does not complete it/)
    expect(t.posted).toHaveLength(0)
  })
})

describe('respond_flight_checkpoint — source documents', () => {
  const source = (ws: Ws, content = '# Requirement\n') => {
    const file = path.join(ws.repoDir, 'prd.md')
    fs.writeFileSync(file, content)
    return { status: 'resolved' as const, searched: [ws.repoDir], sources: [{ path: file, sha256: documentHash(content), reason: 'The checkout requirements live here.' }] }
  }

  it('continues the flight once resolved sources are imported', async () => {
    const ws = workspace()
    const t = tools(ws, () => ok(parked('docs', { kind: 'prd-source', message: 'Where are the requirements?', options: ['continue'] }, { repoPaths: [ws.repoDir] })))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl', document_resolution: source(ws) }, context())
    expect(result.isError).toBeUndefined()
    expect(t.posted).toEqual([{ response: { choice: 'continue', expectedUpdatedAt: 'v1' } }])
    expect(fs.readdirSync(path.join(ws.featureDir, 'docs')).filter((name) => name.endsWith('.md'))).toHaveLength(1)
  })

  // The import and the continue are two writes against a flight that a human can
  // stop in between. `beforeWrite` guards the import; this guards the continue,
  // so a stopped flight is never released by an answer it no longer wants.
  it('does not release a flight that moved on after its documents were imported', async () => {
    const ws = workspace()
    const manifest = parked('docs', { kind: 'prd-source', message: 'Where are the requirements?', options: ['continue'] }, { repoPaths: [ws.repoDir] })
    const reads = [ok(manifest), ok(manifest), ok({ ...manifest, updatedAt: 'v2' })]
    const t = tools(ws, () => reads.shift() ?? ok({ ...manifest, updatedAt: 'v2' }))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl', document_resolution: source(ws) }, context())
    expect(json(result).reason).toMatch(/changed while source documents were being resolved/)
    expect(t.posted).toHaveLength(0)
  })

  it('hands the selected documents back to an external docs agent instead of continuing the flight', async () => {
    const ws = workspace()
    const t = tools(ws, () => ok(parked('docs', { kind: 'external-work', message: 'Write the summary', data: { handOffId: 'h1', stage: 'docs', context: { mode: 'collect-repo-docs' } } }, { repoPaths: [ws.repoDir] })))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl', document_resolution: source(ws) }, context())
    expect(json(result)).toMatchObject({ status: 'documents-ready', docs: [{ relPath: expect.stringMatching(/\.md$/) }] })
    expect(json(result).next).toMatch(/handOffId h1/)
    expect(t.posted).toHaveLength(0)
  })

  // `infer-from-diff` is the fork where the user chose NOT to supply documents.
  // Re-asking would undo their decision, so the only reply is "get on with it".
  it('does not re-open the source question when the user already authorized inference from the diff', async () => {
    const ws = workspace()
    const t = tools(ws, () => ok(parked('docs', { kind: 'external-work', message: 'Write the summary', data: { handOffId: 'h2', stage: 'docs', context: { mode: 'infer-from-diff' } } })))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl' }, context())
    expect(json(result).next).toMatch(/already authorized inference from the diff/)
    expect(result).not.toHaveProperty('inputRequests')
  })

  it.each([
    ['the collector said why it found nothing', { lastAttempt: { reason: 'The repository has no product docs.' } }, true, 'The repository has no product docs.'],
    ['it reported only an outcome', { lastAttempt: { outcome: 'no-material' } }, false, 'The document collector returned no-material.'],
    ['it reported nothing at all', { lastAttempt: {} }, false, 'The document collector returned no material.'],
  ])('asks the user for requirements when %s', async (_case, data, withRepoPaths, expected) => {
    const ws = workspace()
    const searched = withRepoPaths ? [ws.repoDir] : ['Flight document collector']
    const t = tools(ws, () => ok(parked('docs', { kind: 'prd-source', message: 'Where are the requirements?', options: ['continue'], data }, withRepoPaths ? { repoPaths: [ws.repoDir] } : {})))
    const args = { flightId: 'fl' }
    const opened = await t.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    expect(JSON.stringify(opened.inputRequests)).toContain(expected)
    const applied = await t.raw('respond_flight_checkpoint', args, context(opened.requestState, { action: 'accept', content: { source: 'paste', content: '# Requirement\n' } }))
    expect(applied.isError).toBeUndefined()
    expect(t.posted).toEqual([{ response: { choice: 'continue', expectedUpdatedAt: 'v1' } }])
    // The synthesized search record is what a later discovery compares against,
    // so it has to say where the collector actually looked.
    const selection = JSON.parse(fs.readFileSync(path.join(ws.featureDir, 'docs', '_document-selection.json'), 'utf8')) as { searched: string[] }
    expect(selection.searched).toEqual(searched)
  })

  // The receipt `use([])` writes when the user had nothing to add: every document
  // present is excluded and no source was selected. Replaying that decision must
  // park the flight, not continue it with no requirements at all.
  it('parks rather than continuing a flight whose recorded decision selected no documents', async () => {
    const ws = workspace()
    const docsDir = path.join(ws.featureDir, 'docs')
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, 'rejected.md'), 'not the requirements')
    const resolution = { status: 'missing' as const, searched: [ws.repoDir], reason: 'Nothing in the repository describes checkout.' }
    writeDocumentSelection(ws.featureDir, {
      reviewedDocsHash: computeDocsHash([{ relPath: 'rejected.md', content: 'not the requirements' }]),
      decisionKey: inputFingerprint(documentResolutionInput.parse(resolution)),
      sources: [], searched: resolution.searched,
      excluded: [{ relPath: 'rejected.md', sha256: documentHash('not the requirements') }],
    })
    const t = tools(ws, () => ok(parked('docs', { kind: 'prd-source', message: 'Where are the requirements?', options: ['continue'] }, { repoPaths: [ws.repoDir] })))
    const result = await t.raw('respond_flight_checkpoint', { flightId: 'fl', document_resolution: resolution }, context())
    expect(json(result).reason).toBe('No requirements documents have been imported yet.')
    expect(t.posted).toHaveLength(0)
  })
})

describe('respond_flight_checkpoint — direct answers', () => {
  it('refuses source evidence alongside an answer, so the evidence is never skipped', async () => {
    const t = tools(workspace(), () => ok(parked('docs', { kind: 'prd-source', message: 'Where?', options: ['continue'] })))
    const result = await t.raw('respond_flight_checkpoint', {
      flightId: 'fl', choice: 'continue',
      document_resolution: { status: 'missing', searched: ['repo'], reason: 'none found' },
    }, context())
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/without choice, values, or data/)
    expect(t.posted).toHaveLength(0)
  })

  it('forwards every field of a direct answer verbatim', async () => {
    const t = tools(workspace(), () => ok(parked('portify', { kind: 'portify-apply', message: 'Review', options: ['revise'] })))
    const result = await t.raw('respond_flight_checkpoint', {
      flightId: 'fl', choice: 'revise', values: { API_KEY: 'from-the-user' }, data: { configSource: 'module.exports = {}' },
      feedback: 'rename the slot', token: 'h1',
    }, context())
    expect(result.isError).toBeUndefined()
    expect(t.posted).toEqual([{ response: { choice: 'revise', values: { API_KEY: 'from-the-user' }, data: { configSource: 'module.exports = {}' }, feedback: 'rename the slot', token: 'h1' } }])
  })
})
