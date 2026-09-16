import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { captureTools } from './__fixtures__/tool-group-harness'
import { registerCoverageAuthoringTools } from './authoring-coverage'
import { registerFlightTools } from './flight'
import { readDocsCollection } from '../../features/coverage/logic/coverage/docs-collection'
import { documentHash, readDocumentSelection, writeDocumentSelection } from '../../features/coverage/logic/coverage/document-resolution'
import { coverageJobStore } from '../../features/coverage/logic/coverage/jobs/store'

const facts = { surface: 'codex' as const, canFanOut: false, sampling: false, elicitation: { form: true, url: true } }
const context = (state?: unknown, answer?: unknown) => ({ sessionId: 'discovery-tests', mcpReq: { requestState: () => state, inputResponses: { answer } } }) as unknown as ServerContext
const json = (result: CallToolResult | InputRequiredResult) => JSON.parse((result.content as Array<{ text: string }>)[0].text)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-discovery-')))
  roots.push(projectRoot)
  const featuresDir = path.join(projectRoot, 'features')
  const featureDir = path.join(featuresDir, 'checkout')
  const repo = path.join(projectRoot, 'product')
  const logsDir = path.join(projectRoot, 'logs')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'checkout', description: 'Checkout refunds', repos: [{name:'product',localPath:${JSON.stringify(repo)}}], envs: ['local'], featureDir: __dirname } }`)
  const publish = vi.fn()
  const deps = { projectRoot, featuresDir, store: { logsDir }, workspaceEvents: { publish }, getUiUrl: () => 'http://localhost:1234' }
  const tools = captureTools(registerCoverageAuthoringTools, deps, facts)
  const args = { feature: 'checkout', session_id: 'docs' }
  const source = (name: string, content = '# Refunds\nRefunds are available for 30 days.', dir = repo) => {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return { path: file, sha256: documentHash(content), reason: 'Defines the checkout refund period.' }
  }
  return { ...deps, featureDir, repo, logsDir, tools, args, source, publish }
}

describe('document discovery before MCP 2.0 elicitation', () => {
  function brokenFixture() {
    const f = fixture()
    const original = f.source('original.md')
    const docsDir = path.join(f.featureDir, 'docs')
    fs.mkdirSync(docsDir)
    const link = path.join(docsDir, 'requirements.md')
    fs.symlinkSync(original.path, link)
    const baseline = readDocsCollection(f.featureDir).docsHash
    writeDocumentSelection(f.featureDir, { reviewedDocsHash: baseline, decisionKey: 'reviewed', intent: 'Refunds', searched: [f.repo], sources: [{ ...original, relPath: 'requirements.md' }], excluded: [] })
    const moved = path.join(f.repo, 'moved.md')
    fs.renameSync(original.path, moved)
    return { ...f, link, moved, docsDir, baseline }
  }

  it('elicits a moved source path before discovery and repairs only the symlink', async () => {
    const f = brokenFixture()
    const opened = await f.tools.raw('start_external_summary', f.args, context()) as InputRequiredResult
    expect(opened.inputRequests?.answer).toMatchObject({ method: 'elicitation/create', params: { mode: 'form', message: expect.stringContaining('requirements.md'), requestedSchema: { required: ['local_path'] } } })
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(0)
    const answer = context(opened.requestState, { action: 'accept', content: { local_path: f.moved } })
    const repaired = await f.tools.raw('start_external_summary', f.args, answer)
    expect(json(repaired)).toMatchObject({ status: 'document-relinked', linked: true, relativePath: 'docs/requirements.md' })
    expect(await f.tools.raw('start_external_summary', f.args, answer)).toEqual(repaired)
    expect(fs.readlinkSync(f.link)).toBe(f.moved)
    expect(fs.readdirSync(f.docsDir).sort()).toEqual(['_document-selection.json', 'requirements.md'])
    expect(readDocumentSelection(f.featureDir)?.reviewedDocsHash).toBe(f.baseline)
    expect(json(await f.tools.raw('start_external_summary', f.args, context())).status).toBe('running')
  })

  it('requires discovery after relinking changed contents without adopting the new hash', async () => {
    const f = brokenFixture()
    fs.writeFileSync(f.moved, '# Refunds\nRefunds now last 7 days.')
    const opened = await f.tools.raw('start_external_summary', f.args, context()) as InputRequiredResult
    await f.tools.raw('start_external_summary', f.args, context(opened.requestState, { action: 'accept', content: { local_path: f.moved } }))
    expect(readDocumentSelection(f.featureDir)?.reviewedDocsHash).toBe(f.baseline)
    expect(json(await f.tools.raw('start_external_summary', f.args, context())).status).toBe('needs-document-discovery')
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(0)
  })

  it.each(['cancel', 'decline', 'invalid-path', 'stale'] as const)('keeps missing-source work pending for %s', async (scenario) => {
    const f = brokenFixture()
    const oldTarget = fs.readlinkSync(f.link)
    const opened = await f.tools.raw('start_external_summary', f.args, context()) as InputRequiredResult
    if (scenario === 'stale') fs.writeFileSync(path.join(f.docsDir, 'new.md'), 'New requirements')
    const answer = scenario === 'cancel' || scenario === 'decline' ? { action: scenario } : { action: 'accept', content: { local_path: scenario === 'invalid-path' ? '/missing/relink-source.md' : f.moved } }
    const result = await f.tools.raw('start_external_summary', f.args, context(opened.requestState, answer))
    expect(result).not.toHaveProperty('inputRequests')
    expect(fs.readlinkSync(f.link)).toBe(oldTarget)
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(0)
  })

  it('returns the Relink UI when the MCP client cannot render a form', async () => {
    const f = brokenFixture()
    const tools = captureTools(registerCoverageAuthoringTools, f, { ...facts, elicitation: { form: false, url: false } })
    const result = json(await tools.raw('start_external_summary', f.args, context()))
    expect(result).toMatchObject({ status: 'needs-input', reason: 'elicitation-unavailable', brokenDoc: { relPath: 'requirements.md' }, url: expect.stringContaining('view=coverage') })
    expect(fs.existsSync(f.link)).toBe(false)
  })

  it.each(['accept', 'stale-flight', 'busy-summary', 'racing-docs'] as const)('guards relinking while the workflow changes: %s', async (mode) => {
    const f = brokenFixture()
    const oldTarget = fs.readlinkSync(f.link)
    let updatedAt = 'v1'
    let reads = 0
    const flight = captureTools(registerFlightTools, { ...f, flightsRequest: async () => {
      if (++reads === 3 && mode === 'racing-docs') fs.writeFileSync(path.join(f.docsDir, 'new.md'), 'New requirements')
      return { statusCode: 200, body: { flightId: 'flight', feature: 'checkout', repoPaths: [f.repo], description: 'Refunds', status: 'waiting-for-approval', updatedAt,
        stages: [{ key: 'docs', status: 'waiting-for-approval', checkpoint: { kind: 'external-work', data: { handOffId: 'current-handoff', context: { mode: 'collect-repo-docs' } } } }] } }
    } }, facts)
    const tools = mode === 'busy-summary' ? f.tools : flight
    const command = mode === 'busy-summary' ? 'start_external_summary' : 'respond_flight_checkpoint'
    const args = mode === 'busy-summary' ? f.args : { flightId: 'flight' }
    const opened = await tools.raw(command, args, context()) as InputRequiredResult
    expect(opened).toHaveProperty('inputRequests')
    if (mode === 'stale-flight') updatedAt = 'v2'
    if (mode === 'busy-summary') coverageJobStore(f.logsDir).save({ jobId: 'busy', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'now', log: '' })
    const result = await tools.raw(command, args, context(opened.requestState, { action: 'accept', content: { local_path: f.moved } }))
    expect(fs.readlinkSync(f.link)).toBe(mode === 'accept' ? f.moved : oldTarget)
    if (mode === 'accept') {
      expect(json(result).status).toBe('document-relinked')
      expect(json(await flight.raw(command, args, context()))).toMatchObject({ status: 'documents-ready', next: expect.stringContaining('current-handoff') })
    }
  })

  it('hands discovery back to the existing agent without elicitation or a job', async () => {
    const f = fixture()
    const result = await f.tools.raw('start_external_summary', f.args, context())
    expect(result).not.toHaveProperty('inputRequests')
    expect(json(result)).toMatchObject({ status: 'needs-document-discovery', repoPaths: [f.repo] })
    expect(fs.existsSync(path.join(f.logsDir, 'coverage-jobs'))).toBe(false)
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
  })

  it('imports clear authorized sources automatically and returns only selected summary inputs', async () => {
    const f = fixture()
    const relevant = f.source('refunds.md')
    const unrelated = f.source('warehouse.md', '# Warehouse\nBins are scanned.', path.join(f.featureDir, 'docs'))
    const discovery = await f.tools.raw('start_external_summary', f.args, context())
    expect(json(discovery).status).toBe('needs-document-discovery')
    expect(discovery).not.toHaveProperty('inputRequests')
    const result = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status: 'resolved', searched: [f.repo], sources: [relevant] } }, context())
    expect(result).not.toHaveProperty('inputRequests')
    expect(json(result).status).toBe('running')
    expect(json(result).context.docs).toHaveLength(1)
    expect(json(result).context.prompt).toContain(relevant.reason)
    expect(json(result).context.prompt).toContain('Checkout refunds')
    expect(readDocsCollection(f.featureDir).entries.map((entry) => entry.content)).toEqual([fs.readFileSync(relevant.path, 'utf8')])
    expect(fs.existsSync(unrelated.path)).toBe(true)
    expect(readDocumentSelection(f.featureDir)?.sources[0]).toMatchObject(relevant)
    expect(f.publish).toHaveBeenCalledWith({ type: 'coverage-changed', feature: 'checkout' })
  })

  it.each(['missing', 'ambiguous', 'conflicting'] as const)('elicits only the unresolved %s material and leaves cancellation pending', async (status) => {
    const f = fixture()
    const a = f.source('current.md')
    const b = f.source('draft.md', '# Refunds\nRefunds are available for 7 days.')
    const document_resolution = status === 'missing'
      ? { status, searched: [f.repo], reason: 'No requirements for partial refunds.' }
      : { status, searched: [f.repo], question: 'Which refund period applies?', candidates: [{ label: '30 days', sources: [a] }, { label: '7 days', sources: [b] }] }
    const args = { ...f.args, document_resolution }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    expect(opened.inputRequests?.answer).toMatchObject({ method: 'elicitation/create', params: { mode: 'form', message: expect.stringContaining(status === 'missing' ? 'partial refunds' : 'Which refund period') } })
    const canceled = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'cancel' }))
    expect(json(canceled)).toMatchObject({ status: 'needs-input', reason: expect.stringContaining('cancel') })
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
    expect(fs.existsSync(path.join(f.logsDir, 'coverage-jobs'))).toBe(false)
  })

  it('keeps rejected originals out of summaries and reuses a prior unchanged source choice', async () => {
    const f = fixture()
    const docsDir = path.join(f.featureDir, 'docs')
    const a = f.source('current.md', '# Refunds\n30 days.', docsDir)
    const b = f.source('draft.md', '# Refunds\n7 days.', docsDir)
    const args = { ...f.args, document_resolution: { status: 'conflicting', searched: [docsDir], question: 'Which refund period applies?', candidates: [{ label: 'Current', sources: [a] }, { label: 'Draft', sources: [b] }] } }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    const competing = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    const response = context(opened.requestState, { action: 'accept', content: { choice: '1: Current' } })
    const accepted = await f.tools.raw('start_external_summary', args, response)
    expect(await f.tools.raw('start_external_summary', args, response)).toEqual(accepted)
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(1)
    expect(json(accepted).context.docs.map((doc: { relPath: string }) => doc.relPath)).toEqual(['current.md'])
    expect(fs.existsSync(b.path)).toBe(true)
    const superseded = await f.tools.raw('start_external_summary', args, context(competing.requestState, { action: 'accept', content: { choice: '2: Draft' } }))
    expect(json(superseded).status).toBe('needs-input')
    expect(readDocsCollection(f.featureDir).entries.map((entry) => entry.relPath)).toEqual(['current.md'])
    coverageJobStore(f.logsDir).remove(json(accepted).jobId)
    const again = await f.tools.raw('start_external_summary', args, context())
    expect(again).not.toHaveProperty('inputRequests')
    expect(json(again).status).toBe('running')
    coverageJobStore(f.logsDir).remove(json(again).jobId)
    fs.writeFileSync(b.path, '# Refunds\n14 days.')
    const changed = await f.tools.raw('start_external_summary', f.args, context())
    expect(json(changed).status).toBe('needs-document-discovery')
    expect(readDocsCollection(f.featureDir).entries).toHaveLength(2)
  })

  it.each(['changed', 'outside', 'symlink'] as const)('rejects %s source evidence before importing anything', async (kind) => {
    const f = fixture()
    const a = f.source('valid.md')
    const b = f.source('second.md', '# Different source', kind === 'changed' ? f.repo : f.projectRoot)
    if (kind === 'changed') fs.appendFileSync(b.path, '\nChanged after reading.')
    if (kind === 'symlink') {
      const link = path.join(f.repo, 'escape.md')
      fs.symlinkSync(b.path, link)
      b.path = link
    }
    const result = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status: 'resolved', searched: [f.repo], sources: [a, b] } }, context())
    expect(json(result).status).toBe('needs-document-discovery')
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
  })

  it('rejects source edits made while a choice is open', async () => {
    const f = fixture()
    const a = f.source('first.md')
    const b = f.source('second.md', '# Refunds\n7 days.')
    const args = { ...f.args, document_resolution: { status: 'ambiguous', searched: [f.repo], question: 'Which version?', candidates: [{ label: 'First', sources: [a] }, { label: 'Second', sources: [b] }] } }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    fs.appendFileSync(a.path, '\nChanged after opening the form.')
    const result = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept', content: { choice: '1: First' } }))
    expect(json(result).status).toBe('needs-input')
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
  })

  it('does not apply a forged resumption or change documents under an active summary', async () => {
    const f = fixture()
    const a = f.source('first.md')
    const b = f.source('second.md', '# Refunds\n7 days.')
    const args = { ...f.args, document_resolution: { status: 'resolved', searched: [f.repo], sources: [a] } }
    const forged = await f.tools.raw('start_external_summary', args, context('forged', { action: 'accept' }))
    expect(json(forged).status).toBe('needs-input')
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
    const [first, second] = await Promise.all([
      f.tools.raw('start_external_summary', args, context()),
      f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status: 'resolved', searched: [f.repo], sources: [b] } }, context()),
    ])
    expect(json(first).status).toBe('running')
    expect(second.isError).toBe(true)
    expect(readDocsCollection(f.featureDir).entries.map((entry) => entry.content)).toEqual([fs.readFileSync(a.path, 'utf8')])
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(1)
  })

  it('resumes URL import only when documents changed, then remembers supplied requirements', async () => {
    const f = fixture()
    const document_resolution = { status: 'missing', searched: [f.repo], reason: 'No refund specification found.' }
    const args = { ...f.args, document_source: 'upload', document_resolution }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    f.source('uploaded.md', '# Refunds\n30 days.', path.join(f.featureDir, 'docs'))
    const accepted = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept' }))
    expect(json(accepted).status).toBe('running')
    coverageJobStore(f.logsDir).remove(json(accepted).jobId)
    const again = await f.tools.raw('start_external_summary', { ...f.args, document_resolution }, context())
    expect(again).not.toHaveProperty('inputRequests')
    expect(json(again).status).toBe('running')
  })

  it.each(['Provide requirements', 'Upload documents'])('accepts user replacements for conflicting originals: %s', async (choice) => {
    const f = fixture()
    const docsDir = path.join(f.featureDir, 'docs')
    const a = f.source('first.md', '# Refunds\n30 days.', docsDir)
    const b = f.source('second.md', '# Refunds\n7 days.', docsDir)
    const args = { ...f.args, document_resolution: { status: 'conflicting', searched: [docsDir], question: 'Which applies?', candidates: [{ label: 'First', sources: [a] }, { label: 'Second', sources: [b] }] } }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    const chosen = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept', content: { choice } }))
    expect(json(chosen).next).toContain(choice === 'Upload documents' ? 'document_source:"upload"' : 'document_source:"form"')
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(0)
    const followup = { ...args, document_source: choice === 'Upload documents' ? 'upload' : 'form' }
    const supply = await f.tools.raw('start_external_summary', followup, context()) as InputRequiredResult
    const content = '# Refunds\nThe user specifies 14 days.'
    if (choice === 'Upload documents') f.source('replacement.md', content, docsDir)
    const result = await f.tools.raw('start_external_summary', followup, context(supply.requestState, { action: 'accept', content: { source: 'paste', content } }))
    expect(json(result).status).toBe('running')
    expect(readDocsCollection(f.featureDir).entries.map((entry) => entry.content)).toEqual([content])
    expect(fs.readFileSync(a.path, 'utf8')).toContain('30 days')
    expect(fs.readFileSync(b.path, 'utf8')).toContain('7 days')
  })

  it.each(['paste', 'local-file', 'upload'])('handles explicit user input and validates required fields: %s', async (source) => {
    const f = fixture()
    const outside = f.source('provided.md', '# User requirements\n30 days.', f.projectRoot)
    const args = { ...f.args, document_source: 'form' }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    if (source !== 'upload') {
      const invalid = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept', content: { source } }))
      expect(invalid.isError).toBe(true)
      expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
    }
    const result = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept', content: {
      source, ...(source === 'paste' ? { content: '# User requirements\n30 days.' } : {}), ...(source === 'local-file' ? { local_path: outside.path } : {}),
    } }))
    expect(json(result).status).toBe(source === 'upload' ? 'needs-docs' : 'running')
    if (source === 'upload') expect(json(result).next).toContain('document_source:"upload"')
    else expect(readDocumentSelection(f.featureDir)?.sources).toHaveLength(1)
  })

  it('leaves invalid user paths unapplied and does not overwrite documents for an active summary', async () => {
    const f = fixture()
    const args = { ...f.args, document_source: 'form' }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    const failed = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept', content: { source: 'local-file', local_path: path.join(f.repo, 'absent.md') } }))
    expect(failed.isError).toBe(true)
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
    const second = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    coverageJobStore(f.logsDir).save({ jobId: 'already-running', feature: 'checkout', kind: 'summary', status: 'running', startedAt: 'now', log: '' })
    const busy = await f.tools.raw('start_external_summary', args, context(second.requestState, { action: 'accept', content: { source: 'paste', content: '# New doc' } }))
    expect(busy.isError).toBe(true)
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
  })

  it.each(['missing', 'form', 'upload', 'no-ui', 'conflict', 'upload-choice-without-ui'])('provides focused recovery to unsupported clients: %s', async (mode) => {
    const f = fixture()
    const a = f.source('a.md')
    const b = f.source('b.md')
    const tools = captureTools(registerCoverageAuthoringTools, { ...f, getUiUrl: mode === 'no-ui' || mode === 'upload-choice-without-ui' ? undefined : f.getUiUrl }, mode === 'upload-choice-without-ui' ? facts : { ...facts, elicitation: { form: false, url: false } })
    const document_resolution = mode === 'missing' ? { status: 'missing', searched: [f.repo], reason: 'Refund rules absent.' }
      : mode === 'conflict' ? { status: 'ambiguous', searched: [f.repo], question: 'Which source applies?', candidates: [{ label: 'A', sources: [a] }, { label: 'B', sources: [b] }] } : undefined
    const args = { ...f.args, ...(document_resolution ? { document_resolution } : { document_source: mode === 'upload' || mode === 'no-ui' ? 'upload' : 'form' }) }
    let result = await tools.raw('start_external_summary', args, context())
    if (mode === 'upload-choice-without-ui') result = await tools.raw('start_external_summary', args, context((result as InputRequiredResult).requestState, { action: 'accept', content: { source: 'upload' } }))
    expect(json(result).status).toBe(mode === 'conflict' ? 'needs-input' : 'needs-docs')
    if (mode === 'conflict') expect(json(result).question).toContain('Which source applies?')
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
  })

  it.each(['missing-file', 'directory', 'unsupported', 'generated', 'oversized', 'unavailable-repo'])('rejects unsupported discovery evidence: %s', async (kind) => {
    const f = fixture()
    const source = f.source(kind === 'unsupported' ? 'source.json' : kind === 'generated' ? '_generated.md' : 'source.md')
    if (kind === 'missing-file' || kind === 'directory') fs.rmSync(source.path)
    if (kind === 'directory') fs.mkdirSync(source.path)
    if (kind === 'oversized') fs.writeFileSync(source.path, 'x'.repeat(2 * 1024 * 1024 + 1))
    if (kind === 'unavailable-repo') {
      source.path = f.source('elsewhere.md', '# Requirements', f.projectRoot).path
      fs.rmSync(f.repo, { recursive: true })
    }
    const result = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status: 'resolved', searched: [f.repo], sources: [source] } }, context())
    expect(json(result).status).toBe('needs-document-discovery')
    expect(fs.existsSync(path.join(f.featureDir, 'docs'))).toBe(false)
  })

  it('rejects invalid resolution input and treats an invalid selection receipt as unreviewed', async () => {
    const f = fixture()
    const invalid = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status: 'resolved', sources: [] } }, context())
    expect(invalid.isError).toBe(true)
    f.source('provided.md', '# Requirements', path.join(f.featureDir, 'docs'))
    fs.writeFileSync(path.join(f.featureDir, 'docs', '_document-selection.json'), '{}')
    const unreviewed = await f.tools.raw('start_external_summary', f.args, context())
    expect(json(unreviewed).status).toBe('needs-document-discovery')
    expect(readDocumentSelection(f.featureDir)).toBeNull()
  })

  it('can ask whether one ambiguous candidate applies without inventing a second source', async () => {
    const f = fixture()
    const source = f.source('draft.md')
    const resolution = { searched:[f.repo], question:'Does this draft apply to the requested release?', candidates:[{label:'Use this draft',sources:[source]}] }
    const opened = await f.tools.raw('start_external_summary', { ...f.args, document_resolution:{...resolution,status:'ambiguous'} }, context()) as InputRequiredResult
    expect(opened.inputRequests?.answer).toMatchObject({params:{requestedSchema:{properties:{choice:{enum:['1: Use this draft','Provide requirements','Upload documents']}}}}})
    const invalidConflict = await f.tools.raw('start_external_summary', { ...f.args, document_resolution:{...resolution,status:'conflicting'} }, context())
    expect(invalidConflict.isError).toBe(true)
    expect(fs.existsSync(path.join(f.featureDir,'docs'))).toBe(false)
  })

  it('supports features without repository metadata and records explicitly provided requirements', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'checkout', envs: ['local'], featureDir: __dirname } }")
    expect(json(await f.tools.raw('start_external_summary', f.args, context())).repoPaths).toEqual([])
    const args = { ...f.args, document_source: 'form' }
    const opened = await f.tools.raw('start_external_summary', args, context()) as InputRequiredResult
    const result = await f.tools.raw('start_external_summary', args, context(opened.requestState, { action: 'accept', content: { source: 'paste', content: '# Requirements\n30 days.' } }))
    expect(json(result).status).toBe('running')
    expect(readDocumentSelection(f.featureDir)?.intent).toBe('checkout')
  })

  it('resolves relative repository roots against the owning workspace', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.featureDir, 'feature.config.cjs'), "module.exports = { config: { name:'checkout', description:'Refunds', repos:[{name:'product',localPath:'./product'}], envs:['local'], featureDir:__dirname } }")
    const source = f.source('spec.md')
    expect(json(await f.tools.raw('start_external_summary', f.args, context())).repoPaths).toEqual([f.repo])
    const result = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status:'resolved', searched:[f.repo], sources:[source] } }, context())
    expect(json(result).status).toBe('running')
  })

  it('recognizes an imported document through a directory alias without linking it again', async () => {
    const f = fixture()
    const source = f.source('provided.md', '# Requirements', path.join(f.featureDir, 'docs'))
    const alias = path.join(f.projectRoot, 'suite-alias')
    fs.symlinkSync(f.featureDir, alias)
    source.path = path.join(alias, 'docs', 'provided.md')
    const result = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status:'resolved', searched:[alias], sources:[source] } }, context())
    expect(json(result).status).toBe('running')
    expect(json(result).context.docs.map((doc: {relPath:string}) => doc.relPath)).toEqual(['provided.md'])
    expect(fs.readdirSync(path.join(f.featureDir,'docs')).filter((name) => name.endsWith('.md'))).toEqual(['provided.md'])
  })

  it('surfaces a canonical link rejection without treating it as an accepted source', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.featureDir, 'feature.config.cjs'), `module.exports = { config: { name: 'checkout', description:'d', repos:[{name:'suite',localPath:${JSON.stringify(f.featureDir)}}], envs:['local'], featureDir:__dirname } }`)
    const source = f.source('nested.md', '# Requirements', path.join(f.featureDir, 'docs', 'nested'))
    const result = await f.tools.raw('start_external_summary', { ...f.args, document_resolution: { status: 'resolved', searched: [f.featureDir], sources: [source] } }, context())
    expect(result.isError).toBe(true)
    expect(readDocumentSelection(f.featureDir)).toBeNull()
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(0)
    expect(fs.readFileSync(source.path, 'utf8')).toBe('# Requirements')
  })

  it.each(['empty-url', 'stale-url', 'import-url', 'paste', 'source-race', 'collection-race', 'selection-race'])('checks flight state and imported content before releasing document input: %s', async (mode) => {
    const f = fixture()
    const source = f.source('spec.md')
    let updatedAt = 'v1'
    let reads = 0
    const posted = vi.fn()
    const tools = captureTools(registerFlightTools, { ...f, flightsRequest: async (input: { method: string }) => {
      if (input.method === 'POST') posted()
      if (input.method === 'GET' && ++reads === 2) {
        if (mode === 'source-race') fs.appendFileSync(source.path, '\nA source changed during validation.')
        if (mode === 'collection-race' || mode === 'selection-race') {
          const competing = f.source('concurrent.md', '# New requirement', path.join(f.featureDir, 'docs'))
          if (mode === 'selection-race') writeDocumentSelection(f.featureDir, { reviewedDocsHash: readDocsCollection(f.featureDir).docsHash, decisionKey: 'another-review', searched: [f.repo], sources: [{ ...competing, relPath: 'concurrent.md' }], excluded: [] })
        }
      }
      return { statusCode: 200, body: { flightId: 'flight', feature: 'checkout', repoPaths: [f.repo], description: 'Refunds', status: 'waiting-for-approval', updatedAt,
        stages: [{ key: 'docs', status: 'waiting-for-approval', checkpoint: { kind: 'external-work', data: { handOffId: 'current-handoff', context: { mode: 'collect-repo-docs' } } } }] } }
    } }, facts)
    const args = { flightId: 'flight', ...(mode.endsWith('-race') ? { document_resolution: { status: 'resolved', searched: [f.repo], sources: [source] } } : { document_source: mode === 'paste' ? 'form' : 'upload' }) }
    let result = await tools.raw('respond_flight_checkpoint', args, context())
    if (!mode.endsWith('-race')) {
      if (mode === 'stale-url') updatedAt = 'v2'
      if (mode === 'import-url') f.source('uploaded.md', '# New requirement', path.join(f.featureDir, 'docs'))
      result = await tools.raw('respond_flight_checkpoint', args, context((result as InputRequiredResult).requestState, { action: 'accept', content: { source: 'paste', content: '# New requirement' } }))
    }
    expect(json(result).status).toBe(mode === 'paste' || mode === 'import-url' ? 'documents-ready' : 'needs-input')
    expect(posted).not.toHaveBeenCalled()
    if (mode === 'source-race') expect(readDocsCollection(f.featureDir).entries).toHaveLength(0)
    expect(coverageJobStore(f.logsDir).list()).toHaveLength(0)
  })

  it('resolves flight sources inside the existing handoff and rejects a stale flight answer', async () => {
    const f = fixture()
    const a = f.source('current.md')
    let updatedAt = 'v1'
    const posted = vi.fn()
    const flight = captureTools(registerFlightTools, { ...f, flightsRequest: async (input: { method: string }) => {
      if (input.method === 'POST') posted()
      return { statusCode: 200, body: { flightId: 'flight', feature: 'checkout', repoPaths: [f.repo], description: 'Refunds', status: 'waiting-for-approval', updatedAt,
        stages: [{ key: 'docs', status: 'waiting-for-approval', checkpoint: { kind: 'external-work', data: { handOffId: 'current-handoff', context: { mode: 'collect-repo-docs' } } } }] } }
    } }, facts)
    expect(json(await flight.raw('respond_flight_checkpoint', { flightId: 'flight' }, context())).status).toBe('needs-document-discovery')
    const resolved = await flight.raw('respond_flight_checkpoint', { flightId: 'flight', document_resolution: { status: 'resolved', searched: [f.repo], sources: [a] } }, context())
    expect(resolved).not.toHaveProperty('inputRequests')
    expect(json(resolved)).toMatchObject({ status: 'documents-ready', next: expect.stringContaining('current-handoff') })
    expect(posted).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(f.logsDir, 'coverage-jobs'))).toBe(false)
    const args = { flightId: 'flight', document_resolution: { status: 'missing', searched: [f.repo], reason: 'Partial refunds undocumented.' } }
    const opened = await flight.raw('respond_flight_checkpoint', args, context()) as InputRequiredResult
    updatedAt = 'v2'
    const stale = await flight.raw('respond_flight_checkpoint', args, context(opened.requestState, { action: 'accept', content: { source: 'paste', content: 'Partial refund requirements' } }))
    expect(json(stale).status).toBe('needs-input')
    expect(readDocsCollection(f.featureDir).entries).toHaveLength(1)
    expect(posted).not.toHaveBeenCalled()
  })
})
