import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { FlightRunStore } from './features/flights/logic/store'
import { FLIGHT_STAGE_KEYS } from '../../../shared/flights/types'

let root: string
let repo: string
let service: string
let app: Awaited<ReturnType<typeof createServer>>['app']
let client: Client
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-remedy-wiring-'))
  repo = path.join(root, 'repo')
  service = path.join(repo, 'service')
  const suite = path.join(root, 'features', 'checkout')
  fs.mkdirSync(service, { recursive: true })
  fs.mkdirSync(suite, { recursive: true })
  fs.writeFileSync(path.join(service, 'tracked'), 'original')
  fs.writeFileSync(path.join(repo, 'sibling'), 'original')
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  git('add', '.'); git('commit', '-m', 'fixture')
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), `module.exports={config:{name:'checkout',featureDir:__dirname,envs:[],repos:[{name:'service',localPath:${JSON.stringify(service)}}]}}`)
  new FlightRunStore(path.join(root, 'logs')).save({
    flightId: 'dirty-flight', feature: 'checkout', repoPaths: [service], description: 'fixture',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'paused', pauseReason: 'stage-failed', currentStage: 'portify',
    stages: FLIGHT_STAGE_KEYS.map((key) => key === 'portify'
      ? { key, status: 'failed', error: 'repo "service" has uncommitted changes' }
      : { key, status: 'pending' }),
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  })
  ;({ app } = await createServer({ projectRoot: root }))
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ name: 'remedy-integration', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
})

afterEach(async () => {
  await client?.close()
  await app?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

it('reads current directory-scoped remedy counts through REST and a connected MCP client', async () => {
  const assertRepos = async (modified: number) => {
    const expected = modified ? [{ name: 'service', path: service, modified }] : []
    const rest = await app.inject({ url: '/api/flights/dirty-flight/remedy' })
    expect(rest.statusCode).toBe(200)
    expect(rest.json().remedy.repos).toEqual(expected)
    const mcp = await client.callTool({ name: 'get_flight', arguments: { flightId: 'dirty-flight' } })
    expect(mcp.isError).not.toBe(true)
    if (!Array.isArray(mcp.content) || mcp.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    expect(JSON.parse(mcp.content[0].text).remedy.repos).toEqual(expected)
  }
  fs.writeFileSync(path.join(repo, 'sibling'), 'unrelated dirt')
  fs.writeFileSync(path.join(service, 'tracked'), 'edited')
  fs.writeFileSync(path.join(service, 'new'), 'untracked')
  await assertRepos(2)
  fs.unlinkSync(path.join(service, 'new'))
  await assertRepos(1)
  fs.writeFileSync(path.join(service, 'tracked'), 'original')
  await assertRepos(0)
  expect(fs.readFileSync(path.join(repo, 'sibling'), 'utf8')).toBe('unrelated dirt')

  const index = path.join(repo, '.git', 'index')
  const bytes = fs.readFileSync(index)
  fs.writeFileSync(path.join(service, 'tracked'), 'edited again')
  fs.writeFileSync(index, 'corrupt index')
  await assertRepos(0) // Flight recovery retains its skip-on-read-failure policy.
  fs.writeFileSync(index, bytes)
  await assertRepos(1)
})

it('delivers scoped filesystem hints to existing workspace connections and fresh REST/MCP reads', async () => {
  const frames: Array<{ type: string; consumers?: unknown[] }> = []
  const socket = await app.injectWS('/ws/workspace', {}, { onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))) })
  try {
    const status = await app.inject({ url: '/api/features/checkout/repos/service/git' })
    expect(status.statusCode).toBe(200)
    await app.inject({ url: '/api/flights/dirty-flight/remedy' })
    const index = path.join(repo, '.git', 'index')
    const before = fs.readFileSync(index)
    fs.writeFileSync(path.join(service, 'tracked'), 'external edit')
    await expect.poll(() => frames.flatMap((frame) => frame.type === 'repos-changed' ? frame.consumers ?? [] : []), { timeout: 5000 }).toEqual(expect.arrayContaining([
      { flightId: 'dirty-flight' }, { feature: 'checkout', repo: 'service' },
    ]))
    expect((await app.inject({ url: '/api/flights/dirty-flight/remedy' })).json().remedy.repos[0].modified).toBe(1)
    frames.length = 0
    fs.writeFileSync(path.join(service, 'tracked'), 'original')
    await expect.poll(() => frames.some((frame) => frame.type === 'repos-changed'), { timeout: 5000 }).toBe(true)
    const mcp = await client.callTool({ name: 'get_flight', arguments: { flightId: 'dirty-flight' } })
    if (!Array.isArray(mcp.content) || mcp.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    expect(JSON.parse(mcp.content[0].text).remedy.repos).toEqual([])
    expect(fs.readFileSync(index)).toEqual(before)
    frames.length = 0
    git('checkout', '-b', 'external-branch')
    await expect.poll(() => frames.some((frame) => frame.type === 'repos-changed'), { timeout: 5000 }).toBe(true)
    const agent = await client.callTool({ name: 'get_feature_repo_status', arguments: { feature: 'checkout', repo: 'service', fetch: false } })
    expect(agent.isError).not.toBe(true)
    if (!Array.isArray(agent.content) || agent.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    expect(JSON.parse(agent.content[0].text).currentBranch).toBe('external-branch')
  } finally { socket.close() }
})
