import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createServer } from './server'
import type { PtyFactory } from './features/runs/logic/runtime/pty-spawner'
import { trackTempDirs } from '../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-envset-wiring-')

let root: string
let server: Awaited<ReturnType<typeof createServer>>
let client: Client
beforeEach(() => {
  root = tempDir()
  vi.stubEnv('CANARY_LAB_PROJECT_ROOT', root)
})
afterEach(async () => {
  await client?.close()
  await server?.app.close()
  vi.unstubAllEnvs()
})

it.each(['CANARY_LAB', 'CANARY_LAB_PROJECT_ROOT'])('applies the REST-displayed %s target during real run preparation and restores it at stop', async (alias) => {
  // Declared featureDir is linked outside features/, but still belongs to this
  // temporary workspace. Only PTY launch is replaced; preparation stays real.
  const discoveryDir = path.join(root, 'features', 'example')
  const featureDir = path.join(root, 'linked-suite')
  const envsetsDir = path.join(featureDir, 'envsets')
  fs.mkdirSync(discoveryDir, { recursive: true })
  fs.mkdirSync(path.join(envsetsDir, 'local'), { recursive: true })
  fs.writeFileSync(path.join(discoveryDir, 'feature.config.cjs'), `module.exports={config:{name:'example',featureDir:${JSON.stringify(featureDir)},envs:['local'],repos:[]}}`)
  const rawTarget = `$${alias}/linked-suite/.env`
  fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), JSON.stringify({
    appRoots: {}, slots: { 'app.env': { target: rawTarget } }, feature: { slots: ['app.env'], testCommand: 'true', testCwd: featureDir },
  }))
  fs.writeFileSync(path.join(envsetsDir, 'local', 'app.env'), 'TOKEN=fixture-secret\n')
  const target = path.join(featureDir, '.env')
  fs.writeFileSync(target, 'ORIGINAL=yes\n')
  const ptyFactory: PtyFactory = vi.fn(() => ({ pid: 0, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} }))
  server = await createServer({ projectRoot: root, ptyFactory })
  const { app } = server
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ name: 'envset-runtime-test', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp?profile=full', address)))
  const index = await app.inject({ url: '/api/features/example/envsets' })
  expect(index.statusCode).toBe(200)
  expect(index.json().slotTargets).toEqual({ 'app.env': target })
  expect(index.json().slotTargetsRaw).toEqual({ 'app.env': rawTarget })
  const started = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'example', env: 'local', mode: 'boot', updateRepos: false } })
  expect(started.statusCode, started.payload).toBe(201)
  const runId = started.json().runId
  try {
    expect(fs.readFileSync(target, 'utf8')).toBe('TOKEN=fixture-secret\n')
    expect(fs.existsSync(path.join(root, `$${alias}`))).toBe(false)
    const agent = await client.callTool({ name: 'get_feature_envset_summary', arguments: { feature: 'example' } })
    expect(agent.isError).not.toBe(true)
    if (!Array.isArray(agent.content) || agent.content[0]?.type !== 'text') throw new Error('Expected MCP text')
    expect(agent.content[0].text).not.toContain('fixture-secret')
    expect(JSON.parse(agent.content[0].text).envs[0].slots[0]).toMatchObject({ target: rawTarget, preview: [{ key: 'TOKEN', value: '********' }] })
  } finally {
    const stopped = await app.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/abort` })
    expect(stopped.statusCode, stopped.payload).toBe(204)
  }
  expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL=yes\n')
  expect(fs.readdirSync(featureDir).filter((name) => name.includes('.bak.'))).toEqual([])
  expect(ptyFactory).not.toHaveBeenCalled()
})
