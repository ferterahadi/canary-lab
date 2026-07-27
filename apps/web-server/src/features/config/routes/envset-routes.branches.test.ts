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

describe('envsets create — additional branches', () => {
  it('400 when env name resolves outside the envsets dir', async () => {
    buildFeature('env-traverse')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/env-traverse/envsets',
        payload: { env: '..' },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('invalid env name')
    } finally {
      await app.close()
    }
  })

  it('400 when no request body is sent', async () => {
    buildFeature('env-nobody')
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/env-nobody/envsets' })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('skips non-file entries when seeding a new env from an existing one', async () => {
    const dir = buildFeature('env-seed-skip-dir', {
      envsets: { local: { 'feature.env': 'A=1\n' } },
    })
    // A subdirectory inside the source env — must be skipped, only files copied.
    fs.mkdirSync(path.join(dir, 'envsets', 'local', 'a-subdir'), { recursive: true })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/env-seed-skip-dir/envsets',
        payload: { env: 'staging' },
      })
      expect(r.statusCode).toBe(201)
      const stagingDir = path.join(featuresDir, 'env-seed-skip-dir', 'envsets', 'staging')
      expect(fs.existsSync(path.join(stagingDir, 'feature.env'))).toBe(true)
      expect(fs.existsSync(path.join(stagingDir, 'a-subdir'))).toBe(false)
    } finally {
      await app.close()
    }
  })
})

describe('envsets GET — slot entries branch coverage', () => {
  it('skips non-object slot entries and object slots missing description/target', async () => {
    buildFeature('slots-weird', {
      envsets: { local: { 'app.env': 'A=1' } },
      envsetsConfig: JSON.stringify({ slots: { 'app.env': {}, 'other.env': 'not-an-object' } }),
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/slots-weird/envsets' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { slotDescriptions: Record<string, string>; slotTargets: Record<string, string> }
      expect(body.slotDescriptions).toEqual({})
      expect(body.slotTargets).toEqual({})
    } finally {
      await app.close()
    }
  })
})
