import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import type { PtyFactory } from './features/runs/logic/runtime/pty-spawner'
import { trackTempDirs } from '../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-identity-wiring-')

let root: string
let repo: string
let alias: string
let server: Awaited<ReturnType<typeof createServer>>
let client: Client
let owner: string
const ptyFactory: PtyFactory = vi.fn(() => { throw new Error('This fixture must not launch a process') })

function writeSuite(name: string, localPath: string, tracked = false) {
  const dir = path.join(root, 'features', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), `module.exports={config:{name:${JSON.stringify(name)},description:'identity fixture',featureDir:__dirname,envs:[],repos:[{name:'app',localPath:${JSON.stringify(localPath)},${tracked ? "track:'upstream'," : ''}startCommands:[]}]}}`)
}

function toolValue(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).not.toBe(true)
  if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text')
  return JSON.parse(result.content[0].text)
}

beforeEach(async () => {
  root = tempDir()
  repo = path.join(root, 'repo'); alias = path.join(root, 'alias')
  fs.mkdirSync(repo); fs.symlinkSync(repo, alias, 'dir')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: repo })
  writeSuite('owner', repo); writeSuite('candidate', alias)
  vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
  vi.clearAllMocks()
  server = await createServer({ projectRoot: root, ptyFactory })
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ name: 'identity-integration', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  const started = await server.app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'owner', mode: 'boot', updateRepos: false } })
  expect(started.statusCode, started.payload).toBe(201)
  owner = started.json().runId
  await vi.waitFor(() => expect(server.runStore.get(owner)?.manifest.status).toBe('running'))
})

afterEach(async () => {
  await client?.close(); await server?.app.close()
  vi.unstubAllEnvs()
})

it.each(['rest', 'mcp'] as const)('refuses an alias, queues it, and delivers promotion through production %s wiring', async (transport) => {
  const { app, runStore, registry } = server
  const frames: string[] = []
  const socket = await app.injectWS('/ws/runs', {}, { onInit: (ws) => ws.on('message', (raw) => frames.push(raw.toString())) })
  try {
    const rest = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'candidate', mode: 'boot', updateRepos: false } })
    expect(rest.statusCode).toBe(409)
    const mcp = toolValue(await client.callTool({ name: 'boot_services', arguments: { feature: 'candidate' } }))
    const collision = { type: 'repo_collision_requires_choice', conflictingRunId: owner, conflictingFeature: 'owner', repoPaths: [repo], options: ['worktree', 'queue'] }
    expect(rest.json()).toMatchObject(collision)
    expect(mcp).toMatchObject(collision)
    expect(runStore.list()).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
    expect(ptyFactory).not.toHaveBeenCalled()

    let queued: string
    if (transport === 'rest') {
      const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'candidate', mode: 'boot', isolation: 'queue', updateRepos: false } })
      expect(response.statusCode).toBe(202)
      expect(response.json()).toMatchObject({ status: 'queued', queueReason: 'repo-collision' })
      queued = response.json().runId
    } else {
      const response = toolValue(await client.callTool({ name: 'boot_services', arguments: { feature: 'candidate', isolation: 'queue' } }))
      expect(response).toMatchObject({ queued: true, queueReason: 'repo-collision' })
      queued = response.runId
    }
    expect(runStore.get(queued)?.manifest.repoPaths).toEqual([repo])
    const diagnostic = await app.inject({ url: `/api/runs/${queued}/queue` })
    expect(diagnostic.json()).toMatchObject({ diagnostics: { reason: 'repo-collision', conflictingRunId: owner } })
    expect(registry.list()).toHaveLength(1)
    expect((await app.inject({ method: 'POST', url: `/api/runs/${owner}/abort` })).statusCode).toBe(204)
    await vi.waitFor(() => expect(runStore.get(queued)?.manifest.status).toBe('running'))
    // The writer records execution paths, not canonical comparison identities.
    expect(runStore.get(queued)?.manifest.repoPaths).toEqual([alias])
    await vi.waitFor(() => expect(frames.some((frame) => frame.includes(queued) && frame.includes('running'))).toBe(true))
    const agent = toolValue(await client.callTool({ name: 'get_run', arguments: { runId: queued } }))
    expect(JSON.stringify(agent)).toContain('running')
    expect(JSON.stringify(agent)).toContain(queued)
    expect(ptyFactory).not.toHaveBeenCalled()
    expect((await app.inject({ method: 'POST', url: `/api/runs/${queued}/abort` })).statusCode).toBe(204)
  } finally { socket.close() }
})

it('refuses an occupied alias upstream update through REST and MCP without touching the checkout', async () => {
  writeSuite('candidate', alias, true)
  const gitDir = path.join(repo, '.git')
  const before = fs.readdirSync(gitDir).sort()
  const rest = await server.app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'candidate', mode: 'boot', updateRepos: true } })
  expect(rest.statusCode).toBe(409)
  expect(rest.json()).toMatchObject({ type: 'repo_update_refused', repos: [{ path: alias, reason: 'in-use' }] })
  const agent = toolValue(await client.callTool({ name: 'boot_services', arguments: { feature: 'candidate' } }))
  expect(agent).toMatchObject({ type: 'repo_update_refused', repos: [{ path: alias, reason: 'in-use' }] })
  expect(fs.readdirSync(gitDir).sort()).toEqual(before)
  expect(server.runStore.list()).toHaveLength(1)
  expect(ptyFactory).not.toHaveBeenCalled()
})
