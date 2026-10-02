import type { WorkspaceEvent } from '../../../../../../shared/workspace-events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { registerEnvsetRoutes } from './envset-routes'
import { registerFeatureEnvTools } from '../../../mcp/tool-groups/authoring-env'
import { captureTools, type CapturedTools } from '../../../mcp/tool-groups/__fixtures__/tool-group-harness'
import { readFeatureConfig } from '../../../shared/config-ast'


let root: string
let suite: string
let metadata: string
let source: string
let app: FastifyInstance
let tools: CapturedTools
let events: WorkspaceEvent[]
const error = 'envsets.config.json must contain a valid JSON object'

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-envset-metadata-'))
  const featuresDir = path.join(root, 'features')
  suite = path.join(featuresDir, 'checkout')
  fs.mkdirSync(path.join(suite, 'envsets', 'local'), { recursive: true })
  fs.writeFileSync(path.join(suite, 'feature.config.cjs'), "module.exports = { config: { name: 'checkout', description: 'fixture', envs: ['stale'], featureDir: __dirname, repos: [] } }")
  fs.writeFileSync(path.join(suite, 'envsets', 'local', 'app.env'), 'TOKEN=secret-fixture-value\n')
  source = path.join(root, 'import.env')
  fs.writeFileSync(source, 'KEY=secret-fixture-value\n')
  metadata = path.join(suite, 'envsets', 'envsets.config.json')
  events = []
  const deps = { projectRoot: root, featuresDir, workspaceEvents: { publish: (event: WorkspaceEvent) => events.push(event) } }
  app = Fastify()
  await registerEnvsetRoutes(app, deps)
  tools = captureTools(registerFeatureEnvTools, deps)
})
afterEach(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }) })

it.each(['{private', 'null', '[]', '42', '"private"', 'false'])('refuses REST and MCP metadata operations without mutation for %s, then recovers', async (invalid) => {
  fs.writeFileSync(metadata, invalid)
  const config = fs.readFileSync(path.join(suite, 'feature.config.cjs'), 'utf8')
  const read = await app.inject({ method: 'GET', url: '/api/features/checkout/envsets' })
  expect(read.statusCode).toBe(409)
  expect(read.json().message).toBe(error)
  for (const method of ['POST', 'DELETE'] as const) {
    const response = await app.inject({ method, url: `/api/features/checkout/envsets/slots${method === 'DELETE' ? '/app.env' : ''}`,
      ...(method === 'POST' ? { payload: { sourcePath: source, slotName: 'new.env' } } : {}),
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().message).toBe(error)
  }
  const summary = await tools.raw('get_feature_envset_summary', { feature: 'checkout' })
  expect(summary).toMatchObject({ isError: true, content: [{ type: 'text', text: error }] })
  const refused = await tools.raw('capture_feature_env_files', { feature: 'checkout', sources: [{ sourcePath: source, env: 'staging', slot: 'new.env' }] })
  expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: error }] })
  expect(fs.readFileSync(metadata, 'utf8')).toBe(invalid)
  expect(fs.readFileSync(path.join(suite, 'envsets', 'local', 'app.env'), 'utf8')).toBe('TOKEN=secret-fixture-value\n')
  expect(fs.readdirSync(path.join(suite, 'envsets', 'local'))).toEqual(['app.env'])
  expect(fs.existsSync(path.join(suite, 'envsets', 'staging'))).toBe(false)
  expect(fs.readFileSync(path.join(suite, 'feature.config.cjs'), 'utf8')).toBe(config)
  expect(events).toEqual([])

  fs.writeFileSync(metadata, '{"custom":{"retained":true}}')
  const captured = await tools.call('capture_feature_env_files', { feature: 'checkout', sources: [{ sourcePath: source, env: 'staging', slot: 'new.env' }] })
  expect(captured.ok).toBe(true)
  expect(JSON.stringify(captured)).not.toContain('secret-fixture-value')
  expect(readFeatureConfig(fs.readFileSync(path.join(suite, 'feature.config.cjs'), 'utf8')).value).toMatchObject({ envs: ['local', 'staging'] })
  expect(JSON.parse(fs.readFileSync(metadata, 'utf8'))).toMatchObject({ custom: { retained: true } })
  expect(events).toEqual([{ type: 'envsets-changed', feature: 'checkout' }, { type: 'features-changed' }])
  const removed = await app.inject({ method: 'DELETE', url: '/api/features/checkout/envsets/slots/new.env' })
  expect(removed.statusCode).toBe(204)
  expect(fs.existsSync(path.join(suite, 'envsets', 'staging', 'new.env'))).toBe(false)
  const added = await app.inject({ method: 'POST', url: '/api/features/checkout/envsets/slots', payload: { sourcePath: source, slotName: 'new.env' } })
  expect(added.statusCode).toBe(201)
  expect(fs.readFileSync(path.join(suite, 'envsets', 'local', 'new.env'), 'utf8')).toBe('KEY=secret-fixture-value\n')
  expect((await app.inject({ method: 'GET', url: '/api/features/checkout/envsets' })).statusCode).toBe(200)
})

