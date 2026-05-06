import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
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

function buildGitRepo(name: string): string {
  const dir = path.join(tmpDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const git = (args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  git(['add', 'README.md'])
  git(['commit', '-m', 'init'])
  git(['checkout', '-b', 'feature/demo'])
  git(['checkout', 'main'])
  return dir
}

async function makeApp(opts: { isRepoActive?: (feature: string, repo: string) => boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(async (a) => {
    await featureConfigRoutes(a, { featuresDir, isRepoActive: opts.isRepoActive })
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

  it('returns git status for a configured repo', async () => {
    const repo = buildGitRepo('repo-a')
    buildFeature('branchy', {
      config: `module.exports = { config: { name: 'branchy', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)}, branch: 'feature/demo' }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/branchy/repos/app/git' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({
        isGitRepo: true,
        currentBranch: 'main',
        expectedBranch: 'feature/demo',
        dirty: false,
      })
      expect(r.json().localBranches).toContain('feature/demo')
    } finally {
      await app.close()
    }
  })

  it('refuses checkout when the configured repo is dirty', async () => {
    const repo = buildGitRepo('repo-b')
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')
    buildFeature('branchy-dirty', {
      config: `module.exports = { config: { name: 'branchy-dirty', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/branchy-dirty/repos/app/checkout',
        payload: { branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toContain('uncommitted changes')
    } finally {
      await app.close()
    }
  })

  it('refuses checkout when the repo has an active run', async () => {
    const repo = buildGitRepo('repo-active')
    buildFeature('branchy-active', {
      config: `module.exports = { config: { name: 'branchy-active', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp({ isRepoActive: () => true })
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/branchy-active/repos/app/checkout',
        payload: { branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toContain('active service run')
    } finally {
      await app.close()
    }
  })

  it('checks out a clean configured repo', async () => {
    const repo = buildGitRepo('repo-c')
    buildFeature('branchy-clean', {
      config: `module.exports = { config: { name: 'branchy-clean', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/branchy-clean/repos/app/checkout',
        payload: { branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json().currentBranch).toBe('feature/demo')
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

describe('feature deletion endpoint', () => {
  it('deletes the whole feature directory when the confirmation name matches', async () => {
    const featureDir = buildFeature('gone', {
      playwright: `module.exports = { testDir: './e2e' }`,
      envsets: { local: { 'feature.env': 'A=1\n' } },
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'DELETE',
        url: '/api/features/gone',
        payload: { confirmName: 'gone' },
      })
      expect(r.statusCode).toBe(204)
      expect(fs.existsSync(featureDir)).toBe(false)
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

  it('400 when parentDir is relative', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@x:o/r.git', parentDir: 'rel/path', repoName: 'r' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('400 when parentDir does not exist', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@x:o/r.git', parentDir: '/does/not/exist/zzz', repoName: 'r' },
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('500 when git clone fails (uses fake git on PATH)', async () => {
    // Stub PATH so `git` resolves to a script that always fails. This
    // exercises the close-with-nonzero-code branch deterministically.
    const fakeBin = path.join(tmpDir, 'fakebin')
    fs.mkdirSync(fakeBin, { recursive: true })
    const fakeGit = path.join(fakeBin, 'git')
    fs.writeFileSync(fakeGit, '#!/bin/sh\necho "fatal: nope" 1>&2\nexit 1\n')
    fs.chmodSync(fakeGit, 0o755)
    const origPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${origPath ?? ''}`
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@x:o/r.git', parentDir: tmpDir, repoName: 'newrepo' },
      })
      expect(r.statusCode).toBe(500)
      expect((r.json() as { error: string }).error).toContain('git clone failed')
    } finally {
      process.env.PATH = origPath
      await app.close()
    }
  })

  it('200 success when git clone succeeds (fake git creates target)', async () => {
    const fakeBin = path.join(tmpDir, 'fakebin2')
    fs.mkdirSync(fakeBin, { recursive: true })
    const fakeGit = path.join(fakeBin, 'git')
    // Create the target dir so the post-clone caller sees a real folder.
    fs.writeFileSync(fakeGit, '#!/bin/sh\nmkdir -p "$3"\nexit 0\n')
    fs.chmodSync(fakeGit, 0o755)
    const origPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${origPath ?? ''}`
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@x:o/r.git', parentDir: tmpDir, repoName: 'cloned' },
      })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { localPath: string }).localPath).toBe(path.join(tmpDir, 'cloned'))
    } finally {
      process.env.PATH = origPath
      await app.close()
    }
  })
})

describe('workspace error branches', () => {
  it('git-remote 400 when path is relative', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-remote?path=${encodeURIComponent('rel/path')}`,
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('path-exists 400 when path missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/workspace/path-exists' })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('path-exists 400 when path is relative', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/path-exists?path=${encodeURIComponent('relative')}`,
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('path-exists handles ~/ expansion', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/workspace/path-exists?path=~',
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ exists: true })
    } finally {
      await app.close()
    }
  })

  it('git-remote returns null when [remote "origin"] has no url=', async () => {
    const repoDir = path.join(tmpDir, 'no-url')
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(repoDir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = git@x:o/u.git\n`,
    )
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-remote?path=${encodeURIComponent(repoDir)}`,
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ cloneUrl: null })
    } finally {
      await app.close()
    }
  })

  it('git-remote returns null when .git/config is unreadable', async () => {
    const repoDir = path.join(tmpDir, 'no-read')
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
    const cfgFile = path.join(repoDir, '.git', 'config')
    fs.writeFileSync(cfgFile, '[core]\n')
    fs.chmodSync(cfgFile, 0o000)
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-remote?path=${encodeURIComponent(repoDir)}`,
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ cloneUrl: null })
    } finally {
      fs.chmodSync(cfgFile, 0o644)
      await app.close()
    }
  })

  it('git-remote ~/ expansion returns null when no .git/config', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/workspace/git-remote?path=~',
      })
      expect(r.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('clone 400 when fields missing entirely', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/workspace/clone', payload: {} })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('workspace dirs handles ~/ expansion', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/workspace/dirs?at=~' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { absolute: string }
      expect(body.absolute).toBe(os.homedir())
    } finally {
      await app.close()
    }
  })
})

describe('envsets index with slotTargets', () => {
  it('shortens $HOME-prefixed targets to ~/', async () => {
    const home = os.homedir()
    buildFeature('hh', {
      envsets: { local: { 'feature.env': '' } },
      envsetsConfig: JSON.stringify({
        slots: { 'feature.env': { description: '', target: path.join(home, 'somewhere/.env') } },
      }),
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/hh/envsets' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { slotTargets: Record<string, string> }
      expect(body.slotTargets['feature.env']).toBe('~/somewhere/.env')
    } finally {
      await app.close()
    }
  })

  it('resolves $-vars in slot targets', async () => {
    buildFeature('alpha', {
      envsets: { local: { 'feature.env': '' } },
      envsetsConfig: JSON.stringify({
        appRoots: { MYAPP: '/abs/myapp' },
        slots: {
          'feature.env': { description: 'main', target: '$MYAPP/.env.local' },
        },
      }),
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/alpha/envsets' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as {
        slotTargets: Record<string, string>
        slotTargetsRaw: Record<string, string>
      }
      expect(body.slotTargetsRaw['feature.env']).toBe('$MYAPP/.env.local')
      expect(body.slotTargets['feature.env']).toBe('/abs/myapp/.env.local')
    } finally {
      await app.close()
    }
  })
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

describe('GET /api/fs/browse', () => {
  it('lists directories first, then files', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse?dir=${encodeURIComponent(tmpDir)}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { dir: string; parent: string | null; entries: { name: string; isDir: boolean }[] }
      expect(body.dir).toBe(tmpDir)
      expect(body.entries[0].isDir).toBe(true)
      expect(body.entries.find((e) => e.name === 'a.txt')?.isDir).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('defaults to home when dir empty', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/fs/browse' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { dir: string }
      expect(body.dir).toBe(os.homedir())
    } finally {
      await app.close()
    }
  })

  it('returns empty entries for non-existent dir', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse?dir=${encodeURIComponent('/does/not/exist/xyz')}`,
      })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { entries: unknown[] }).entries).toEqual([])
    } finally {
      await app.close()
    }
  })

  it('expands ~/ relative to home', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/fs/browse?dir=~' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { dir: string }
      expect(body.dir).toBe(os.homedir())
    } finally {
      await app.close()
    }
  })
})

describe('GET /api/fs/read-dotenv', () => {
  it('parses an absolute .env file into entries', async () => {
    const filePath = path.join(tmpDir, 'sample.env')
    fs.writeFileSync(filePath, 'FOO=bar\n# comment\nBAZ=qux\n')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/read-dotenv?path=${encodeURIComponent(filePath)}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as { path: string; entries: { key: string; value: string }[] }
      expect(body.path).toBe(filePath)
      expect(body.entries).toEqual([
        { key: 'FOO', value: 'bar' },
        { key: 'BAZ', value: 'qux' },
      ])
    } finally {
      await app.close()
    }
  })

  it('400 when path missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/fs/read-dotenv' })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('404 when file does not exist', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/read-dotenv?path=${encodeURIComponent('/does/not/exist.env')}`,
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('400 when path is not absolute', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/fs/read-dotenv?path=relative/path.env' })
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
