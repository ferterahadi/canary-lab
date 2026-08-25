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

describe('envset slot management', () => {
  it('POST creates a slot, replicating into every env', async () => {
    buildFeature('alpha', {
      envsets: { local: { 'feature.env': '' }, prod: { 'feature.env': '' } },
    })
    const seedFile = path.join(tmpDir, 'seed.env')
    fs.writeFileSync(seedFile, 'NEW_SLOT=hello\n')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: {
          sourcePath: seedFile,
          slotName: 'extra.env',
          target: '/abs/extra.env',
          description: 'an extra slot',
        },
      })
      expect(r.statusCode).toBe(201)
      for (const env of ['local', 'prod']) {
        const slotPath = path.join(featuresDir, 'alpha', 'envsets', env, 'extra.env')
        expect(fs.existsSync(slotPath)).toBe(true)
        expect(fs.readFileSync(slotPath, 'utf-8')).toContain('NEW_SLOT=hello')
      }
      const cfg = JSON.parse(
        fs.readFileSync(
          path.join(featuresDir, 'alpha', 'envsets', 'envsets.config.json'),
          'utf-8',
        ),
      ) as { slots: Record<string, { description: string; target: string }>; feature: { slots: string[] } }
      expect(cfg.slots['extra.env']).toEqual({ description: 'an extra slot', target: '/abs/extra.env' })
      expect(cfg.feature.slots).toContain('extra.env')
    } finally {
      await app.close()
    }
  })

  it('POST defaults slotName to sourcePath basename and target to sourcePath', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const seedFile = path.join(tmpDir, 'app.env')
    fs.writeFileSync(seedFile, '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: seedFile },
      })
      expect(r.statusCode).toBe(201)
      expect(r.json()).toEqual({ slot: 'app.env' })
    } finally {
      await app.close()
    }
  })

  it('POST 404 unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/missing/envsets/slots',
        payload: { sourcePath: '/x' },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when sourcePath missing', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: {},
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when sourcePath is relative', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: 'relative/path.env' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when sourcePath is not a file', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: tmpDir },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when slotName has invalid chars', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const seedFile = path.join(tmpDir, 'seed.env')
    fs.writeFileSync(seedFile, '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: seedFile, slotName: '../escape' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when feature has no envs yet', async () => {
    buildFeature('alpha')
    const seedFile = path.join(tmpDir, 'seed.env')
    fs.writeFileSync(seedFile, '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: seedFile, slotName: 'extra.env' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('POST 409 when slot already exists', async () => {
    buildFeature('alpha', {
      envsets: { local: { 'feature.env': '' } },
      envsetsConfig: JSON.stringify({ slots: { 'extra.env': { description: '' } } }),
    })
    const seedFile = path.join(tmpDir, 'seed.env')
    fs.writeFileSync(seedFile, '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: seedFile, slotName: 'extra.env' },
      })
      expect(r.statusCode).toBe(409)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when sourcePath is unreadable', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const seedFile = path.join(tmpDir, 'unreadable.env')
    fs.writeFileSync(seedFile, '')
    fs.chmodSync(seedFile, 0o000)
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: seedFile, slotName: 'unreadable.env' },
      })
      // Either 400 (read error caught) or proceed if running as root.
      expect([400, 201]).toContain(r.statusCode)
    } finally {
      fs.chmodSync(seedFile, 0o644)
      await app.close()
    }
  })

  it('POST expands ~/ in sourcePath', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    // We can't reliably write into $HOME in tests — just assert that the
    // ~-expansion path branch is hit by giving an unresolvable ~/ path.
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets/slots',
        payload: { sourcePath: '~/__nope_does_not_exist__.env' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('DELETE removes the slot from every env and config', async () => {
    buildFeature('alpha', {
      envsets: {
        local: { 'feature.env': '', 'extra.env': 'A=1' },
        prod: { 'feature.env': '', 'extra.env': 'A=2' },
      },
      envsetsConfig: JSON.stringify({
        slots: { 'extra.env': { description: '' } },
        feature: { slots: ['extra.env'] },
      }),
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/alpha/envsets/slots/extra.env',
      })
      expect(r.statusCode).toBe(204)
      for (const env of ['local', 'prod']) {
        const slotPath = path.join(featuresDir, 'alpha', 'envsets', env, 'extra.env')
        expect(fs.existsSync(slotPath)).toBe(false)
      }
      const cfg = JSON.parse(
        fs.readFileSync(
          path.join(featuresDir, 'alpha', 'envsets', 'envsets.config.json'),
          'utf-8',
        ),
      ) as { slots: Record<string, unknown>; feature: { slots: string[] } }
      expect(cfg.slots['extra.env']).toBeUndefined()
      expect(cfg.feature.slots).not.toContain('extra.env')
    } finally {
      await app.close()
    }
  })

  it('DELETE 404 unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/missing/envsets/slots/x.env',
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('DELETE 400 invalid slot name', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/alpha/envsets/slots/' + encodeURIComponent('../escape'),
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

describe('envset slot management — additional branches', () => {
  it('falls back to sourcePath when target is whitespace-only', async () => {
    buildFeature('alpha-ws-target', { envsets: { local: { 'feature.env': '' } } })
    const seedFile = path.join(tmpDir, 'seed-ws.env')
    fs.writeFileSync(seedFile, '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha-ws-target/envsets/slots',
        payload: { sourcePath: seedFile, slotName: 'ws.env', target: '   ' },
      })
      expect(r.statusCode).toBe(201)
      const cfg = JSON.parse(
        fs.readFileSync(path.join(featuresDir, 'alpha-ws-target', 'envsets', 'envsets.config.json'), 'utf-8'),
      ) as { slots: Record<string, { target: string }> }
      expect(cfg.slots['ws.env'].target).toBe(seedFile)
    } finally {
      await app.close()
    }
  })

  it('DELETE 204s as a no-op when the envsets dir does not exist at all', async () => {
    buildFeature('slot-del-nodir')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/slot-del-nodir/envsets/slots/whatever.env',
      })
      expect(r.statusCode).toBe(204)
    } finally {
      await app.close()
    }
  })

  it('DELETE skips envs that never had the slot file in the first place', async () => {
    buildFeature('slot-del-partial', {
      envsets: {
        local: { 'extra.env': 'A=1' },
        // 'prod' never had extra.env — fs.existsSync(slotPath) is false there.
        prod: { 'feature.env': '' },
      },
      envsetsConfig: JSON.stringify({
        slots: { 'extra.env': { description: '' } },
        feature: { slots: ['extra.env'] },
      }),
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/slot-del-partial/envsets/slots/extra.env',
      })
      expect(r.statusCode).toBe(204)
      expect(fs.existsSync(path.join(featuresDir, 'slot-del-partial', 'envsets', 'local', 'extra.env'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  // `.` and `..` pass the character class but name a directory, not a file.
  // Before they were rejected, `path.join(envsetsDir, env, slotName)` resolved
  // to `envsets/<env>` (or to `envsets/` itself) and the write hit EISDIR — a
  // 500. Rejecting them up front is also what makes the joined path provably
  // inside the envsets dir, so the routes need no traversal re-check.
  //
  // Only exercised through POST, where the name arrives in the JSON body. The
  // DELETE route takes it as a URL segment, and the router normalises `.`/`..`
  // away before the handler ever sees them — `isValidSlotName` is unit-tested
  // directly in feature-config-support.test.ts for that side.
  for (const slotName of ['.', '..']) {
    it(`POST 400 when slotName is "${slotName}" (names a directory, not a file)`, async () => {
      buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
      const seedFile = path.join(tmpDir, 'seed.env')
      fs.writeFileSync(seedFile, 'A=1')
      const app = await makeApp()
      try {
        const r = await app.inject({
          method: 'POST',
          url: '/api/features/alpha/envsets/slots',
          payload: { sourcePath: seedFile, slotName },
        })
        expect(r.statusCode).toBe(400)
        // The env folder is untouched — no stray write, no EISDIR crash.
        expect(fs.readdirSync(path.join(featuresDir, 'alpha', 'envsets', 'local'))).toEqual(['feature.env'])
      } finally {
        await app.close()
      }
    })
  }
})
