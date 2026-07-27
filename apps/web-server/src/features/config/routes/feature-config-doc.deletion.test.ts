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

describe('feature deletion endpoint', () => {
  it('deletes the whole feature directory when the confirmation name matches', async () => {
    const events: WorkspaceEvent[] = []
    const featureDir = buildFeature('gone', {
      playwright: `module.exports = { testDir: './e2e' }`,
      envsets: { local: { 'feature.env': 'A=1\n' } },
    })
    const app = await makeApp({ events })
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/gone',
        payload: { confirmName: 'gone' },
      })
      expect(r.statusCode).toBe(204)
      expect(fs.existsSync(featureDir)).toBe(false)
      expect(events).toContainEqual({ type: 'feature-deleted', feature: 'gone' })
    } finally {
      await app.close()
    }
  })

  it('rejects deletion unless the confirmation name exactly matches', async () => {
    const featureDir = buildFeature('keep')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/keep',
        payload: { confirmName: 'nope' },
      })
      expect(r.statusCode).toBe(400)
      expect(fs.existsSync(featureDir)).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('returns 404 for unknown features', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/missing',
        payload: { confirmName: 'missing' },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('refuses to delete when the config points outside the features root', async () => {
    const outsideDir = path.join(tmpDir, 'outside-feature')
    fs.mkdirSync(outsideDir, { recursive: true })
    buildFeature('external', {
      config: `module.exports = { config: { name: 'external', description: 'd', repos: [], featureDir: ${JSON.stringify(outsideDir)} } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/external',
        payload: { confirmName: 'external' },
      })
      expect(r.statusCode).toBe(400)
      expect(fs.existsSync(outsideDir)).toBe(true)
    } finally {
      await app.close()
    }
  })
})

describe('config file not found on disk (declared featureDir mismatch)', () => {
  // findExistingConfig looks under the feature's *declared* featureDir (a field
  // inside feature.config.cjs), not the folder loadFeatures scanned it from.
  // Pointing featureDir elsewhere — with no config file there — deterministically
  // reaches the "config file not found" 404 without deleting anything mid-request.
  it('GET config-doc 404s when the declared featureDir has no config file', async () => {
    const bogusDir = path.join(tmpDir, 'ghost-config-doc')
    buildFeature('nocfg-get', {
      config: `module.exports = { config: { name: 'nocfg-get', description: 'd', envs: [], repos: [], featureDir: ${JSON.stringify(bogusDir)} } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/nocfg-get/config-doc' })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('config file not found')
    } finally {
      await app.close()
    }
  })

  it('PUT config-doc 404s when the declared featureDir has no config file', async () => {
    const bogusDir = path.join(tmpDir, 'ghost-config-doc-put')
    buildFeature('nocfg-put', {
      config: `module.exports = { config: { name: 'nocfg-put', description: 'd', envs: [], repos: [], featureDir: ${JSON.stringify(bogusDir)} } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/nocfg-put/config-doc',
        payload: { value: { name: 'nocfg-put' } },
      })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('config file not found')
    } finally {
      await app.close()
    }
  })

  it('POST envsets creates the env dir but skips config sync when featureDir has no config file', async () => {
    const bogusDir = path.join(tmpDir, 'ghost-envset-sync')
    buildFeature('nocfg-env', {
      config: `module.exports = { config: { name: 'nocfg-env', description: 'd', envs: [], repos: [], featureDir: ${JSON.stringify(bogusDir)} } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/nocfg-env/envsets',
        payload: { env: 'local' },
      })
      expect(r.statusCode).toBe(201)
      // Env folder created under the (bogus) declared featureDir...
      expect(fs.existsSync(path.join(bogusDir, 'envsets', 'local', 'feature.env'))).toBe(true)
      // ...but syncEnvsInConfig finds no config file there and returns early
      // (no throw, nothing written) — the request still succeeds.
    } finally {
      await app.close()
    }
  })
})
