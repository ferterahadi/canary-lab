import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import { writeRunsIndex } from './features/runs/logic/runtime/manifest'
import { discoveryRepairStore } from './features/config/logic/discovery-repair-store'

let root: string
let repoDir: string
let app: Awaited<ReturnType<typeof createServer>>['app']
let client: Client
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected MCP text')
  return result.content[0].text
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-repo-wiring-'))
  repoDir = path.join(root, 'repo')
  const suite = path.join(root, 'features', 'checkout')
  fs.mkdirSync(suite, { recursive: true }); fs.mkdirSync(repoDir)
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  git('commit', '--allow-empty', '-m', 'initial'); git('branch', 'other')
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), `module.exports={config:{name:'checkout',featureDir:__dirname,envs:[],repos:[{name:'app',localPath:${JSON.stringify(repoDir)},branch:'main'}]}}`)
  ;({ app } = await createServer({ projectRoot: root }))
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ name: 'repo-integration', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
})
afterEach(async () => { await client?.close(); await app?.close(); fs.rmSync(root, { recursive: true, force: true }) })

it.each(['rest', 'mcp'] as const)('shares checkout and update results, events, no-ops and refusals through %s', async (transport) => {
  const frames: Array<{ type: string }> = []
  const socket = await app.injectWS('/ws/workspace', {}, { onInit: (ws) => ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()))) })
  // A pong drains earlier frames so duplicate broadcasts cannot arrive after the assertion.
  const changes = async () => {
    await new Promise<void>((resolve) => { socket.once('pong', () => resolve()); socket.ping() })
    return frames.filter((frame) => frame.type === 'features-changed')
  }
  const mutate = async (operation: 'checkout' | 'update', branch = 'other') => {
    if (transport === 'rest') {
      const result = await app.inject({ method: 'POST', url: `/api/features/checkout/repos/app/${operation}`, payload: { branch } })
      return { failed: result.statusCode >= 400, body: result.json() }
    }
    const result = await client.callTool({ name: operation === 'checkout' ? 'checkout_feature_repo_branch' : 'update_feature_repo_branch', arguments: { feature: 'checkout', repo: 'app', branch, confirm: true } })
    return { failed: result.isError === true, body: result.isError ? { error: text(result) } : JSON.parse(text(result)) }
  }
  try {
    writeRunsIndex(path.join(root, 'logs'), [{ runId: 'busy', feature: 'checkout', status: 'running', startedAt: new Date().toISOString() }])
    for (const op of ['checkout', 'update'] as const) expect(await mutate(op)).toMatchObject({ failed: true, body: { error: 'repo has an active service run' } })
    expect(git('branch', '--show-current')).toBe('main')
    expect(await changes()).toEqual([])
    writeRunsIndex(path.join(root, 'logs'), [])
    const repair = { id: 'repair', feature: 'checkout', featureDir: path.join(root, 'features', 'checkout'), status: 'repairing' as const, owner: { kind: 'internal' as const, agent: 'claude' as const }, createdAt: 'now', updatedAt: 'now', heartbeatAt: 'now', message: '', diagnostic: '', log: [], promptPath: path.join(root, 'prompt.md') }
    discoveryRepairStore(path.join(root, 'logs')).save(repair)
    for (const op of ['checkout', 'update'] as const) expect(await mutate(op)).toMatchObject({ failed: true, body: { error: 'repo has an active service run' } })
    expect(await changes()).toEqual([])
    discoveryRepairStore(path.join(root, 'logs')).save({ ...repair, status: 'succeeded' })
    expect(await mutate('checkout')).toMatchObject({ failed: false, body: { currentBranch: 'other', expectedBranch: 'main' } })
    expect(await mutate('checkout')).toMatchObject({ failed: false, body: { currentBranch: 'other' } })
    expect(await changes()).toEqual([{ type: 'features-changed' }])
    const read = await client.callTool({ name: 'get_feature_repo_status', arguments: { feature: 'checkout', repo: 'app', fetch: false } })
    expect(JSON.parse(text(read))).toMatchObject({ currentBranch: 'other', expectedBranch: 'main' })
    expect(await mutate('checkout', 'nonexistent')).toMatchObject({ failed: true })
    expect(await changes()).toHaveLength(1)
    expect(await mutate('checkout', 'main')).toMatchObject({ failed: false })

    const origin = path.join(root, 'origin.git')
    git('init', '--bare', origin); git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main')
    const before = git('rev-parse', 'HEAD')
    git('commit', '--allow-empty', '-m', 'upstream'); const tip = git('rev-parse', 'HEAD'); git('push', 'origin', 'main'); git('reset', '--hard', before)
    expect(await mutate('update')).toMatchObject({ failed: false, body: { update: { kind: 'fast-forwarded' }, headSha: tip } })
    expect(await mutate('update')).toMatchObject({ failed: false, body: { update: { kind: 'up-to-date' } } })
    fs.writeFileSync(path.join(repoDir, 'dirty'), 'local work')
    expect(await mutate('update')).toMatchObject({ failed: true, body: { error: expect.stringContaining('dirty:') } })
    expect(await changes()).toHaveLength(3)
    const catchup = await client.callTool({ name: 'get_feature_repo_status', arguments: { feature: 'checkout', repo: 'app', fetch: false } })
    expect(JSON.parse(text(catchup))).toMatchObject({ currentBranch: 'main', headSha: tip, dirty: true })
  } finally { socket.close() }
})
