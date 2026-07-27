import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { featureConfigRoutes } from './feature-config'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

let tmpDir: string

let featuresDir: string

function buildFeature(name: string, opts: {
  config?: string
  playwright?: string
  envsets?: Record<string, Record<string, string>>
  envsetsConfig?: string
} = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    opts.config ?? `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  if (opts.playwright !== undefined) {
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), opts.playwright)
  }
  if (opts.envsets) {
    for (const [env, slots] of Object.entries(opts.envsets)) {
      const envDir = path.join(dir, 'envsets', env)
      fs.mkdirSync(envDir, { recursive: true })
      for (const [slot, contents] of Object.entries(slots)) {
        fs.writeFileSync(path.join(envDir, slot), contents)
      }
    }
  }
  if (opts.envsetsConfig !== undefined) {
    const envsetsDir = path.join(dir, 'envsets')
    fs.mkdirSync(envsetsDir, { recursive: true })
    fs.writeFileSync(path.join(envsetsDir, 'envsets.config.json'), opts.envsetsConfig)
  }
  return dir
}

async function makeApp(opts: {
  isRepoActive?: (feature: string, repo: string) => boolean
  events?: WorkspaceEvent[]
  featureRename?: {
    blockedBy: (feature: string) => string | null
    apply: (from: string, to: string) => number
  }
} = {}): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await featureConfigRoutes(a, {
      featuresDir,
      isRepoActive: opts.isRepoActive,
      ...(opts.featureRename ? { featureRename: opts.featureRename } : {}),
      workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
    })
  })
  await app.ready()
  return app
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fcfg-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('playwright.config endpoints', () => {
  it('GET returns parsed playwright config', async () => {
    buildFeature('alpha', {
      playwright: `import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './e2e' })`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/alpha/playwright' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { parsed: { value: { testDir: string } } }
      expect(body.parsed.value.testDir).toBe('./e2e')
    } finally {
      await app.close()
    }
  })

  it('GET 404 when playwright config is missing', async () => {
    buildFeature('beta')
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/beta/playwright' })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('GET 404 for unknown feature on playwright endpoint', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/nope/playwright' })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT writes patched playwright config', async () => {
    buildFeature('gamma', {
      playwright: `module.exports = { testDir: './e2e' }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/gamma/playwright',
        payload: { value: { testDir: './tests' } },
      })
      expect(r.statusCode).toBe(200)
      const onDisk = fs.readFileSync(path.join(featuresDir, 'gamma', 'playwright.config.ts'), 'utf-8')
      expect(onDisk).toContain("testDir: './tests'")
    } finally {
      await app.close()
    }
  })

  it('PUT emits features-changed so an open editor refetches live', async () => {
    buildFeature('gamma-evt', {
      playwright: `module.exports = { testDir: './e2e' }`,
    })
    const events: WorkspaceEvent[] = []
    const app = await makeApp({ events })
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/gamma-evt/playwright',
        payload: { value: { testDir: './tests' } },
      })
      expect(r.statusCode).toBe(200)
      expect(events).toContainEqual({ type: 'features-changed' })
    } finally {
      await app.close()
    }
  })

  it('PUT 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/nope/playwright',
        payload: { value: { testDir: './e2e' } },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT 404 when playwright file is missing', async () => {
    buildFeature('delta')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/delta/playwright',
        payload: { value: { testDir: './e2e' } },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT 400 when value is not an object', async () => {
    buildFeature('eps', {
      playwright: `module.exports = { testDir: './e2e' }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/eps/playwright',
        payload: { value: [] },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
