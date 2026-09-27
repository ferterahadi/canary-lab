import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { FlightRunStore } from './features/flights/logic/store'
import { PortifyRunStore } from './features/portify/logic/runtime/store'
import { FLIGHT_STAGE_KEYS } from './features/flights/logic/types'
import { writeManifest } from './features/runs/logic/runtime/manifest'
import { runDirFor } from './features/runs/logic/runtime/run-paths'

let root: string
let app: Awaited<ReturnType<typeof createServer>>['app']
let client: Client
afterEach(async () => {
  await app?.inject({ method: 'POST', url: '/api/flights/path-fixture/pause' })
  await client?.close()
  await app?.close()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

it('publishes repeated quoted-path edits through the real Flight wiring and exposes decoded fix preflight', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-path-wiring-'))
  const repo = path.join(root, 'repo')
  const featureDir = path.join(root, 'features', 'paths')
  const logsDir = path.join(root, 'logs')
  fs.mkdirSync(repo); fs.mkdirSync(featureDir, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  const fileName = 'café -> "port".ts'
  const file = path.join(repo, fileName)
  fs.writeFileSync(file, 'original')
  git('add', '.'); git('commit', '-qm', 'fixture')
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), `module.exports={config:{name:'paths',featureDir:__dirname,envs:[],repos:[{name:'app',localPath:${JSON.stringify(repo)}}]}}`)
  new FlightRunStore(logsDir).save({
    flightId: 'path-fixture', feature: 'paths', description: 'Git path fixture', repoPaths: [repo],
    opts: { env: 'local', coverageTarget: 100, yolo: false, autopilot: false },
    status: 'paused', pauseReason: 'user', currentStage: 'portify',
    stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'portify' ? 'pending' : 'skipped' })),
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  })
  const runDir = runDirFor(logsDir, 'path-run')
  fs.mkdirSync(runDir, { recursive: true })
  writeManifest(path.join(runDir, 'manifest.json'), {
    runId: 'path-run', feature: 'paths', featureDir, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
    status: 'failed', healCycles: 1, services: [],
    fixCapture: { capturedAt: '2026-01-01T00:01:00Z', repos: [{ repoName: 'app', repoRoot: repo, baseSha: 'HEAD', files: 1, patchFile: 'app.patch', patchPath: path.join(runDir, 'app.patch'), fileNames: [JSON.stringify(fileName)] }] },
  })
  ;({ app } = await createServer({ projectRoot: root }))
  // Seed after startup reconciliation. This represents an external producer's
  // editing window, so exercising the real conductor never spawns an agent.
  new PortifyRunStore(logsDir).save({
    workflowId: 'path-portify', feature: 'paths', featureDir, agent: 'claude', producer: 'external',
    branch: 'main', status: 'editing', attempt: 1, maxAttempts: 3, startedAt: '2026-01-01T00:00:00Z',
    repos: [{ name: 'app', path: repo, worktreePath: repo }],
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ name: 'path-integration', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  const frames: Array<{ type: string; consumers?: Array<{ runId?: string }> }> = []
  const socket = await app.injectWS('/ws/workspace', {}, { onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))) })
  const readFlight = async () => (await app.inject({ url: '/api/flights/path-fixture' })).json()
  const progress = (flight: Awaited<ReturnType<typeof readFlight>>) => flight.stages.find((stage: { key: string }) => stage.key === 'portify').progress
  const readAgent = async () => {
    const result = await client.callTool({ name: 'get_flight', arguments: { flightId: 'path-fixture' } })
    expect(result.isError).not.toBe(true)
    if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    return JSON.parse(result.content[0].text)
  }
  try {
    fs.writeFileSync(file, 'first edit'); fs.utimesSync(file, 1700000000, 1700000000)
    expect((await app.inject({ method: 'POST', url: '/api/flights/path-fixture/resume' })).statusCode).toBe(200)
    await expect.poll(async () => progress(await readFlight())?.editedFiles).toBe(1)
    const first = await readFlight()
    frames.length = 0
    fs.writeFileSync(file, 'second edit'); fs.utimesSync(file, 1700000002, 1700000002)
    await expect.poll(async () => (await readFlight()).updatedAt, { timeout: 6000 }).not.toBe(first.updatedAt)
    expect(frames.some((frame) => frame.type === 'flights-changed')).toBe(true)
    // get_flight deliberately returns a slim stage view without progress counts.
    expect((await readAgent()).stages).toContainEqual({ key: 'portify', status: 'running' })
    fs.writeFileSync(path.join(repo, 'tab\tforeign.ts'), 'foreign')
    await expect.poll(async () => progress(await readFlight())?.editedFiles, { timeout: 6000 }).toBe(2)
    const repoRead = await client.callTool({ name: 'get_feature_repo_status', arguments: { feature: 'paths', repo: 'app', fetch: false } })
    expect(repoRead.isError).not.toBe(true)
    if (!Array.isArray(repoRead.content) || repoRead.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    expect(JSON.parse(repoRead.content[0].text).dirtyFiles).toHaveLength(2)
    const preflight = await app.inject({ url: '/api/runs/path-run/apply-preflight' })
    expect(preflight.statusCode).toBe(200)
    expect(preflight.json().targets[0].foreignDirty).toEqual(['tab\tforeign.ts'])
    const runRead = await client.callTool({ name: 'get_run', arguments: { runId: 'path-run' } })
    if (!Array.isArray(runRead.content) || runRead.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    expect(JSON.parse(runRead.content[0].text).manifest.fixCapture.repos[0]).toMatchObject({ fileNames: [fileName], fileNamesFormat: 'literal' })
    frames.length = 0
    fs.unlinkSync(path.join(repo, 'tab\tforeign.ts'))
    await expect.poll(() => frames.some((frame) => frame.type === 'repos-changed' && frame.consumers?.some((c) => c.runId === 'path-run'))).toBe(true)
    expect((await app.inject({ url: '/api/runs/path-run/apply-preflight' })).json().targets[0].foreignDirty).toEqual([])
    const indexPath = path.join(repo, '.git', 'index')
    const index = fs.readFileSync(indexPath)
    fs.writeFileSync(indexPath, 'corrupted index')
    expect((await app.inject({ url: '/api/runs/path-run/apply-preflight' })).statusCode).toBe(500)
    fs.writeFileSync(indexPath, index)
    expect((await app.inject({ url: '/api/runs/path-run/apply-preflight' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/flights/path-fixture/pause' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: '/api/flights/path-fixture' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/flights/path-fixture' })).statusCode).toBe(404)
    expect((await client.callTool({ name: 'get_flight', arguments: { flightId: 'path-fixture' } })).isError).toBe(true)
  } finally { socket.close() }
}, 20_000)
