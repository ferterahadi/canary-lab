import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { registerMcpRoutes } from './server'
import { createRegistry, RunStore } from '../features/runs/logic/run-store'
import { ExternalHealBroker } from '../features/runs/logic/heal/external-heal-broker'
import { documentHash } from '../features/coverage/logic/coverage/document-resolution'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function harness(reply: (params: Record<string, unknown>) => Promise<unknown>, legacy = false) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-elicit-'))
  cleanups.push(async () => fs.rmSync(projectRoot, { force: true, recursive: true }))
  const featuresDir = path.join(projectRoot, 'features')
  const featureDir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(featureDir, { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'checkout', description: 'checkout', envs: ['local'], repos: [], featureDir: __dirname } }")
  const logsDir = path.join(projectRoot, 'logs')
  const store = new RunStore(logsDir, createRegistry())
  const broker = new ExternalHealBroker({ now: Date.now, emit: () => {}, patchManifest: (id, patch) => store.patchManifest(id, patch), audit: () => {} })
  const app = Fastify()
  await app.register(registerMcpRoutes, { projectRoot, featuresDir, store, broker,
    startRun: async (_feature, _env, _session, isolation) => isolation
      ? { kind: 'queued', runId: 'queued-run', reason: 'repo-collision' }
      : { kind: 'collision', conflictingRunId: 'other', conflictingFeature: 'another', repoPaths: ['/repo'], options: ['worktree', 'queue'], message: 'Isolate now or queue?' },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(async () => { await app.close() })
  const client = new Client({ name: 'elicitation-test', version: '1' }, { capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: legacy ? 'legacy' : { pin: '2026-07-28' } } })
  client.setRequestHandler('elicitation/create', async ({ params }) => await reply(params as Record<string, unknown>) as { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address)))
  cleanups.push(async () => client.close())
  const call = async (command: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'exec', arguments: { command, arguments: args } })
    const content = result.content as Array<{ text?: string }>
    return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>
  }
  return { call, featureDir, logsDir }
}

describe('SDK 2.0 elicitation over the real compact HTTP dispatcher', () => {
  it('accepts discovered source evidence over HTTP without requesting user input', async () => {
    const reply = vi.fn(async () => ({ action: 'cancel' }))
    const { call, featureDir } = await harness(reply)
    const file = path.join(featureDir, 'docs', 'spec.md')
    const content = '# Checkout\nUsers can submit an order.'
    fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, content)
    const discovery = await call('start_external_summary', { feature: 'checkout', session_id: 'automatic' })
    expect(discovery.status).toBe('needs-document-discovery')
    const result = await call('start_external_summary', { feature: 'checkout', session_id: 'automatic', document_resolution: {
      status: 'resolved', searched: [path.dirname(file)], sources: [{ path: file, sha256: documentHash(content), reason: 'The supplied checkout spec defines order submission.' }],
    } })
    expect(result.status).toBe('running')
    expect(reply).not.toHaveBeenCalled()
  })

  it('resolves a source conflict through a real SDK 2.0 form and excludes the rejected source', async () => {
    const reply = vi.fn(async () => ({ action: 'accept', content: { choice: '1: Current' } }))
    const { call, featureDir } = await harness(reply)
    const docsDir = path.join(featureDir, 'docs')
    fs.mkdirSync(docsDir)
    const sources = ['Current', 'Draft'].map((label, i) => {
      const file = path.join(docsDir, `${label}.md`)
      const content = `# Refunds\nRefunds last ${i ? 7 : 30} days.`
      fs.writeFileSync(file, content)
      return { label, sources: [{ path: file, sha256: documentHash(content), reason: 'Defines refund duration.' }] }
    })
    const result = await call('start_external_summary', { feature: 'checkout', session_id: 'conflict', document_resolution: {
      status: 'conflicting', searched: [docsDir], question: 'Which refund duration applies?', candidates: sources,
    } })
    expect(result.status).toBe('running')
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'form', message: expect.stringContaining('Which refund duration applies?') }))
    expect(result.context).toMatchObject({ docs: [{ relPath: 'Current.md' }] })
    expect(fs.existsSync(path.join(docsDir, 'Draft.md'))).toBe(true)
  })

  it('imports user requirements and resumes the summary without a second agent call', async () => {
    const reply = vi.fn(async () => ({ action: 'accept', content: { source: 'paste', content: '# Checkout\nUsers can submit an order.' } }))
    const { call, featureDir } = await harness(reply)
    const discovery = await call('start_external_summary', { feature: 'checkout', session_id: 'docs-session' })
    expect(discovery.status).toBe('needs-document-discovery')
    expect(reply).not.toHaveBeenCalled()
    const result = await call('start_external_summary', { feature: 'checkout', session_id: 'docs-session', document_resolution: { status: 'missing', searched: ['feature docs and user references'], reason: 'No applicable specification is available.' } })
    expect(result.status).toBe('running')
    expect(result.jobId).toEqual(expect.any(String))
    expect(fs.readdirSync(path.join(featureDir, 'docs')).filter((file) => file.endsWith('.md'))).toHaveLength(1)
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('does not create a summary or document after cancel', async () => {
    const { call, featureDir, logsDir } = await harness(async () => ({ action: 'cancel' }))
    const result = await call('start_external_summary', { feature: 'checkout', session_id: 'cancel-session', document_resolution: { status: 'missing', searched: ['feature docs'], reason: 'No requirements found.' } })
    expect(result.status).toBe('needs-input')
    expect(fs.existsSync(path.join(featureDir, 'docs'))).toBe(false)
    expect(fs.existsSync(path.join(logsDir, 'coverage-jobs'))).toBe(false)
  })

  it('adapts the same inputRequired handler for a legacy peer', async () => {
    const { call } = await harness(async () => ({ action: 'accept', content: { isolation: 'queue' } }), true)
    expect(await call('boot_services', { feature: 'checkout' })).toMatchObject({ queued: true })
  })

  it('resumes a boot collision using the user choice', async () => {
    const { call } = await harness(async () => ({ action: 'accept', content: { isolation: 'queue' } }))
    const result = await call('boot_services', { feature: 'checkout' })
    expect(result).toMatchObject({ queued: true, runId: 'queued-run' })
  })

  it('opens document import in URL mode but does not treat opening as completion', async () => {
    const reply = vi.fn(async () => ({ action: 'accept' }))
    const { call } = await harness(reply)
    const result = await call('start_external_summary', { feature: 'checkout', session_id: 'upload-session', document_source: 'upload' })
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'url', url: expect.stringContaining('view=coverage') }))
    expect(result.status).toBe('needs-input')
    expect(result).not.toHaveProperty('jobId')
  })
})