it('keeps raw slot content and environment-directory operations independent of metadata', async () => {
  fs.writeFileSync(metadata, 'null')
  const url = '/api/features/checkout/envsets/local/app.env'
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200)
  const written = await app.inject({ method: 'PUT', url, payload: { entries: [{ key: 'TOKEN', value: 'updated' }] } })
  expect(written.statusCode).toBe(200)
  expect(written.json().entries).toEqual([{ key: 'TOKEN', value: 'updated' }])
  expect((await app.inject({ method: 'POST', url: '/api/features/checkout/envsets', payload: { env: 'staging' } })).statusCode).toBe(201)
  expect((await app.inject({ method: 'DELETE', url: '/api/features/checkout/envsets/staging' })).statusCode).toBe(204)
  expect(fs.readFileSync(metadata, 'utf8')).toBe('null')
})

it('announces each REST mutation exactly once with the appropriate scope', async () => {
  const slotEvent = { type: 'envsets-changed', feature: 'checkout' }
  const url = '/api/features/checkout/envsets'
  for (let attempt = 0; attempt < 2; attempt++) {
    events.length = 0
    const result = await app.inject({ method: 'PUT', url: `${url}/local/app.env`, payload: { entries: [{ key: 'TOKEN', value: 'same' }] } })
    expect(result.statusCode).toBe(200)
    expect(events).toEqual([slotEvent])
  }
  for (const method of ['POST', 'DELETE'] as const) {
    events.length = 0
    const result = await app.inject({ method, url: method === 'POST' ? url : `${url}/staging`, ...(method === 'POST' ? { payload: { env: 'staging' } } : {}) })
    expect(result.statusCode).toBe(method === 'POST' ? 201 : 204)
    expect(events).toEqual([slotEvent, { type: 'features-changed' }])
  }
  for (const method of ['POST', 'DELETE'] as const) {
    events.length = 0
    const result = await app.inject({ method, url: `${url}/slots${method === 'DELETE' ? '/new.env' : ''}`, ...(method === 'POST' ? { payload: { sourcePath: source, slotName: 'new.env' } } : {}) })
    expect(result.statusCode).toBe(method === 'POST' ? 201 : 204)
    expect(events).toEqual([slotEvent])
  }
  events.length = 0
  expect((await app.inject({ method: 'POST', url, payload: { env: 'local' } })).statusCode).toBe(409)
  expect((await app.inject({ method: 'PUT', url: `${url}/local/missing.env`, payload: { entries: [] } })).statusCode).toBe(404)
  expect((await app.inject({ method: 'PUT', url: `${url}/local/app.env`, payload: {} })).statusCode).toBe(400)
  expect(events).toEqual([])
})

it('does not announce a REST filesystem failure before persistence finishes', async () => {
  const slotPath = path.join(suite, 'envsets', 'local', 'app.env')
  fs.rmSync(slotPath)
  fs.mkdirSync(slotPath)
  const result = await app.inject({ method: 'PUT', url: '/api/features/checkout/envsets/local/app.env', payload: { entries: [] } })
  expect(result.statusCode).toBe(500)
  expect(events).toEqual([])
})

it('deletes a renamed suite environment and returns an empty declaration for the final environment', async () => {
  const config = path.join(suite, 'feature.config.cjs')
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace("name: 'checkout'", "name: 'renamed'"))
  const response = await app.inject({ method: 'DELETE', url: '/api/features/renamed/envsets/local' })
  expect(response.statusCode).toBe(204)
  expect(response.payload).toBe('')
  expect(readFeatureConfig(fs.readFileSync(config, 'utf8')).value.envs).toEqual([])
  expect(fs.existsSync(path.join(suite, 'envsets', 'local'))).toBe(false)
  expect(events).toEqual([{ type: 'envsets-changed', feature: 'renamed' }, { type: 'features-changed' }])
})

it.each(['%2e', '%2e%2e%2foutside'])('refuses invalid environment target %s without removal or announcements', async (env) => {
  const response = await app.inject({ method: 'DELETE', url: `/api/features/checkout/envsets/${env}` })
  expect(response.statusCode).toBe(404)
  expect(fs.existsSync(path.join(suite, 'envsets', 'local', 'app.env'))).toBe(true)
  expect(events).toEqual([])
})
