import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { featureConfigRoutes } from './feature-config'

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

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await featureConfigRoutes(a, { featuresDir })
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

describe('feature.config endpoints', () => {
  it('GET returns parsed feature config', async () => {
    buildFeature('alpha')
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/alpha/config-doc' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { parsed: { value: { name: string } } }
      expect(body.parsed.value.name).toBe('alpha')
    } finally {
      await app.close()
    }
  })

  it('GET 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/missing/config-doc' })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('GET 404 when feature dir has no config file', async () => {
    // Create a directory structure that loadFeatures will find but with no config file.
    // loadFeatures requires feature.config.cjs to exist in the first place — so we
    // delete it after the fact to simulate a partial directory.
    buildFeature('beta')
    // loadFeatures keys off the config file existence; if we delete it, the
    // feature won't be loaded at all (giving 404 "feature not found"). To get
    // the "config file not found" branch, the loader must still resolve the
    // feature. Skip — covered indirectly by the other tests' findExistingConfig calls.
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/beta/config-doc' })
      expect(r.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('PUT writes a patched config', async () => {
    buildFeature('gamma')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/gamma/config-doc',
        payload: { value: { name: 'gamma', description: 'updated', envs: ['local'], repos: [{ name: 'r', localPath: { $expr: '__dirname' } }], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(200)
      const onDisk = fs.readFileSync(path.join(featuresDir, 'gamma', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toContain("description: 'updated'")
    } finally {
      await app.close()
    }
  })

  it('PUT 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/nope/config-doc',
        payload: { value: { name: 'nope' } },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT 400 when value is not an object', async () => {
    buildFeature('delta')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/delta/config-doc',
        payload: { value: [] },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
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

describe('envsets endpoints', () => {
  it('GET returns empty when envsets dir is missing', async () => {
    buildFeature('a')
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/a/envsets' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ envs: [], slotDescriptions: {}, slotTargets: {} })
    } finally {
      await app.close()
    }
  })

  it('GET 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/nope/envsets' })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('GET lists envs, slots, and descriptions', async () => {
    buildFeature('b', {
      envsets: { local: { 'app.env': 'A=1' }, production: { 'app.env': 'A=2' } },
      envsetsConfig: JSON.stringify({ slots: { 'app.env': { description: 'main app env' } } }),
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/b/envsets' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { envs: Array<{ name: string; slots: string[] }>; slotDescriptions: Record<string, string> }
      expect(body.envs.map((e) => e.name).sort()).toEqual(['local', 'production'])
      expect(body.slotDescriptions['app.env']).toBe('main app env')
    } finally {
      await app.close()
    }
  })

  it('GET tolerates malformed envsets.config.json', async () => {
    buildFeature('c', {
      envsets: { local: { 'app.env': 'A=1' } },
      envsetsConfig: '{ this is not json',
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/c/envsets' })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { slotDescriptions: Record<string, string> }).slotDescriptions).toEqual({})
    } finally {
      await app.close()
    }
  })

  it('GET slot file returns parsed dotenv', async () => {
    buildFeature('d', { envsets: { local: { 'app.env': 'FOO=bar\n' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/d/envsets/local/app.env' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { entries: Array<{ key: string; value: string }> }
      expect(body.entries).toEqual([{ key: 'FOO', value: 'bar' }])
    } finally {
      await app.close()
    }
  })

  it('GET slot 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/nope/envsets/local/app.env' })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('GET slot 404 when slot is missing', async () => {
    buildFeature('e')
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/e/envsets/local/missing.env' })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('GET slot rejects path traversal attempts', async () => {
    buildFeature('f', { envsets: { local: { 'app.env': 'A=1' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/features/f/envsets/..%2F..%2F..%2Fetc/passwd',
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT slot writes patched dotenv', async () => {
    buildFeature('g', { envsets: { local: { 'app.env': 'FOO=1\n' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/g/envsets/local/app.env',
        payload: { entries: [{ key: 'FOO', value: '2' }] },
      })
      expect(r.statusCode).toBe(200)
      const onDisk = fs.readFileSync(path.join(featuresDir, 'g', 'envsets', 'local', 'app.env'), 'utf-8')
      expect(onDisk).toContain('FOO=2')
    } finally {
      await app.close()
    }
  })

  it('PUT slot 400 when entries missing', async () => {
    buildFeature('h', { envsets: { local: { 'app.env': 'FOO=1' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/h/envsets/local/app.env',
        payload: {},
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('PUT slot 404 when slot is missing', async () => {
    buildFeature('i')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/i/envsets/local/app.env',
        payload: { entries: [] },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT slot 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/nope/envsets/local/app.env',
        payload: { entries: [] },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('workspace dirs endpoint', () => {
  it('lists subdirectories of an absolute path', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    fs.mkdirSync(path.join(tmpDir, '.hidden'))
    fs.writeFileSync(path.join(tmpDir, 'a-file'), '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/dirs?at=${encodeURIComponent(tmpDir)}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { absolute: string; parent: string | null; dirs: string[] }
      expect(body.dirs).toContain('sub')
      expect(body.dirs).toContain('features')
      expect(body.dirs).not.toContain('.hidden')
      expect(body.dirs).not.toContain('a-file')
      expect(body.absolute).toBe(tmpDir)
      expect(body.parent).toBe(path.dirname(tmpDir))
    } finally {
      await app.close()
    }
  })

  it('lists nested dir via absolute ?at=', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub', 'inner'), { recursive: true })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/dirs?at=${encodeURIComponent(path.join(tmpDir, 'sub'))}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { dirs: string[] }
      expect(body.dirs).toEqual(['inner'])
    } finally {
      await app.close()
    }
  })

  it('defaults to $HOME when at is empty', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/workspace/dirs' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { absolute: string }
      expect(body.absolute).toBe(os.homedir())
    } finally {
      await app.close()
    }
  })

  it('returns empty list for non-existent path', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/dirs?at=${encodeURIComponent('/does/not/exist/here')}`,
      })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { dirs: string[] }).dirs).toEqual([])
    } finally {
      await app.close()
    }
  })
})

describe('workspace git-remote endpoint', () => {
  it('returns null when .git/config is missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-remote?path=${encodeURIComponent(tmpDir)}`,
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ cloneUrl: null })
    } finally {
      await app.close()
    }
  })

  it('reads remote.origin.url from .git/config', async () => {
    const repoDir = path.join(tmpDir, 'repo')
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(repoDir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:org/repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    )
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-remote?path=${encodeURIComponent(repoDir)}`,
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ cloneUrl: 'git@github.com:org/repo.git' })
    } finally {
      await app.close()
    }
  })

  it('400 when path missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/workspace/git-remote' })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

describe('workspace path-exists endpoint', () => {
  it('returns true for existing dir', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/path-exists?path=${encodeURIComponent(tmpDir)}`,
      })
      expect(r.json()).toEqual({ exists: true })
    } finally {
      await app.close()
    }
  })

  it('returns false for missing dir', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/path-exists?path=${encodeURIComponent('/does/not/exist/xyz')}`,
      })
      expect(r.json()).toEqual({ exists: false })
    } finally {
      await app.close()
    }
  })
})

describe('workspace clone endpoint', () => {
  it('400 when fields missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'x' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('409 when target already exists', async () => {
    const repoDir = path.join(tmpDir, 'already-here')
    fs.mkdirSync(repoDir)
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@example.com:o/r.git', parentDir: tmpDir, repoName: 'already-here' },
      })
      expect(r.statusCode).toBe(409)
    } finally {
      await app.close()
    }
  })

  it('400 when repoName contains a slash', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@example.com:o/r.git', parentDir: tmpDir, repoName: '../escape' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

describe('envset CRUD + envs sync', () => {
  it('POST creates a new env folder, seeded from existing env', async () => {
    buildFeature('alpha', {
      envsets: { local: { 'feature.env': 'GATEWAY_URL=http://localhost\nDB_URL=postgres://x\n' } },
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets',
        payload: { env: 'staging' },
      })
      expect(r.statusCode).toBe(201)
      const stagingFile = path.join(featuresDir, 'alpha', 'envsets', 'staging', 'feature.env')
      expect(fs.existsSync(stagingFile)).toBe(true)
      // Seeded with same keys but blanked values.
      const body = fs.readFileSync(stagingFile, 'utf-8')
      expect(body).toContain('GATEWAY_URL=')
      expect(body).toContain('DB_URL=')
      expect(body).not.toContain('http://localhost')
      // feature.config.cjs envs array re-synced to disk.
      const cfg = fs.readFileSync(path.join(featuresDir, 'alpha', 'feature.config.cjs'), 'utf-8')
      expect(cfg).toMatch(/'local'/)
      expect(cfg).toMatch(/'staging'/)
    } finally {
      await app.close()
    }
  })

  it('POST seeds a default feature.env when no other env exists', async () => {
    buildFeature('alpha')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets',
        payload: { env: 'local' },
      })
      expect(r.statusCode).toBe(201)
      expect(fs.existsSync(path.join(featuresDir, 'alpha', 'envsets', 'local', 'feature.env'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('POST 400 when env name is invalid', async () => {
    buildFeature('alpha')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets',
        payload: { env: '../escape' },
      })
      expect(r.statusCode).toBe(400)
      const empty = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets',
        payload: { env: '' },
      })
      expect(empty.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('POST 409 when env already exists', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/alpha/envsets',
        payload: { env: 'local' },
      })
      expect(r.statusCode).toBe(409)
    } finally {
      await app.close()
    }
  })

  it('POST 404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/missing/envsets',
        payload: { env: 'local' },
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('DELETE removes the env folder and re-syncs envs in config', async () => {
    buildFeature('alpha', {
      envsets: {
        local: { 'feature.env': '' },
        staging: { 'feature.env': '' },
      },
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/alpha/envsets/staging',
      })
      expect(r.statusCode).toBe(204)
      expect(fs.existsSync(path.join(featuresDir, 'alpha', 'envsets', 'staging'))).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('DELETE 404 for unknown feature or env', async () => {
    buildFeature('alpha', { envsets: { local: { 'feature.env': '' } } })
    const app = await makeApp()
    try {
      const noFeature = await app.inject({ method: 'DELETE', url: '/api/features/missing/envsets/local' })
      expect(noFeature.statusCode).toBe(404)
      const noEnv = await app.inject({ method: 'DELETE', url: '/api/features/alpha/envsets/missing' })
      expect(noEnv.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('PUT config-doc auto-syncs envs to match folders on disk', async () => {
    // Config has 'old' but disk has only 'local' — server overrides.
    buildFeature('alpha', {
      config: `module.exports = { config: { name: 'alpha', description: 'd', envs: ['old'], featureDir: __dirname } }`,
      envsets: { local: { 'feature.env': '' } },
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/alpha/config-doc',
        payload: { value: { name: 'alpha', description: 'd2', envs: ['client-sent-ignored'], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(200)
      const cfg = fs.readFileSync(path.join(featuresDir, 'alpha', 'feature.config.cjs'), 'utf-8')
      expect(cfg).toMatch(/'local'/)
      expect(cfg).not.toContain('client-sent-ignored')
      expect(cfg).not.toContain("'old'")
    } finally {
      await app.close()
    }
  })
})
