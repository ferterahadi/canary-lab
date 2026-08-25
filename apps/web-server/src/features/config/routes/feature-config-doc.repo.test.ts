import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { featureConfigRoutes } from './feature-config'
import * as gitRepo from '../../../shared/git-repo'
import * as configAst from '../../../shared/config-ast'
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

describe('pin-current-branches error branches', () => {
  it('404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/missing/pin-current-branches' })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('feature not found')
    } finally {
      await app.close()
    }
  })

  it('404 when the declared featureDir has no config file', async () => {
    const bogusDir = path.join(tmpDir, 'ghost-pin')
    buildFeature('nocfg-pin', {
      config: `module.exports = { config: { name: 'nocfg-pin', description: 'd', envs: [], repos: [], featureDir: ${JSON.stringify(bogusDir)} } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/nocfg-pin/pin-current-branches' })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('config file not found')
    } finally {
      await app.close()
    }
  })

  it('409 when a configured repo is not a git repository', async () => {
    const notGit = path.join(tmpDir, 'not-a-repo')
    fs.mkdirSync(notGit, { recursive: true })
    buildFeature('pin-notgit', {
      config: `module.exports = { config: { name: 'pin-notgit', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(notGit)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/pin-notgit/pin-current-branches' })
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toContain('no branch to pin')
    } finally {
      await app.close()
    }
  })

  it('400 when the config has no editable repos array', async () => {
    buildFeature('pin-norepos', {
      config: `module.exports = { config: { name: 'pin-norepos', description: 'd', envs: [], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/pin-norepos/pin-current-branches' })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('config has no editable repos array')
    } finally {
      await app.close()
    }
  })

  it('skips repos with no localPath to pin, and raw config entries with no matching pin', async () => {
    const repo = buildGitRepo('pin-mixed-repo')
    buildFeature('pin-mixed', {
      config: `module.exports = { config: { name: 'pin-mixed', description: 'd', envs: [], repos: [{ name: 'good', localPath: ${JSON.stringify(repo)} }, { name: 'nopath' }, 'junk-entry'], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/pin-mixed/pin-current-branches' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ name: 'pin-mixed', pins: [{ name: 'good', branch: 'main' }] })
      const onDisk = fs.readFileSync(path.join(featuresDir, 'pin-mixed', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toContain("branch: 'main'")
    } finally {
      await app.close()
    }
  })

  it('400 when writeFeatureConfig throws while re-pinning', async () => {
    const repo = buildGitRepo('pin-writefail-repo')
    buildFeature('pin-writefail', {
      config: `module.exports = { config: { name: 'pin-writefail', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    // The parsed config is always a plain object here, so writeFeatureConfig
    // can't fail on its own — force it to throw (e.g. a recast/print failure on
    // an exotic source) to exercise the 400 catch arm.
    const spy = vi.spyOn(configAst, 'writeFeatureConfig').mockImplementation(() => {
      throw new Error('recast exploded')
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/pin-writefail/pin-current-branches' })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('recast exploded')
      // The config file is left untouched (write never landed).
      const onDisk = fs.readFileSync(path.join(featuresDir, 'pin-writefail', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).not.toContain("branch: 'main'")
    } finally {
      spy.mockRestore()
      await app.close()
    }
  })
})

describe('repo checkout endpoint error branches', () => {
  it('404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/missing/repos/app/checkout',
        payload: { branch: 'main' },
      })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('feature not found')
    } finally {
      await app.close()
    }
  })

  it('404 for unknown repo', async () => {
    buildFeature('checkout-norepo', {
      config: `module.exports = { config: { name: 'checkout-norepo', description: 'd', envs: [], repos: [], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/checkout-norepo/repos/missing/checkout',
        payload: { branch: 'main' },
      })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('repo not found')
    } finally {
      await app.close()
    }
  })

  it('400 when branch is missing from the request body', async () => {
    const repo = buildGitRepo('checkout-nobranch-repo')
    buildFeature('checkout-nobranch', {
      config: `module.exports = { config: { name: 'checkout-nobranch', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/checkout-nobranch/repos/app/checkout',
        payload: {},
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('branch required')
    } finally {
      await app.close()
    }
  })

  it('400 when branch is whitespace only', async () => {
    const repo = buildGitRepo('checkout-wsbranch-repo')
    buildFeature('checkout-wsbranch', {
      config: `module.exports = { config: { name: 'checkout-wsbranch', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/checkout-wsbranch/repos/app/checkout',
        payload: { branch: '   ' },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('branch required')
    } finally {
      await app.close()
    }
  })

  it('500s (default status) when the repo has no localPath to resolve', async () => {
    buildFeature('checkout-nolocalpath', {
      config: `module.exports = { config: { name: 'checkout-nolocalpath', description: 'd', envs: [], repos: [{ name: 'app' }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/checkout-nolocalpath/repos/app/checkout',
        payload: { branch: 'main' },
      })
      // checkoutBranch throws a plain TypeError (no .statusCode) when localPath
      // is undefined — exercises the ternary's `: 500` default branch.
      expect(r.statusCode).toBe(500)
    } finally {
      await app.close()
    }
  })

  it('500 with String(err) when checkoutBranch rejects a non-Error value', async () => {
    const repo = buildGitRepo('checkout-nonerror-repo')
    buildFeature('checkout-nonerror', {
      config: `module.exports = { config: { name: 'checkout-nonerror', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    // A rejected non-Error (a bare string) drives the `String(err)` arm of the
    // catch's `err instanceof Error ? err.message : String(err)`.
    const spy = vi.spyOn(gitRepo, 'checkoutBranch').mockRejectedValue('plain string failure')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/checkout-nonerror/repos/app/checkout',
        payload: { branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(500)
      expect(r.json().error).toBe('plain string failure')
    } finally {
      spy.mockRestore()
      await app.close()
    }
  })
})

describe('repo git-status endpoint error + branch-less branches', () => {
  it('404 for unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/missing/repos/app/git' })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('feature not found')
    } finally {
      await app.close()
    }
  })

  it('404 for unknown repo', async () => {
    buildFeature('git-norepo', {
      config: `module.exports = { config: { name: 'git-norepo', description: 'd', envs: [], repos: [], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/git-norepo/repos/missing/git' })
      expect(r.statusCode).toBe(404)
      expect(r.json().error).toBe('repo not found')
    } finally {
      await app.close()
    }
  })

  it('expectedBranch is null when the repo has no configured branch', async () => {
    const repo = buildGitRepo('git-nobranch-repo')
    buildFeature('git-nobranch', {
      config: `module.exports = { config: { name: 'git-nobranch', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)} }], featureDir: __dirname } }`,
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/features/git-nobranch/repos/app/git' })
      expect(r.statusCode).toBe(200)
      expect(r.json().expectedBranch).toBeNull()
    } finally {
      await app.close()
    }
  })
})
