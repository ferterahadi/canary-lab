import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import type { PtyFactory } from './features/runs/logic/runtime/pty-spawner'
import { runDirFor } from './features/runs/logic/runtime/run-paths'
import { writeManifest, writeRunsIndex } from './features/runs/logic/runtime/manifest'
import type { GettingStartedSessionState } from './features/config/logic/getting-started-session'

const inertPty: PtyFactory = () => ({
  pid: 0, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  write() {}, resize() {}, kill() {},
})
function toolBody(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected an MCP text response')
  return JSON.parse(content[0].text)
}

describe('Getting Started production wiring', () => {
  it('recovers before serving onboarding and delivers external draft transitions to UI and MCP clients', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-getting-started-server-'))
    const featuresDir = path.join(projectRoot, 'features')
    const logsDir = path.join(projectRoot, 'logs')
    const suiteDir = path.join(featuresDir, 'workflow-workbench')
    fs.mkdirSync(suiteDir, { recursive: true })
    fs.writeFileSync(path.join(suiteDir, 'feature.config.cjs'),
      "module.exports = { config: { name: 'workflow-workbench', description: 'sample', envs: ['local'], featureDir: __dirname, repos: [] } }")
    const timestamp = '2026-01-01T00:00:00Z'
    const dir = runDirFor(logsDir, 'orphan')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), { runId: 'orphan', feature: 'workflow-workbench', status: 'queued',
      startedAt: timestamp, healCycles: 0, services: [] })
    writeRunsIndex(logsDir, [{ runId: 'orphan', feature: 'workflow-workbench', status: 'queued', startedAt: timestamp }])
    const sessionDir = path.join(logsDir, 'getting-started')
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({ active: {
      sessionId: 'interrupted', workflow: 'heal', owner: 'internal', target: { kind: 'run', id: 'orphan' },
      startedAt: timestamp, updatedAt: timestamp,
    }, completed: {} } satisfies GettingStartedSessionState))
    const { app } = await createServer({ projectRoot, ptyFactory: inertPty })
    const client = new Client({ name: 'getting-started-test', version: '1.0.0' }, { capabilities: {} })
    const frames: Array<{ type: string }> = []
    await app.ready()
    const socket = await app.injectWS('/ws/workspace', {}, {
      onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))),
    })
    try {
      // Read the persisted record first: GET /api/onboarding reconciles too and
      // could otherwise hide a missing startup reconciliation.
      expect(JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))).toMatchObject({
        active: null, completed: { heal: { status: 'aborted' } },
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=author', address)))
      const started = toolBody(await client.callTool({ name: 'start_external_draft', arguments: {
        feature: 'workflow-workbench', stage: 'scaffolding', session_id: 'external', client_kind: 'codex',
      } }))
      expect(started).toMatchObject({ producer: 'external', canaryLabBehavior: 'tracking-only' })
      const read = await app.inject({ method: 'GET', url: '/api/onboarding' })
      expect(read.json().session.active).toMatchObject({ workflow: 'author', owner: 'external', target: { kind: 'draft', id: started.draftId } })
      await expect.poll(() => frames.filter((frame) => frame.type === 'getting-started-changed').length).toBeGreaterThan(0)
      const before = frames.filter((frame) => frame.type === 'getting-started-changed').length
      const settled = toolBody(await client.callTool({ name: 'update_external_draft_stage', arguments: {
        draftId: started.draftId, stage: 'error', message: 'Fixture deliberately stops authoring.',
      } }))
      // This is the supported agent response path; a WebSocket frame alone
      // does not prove anything entered an external agent's model context.
      expect(settled).toMatchObject({ draftId: started.draftId, status: 'error' })
      await expect.poll(() => frames.filter((frame) => frame.type === 'getting-started-changed').length).toBeGreaterThan(before)
      expect(JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))).toMatchObject({
        active: null, completed: { author: { status: 'error', owner: 'external' } },
      })
      const completed = await app.inject({ method: 'GET', url: '/api/onboarding' })
      expect(completed.json().session.completed.author.status).toBe('error')
    } finally {
      socket.close()
      await client.close()
      await app.close()
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  }, 15_000)
})
