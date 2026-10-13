import fs from 'fs'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { registerFeatureConfigDocRoutes } from './feature-config-doc'
import { registerPlaywrightConfigRoutes } from './playwright-config-routes'
import type { WorkspaceEvent } from '../../../../../../shared/workspace-events'
import { readFeatureConfig } from '../../../shared/config-ast'

const tempDir = trackTempDirs('config-document-routes-')
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const featuresDir = tempDir()
  const featureDir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
  const configPath = path.join(featureDir, 'feature.config.cjs')
  const playwrightPath = path.join(featureDir, 'playwright.config.ts')
  fs.writeFileSync(configPath, "module.exports = { config: { name: 'checkout', description: 'Checkout', envs: ['local'], featureDir: __dirname } }")
  fs.writeFileSync(playwrightPath, "module.exports = { testDir: './e2e' }")
  const events: WorkspaceEvent[] = []
  const order: string[] = []
  const app = Fastify()
  const deps = {
    featuresDir,
    workspaceEvents: { publish: (event: WorkspaceEvent) => { events.push(event); order.push(event.type) } },
    featureRename: {
      blockedBy: () => null,
      apply: (_from: string, to: string) => {
        expect(readFeatureConfig(fs.readFileSync(configPath, 'utf8')).value).toMatchObject({ name: to })
        order.push('rename-applied')
        return 1
      },
    },
  }
  await registerFeatureConfigDocRoutes(app, deps)
  await registerPlaywrightConfigRoutes(app, deps)
  await app.ready()
  return { app, events, order, configPath, playwrightPath }
}

describe('configuration write publication', () => {
  it.each(['config-doc', 'playwright'])('keeps the file and publishes nothing on invalid %s input', async (endpoint) => {
    const f = await fixture()
    const file = endpoint === 'config-doc' ? f.configPath : f.playwrightPath
    const before = fs.readFileSync(file, 'utf8')
    try {
      const reply = await f.app.inject({ method: 'PUT', url: `/api/features/checkout/${endpoint}`, payload: { value: [] } })
      expect(reply.statusCode).toBe(400)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
      expect(f.events).toEqual([])
    } finally { await f.app.close() }
  })

  it.each(['config-doc', 'playwright'])('retains a server error and publishes nothing when a %s write is denied', async (endpoint) => {
    const f = await fixture()
    const file = endpoint === 'config-doc' ? f.configPath : f.playwrightPath
    const before = fs.readFileSync(file, 'utf8')
    const write = fs.writeFileSync
    // Keep resolution, reads and AST serialization real; deny only the final
    // write syscall so the registered route's error/publication path is tested.
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (args[0] === file) throw new Error('write denied')
      return write(...args)
    })
    try {
      const value = endpoint === 'config-doc' ? { name: 'checkout', description: 'Updated' } : { testDir: './tests' }
      const reply = await f.app.inject({ method: 'PUT', url: `/api/features/checkout/${endpoint}`, payload: { value } })
      expect(reply.statusCode).toBe(500)
      expect(fs.readFileSync(file, 'utf8')).toBe(before)
      expect(f.events).toEqual([])
    } finally { await f.app.close() }
  })

  it('persists synchronized environments before applying rename and publishing events', async () => {
    const f = await fixture()
    try {
      const reply = await f.app.inject({ method: 'PUT', url: '/api/features/checkout/config-doc',
        payload: { value: { name: 'renamed', description: 'Updated', envs: ['invented'] } } })
      expect(reply.statusCode).toBe(200)
      expect(reply.json()).toMatchObject({ path: f.configPath, format: 'cjs', parsed: { value: { name: 'renamed', envs: ['local'] } } })
      expect(reply.json().content).toBe(fs.readFileSync(f.configPath, 'utf8'))
      expect(f.order).toEqual(['rename-applied', 'feature-renamed', 'features-changed'])
      expect(f.events[0]).toEqual({ type: 'feature-renamed', from: 'checkout', to: 'renamed' })
    } finally { await f.app.close() }
  })
})
