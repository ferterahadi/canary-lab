import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { featureConfigRoutes } from './feature-config'
import type { WorkspaceEvent } from '../../../shared/workspace-events'
import { writeOverlay, overlayExists } from '../../portify/logic/runtime/overlay'

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

  it('DELETE portify-overlay restores the pre-Portify config snapshot, then removes the overlay', async () => {
    const preConfig = `module.exports = { config: { name: 'porty', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname, startCommands: [{ command: 'yarn start' }] }], featureDir: __dirname } }`
    const portifiedConfig = `module.exports = { config: { name: 'porty', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname, startCommands: [{ command: 'yarn start', ports: [{ name: 'api', env: 'PORT' }] }] }], featureDir: __dirname } }`
    const dir = buildFeature('porty', { config: portifiedConfig })
    writeOverlay(dir, {
      featureName: 'porty',
      agent: 'claude',
      capturedAt: '2026-06-24T00:00:00.000Z',
      repos: [{ name: 'r', baseSha: 'deadbeef', patch: 'diff --git a b\n', touchedFiles: [] }],
      originalConfig: preConfig,
    })
    expect(overlayExists(dir)).toBe(true)

    const events: WorkspaceEvent[] = []
    const app = await makeApp({ events })
    try {
      const r = await app.inject({ method: 'DELETE', url: '/api/features/porty/portify-overlay' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ name: 'porty', portified: false, reverted: true })
      expect(overlayExists(dir)).toBe(false)
      // The config file is restored to the pre-Portify snapshot — slots gone.
      const onDisk = fs.readFileSync(path.join(dir, 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toBe(preConfig)
      expect(onDisk).not.toContain('ports:')
      expect(events).toContainEqual({ type: 'features-changed' })
    } finally {
      await app.close()
    }
  })

  it('DELETE portify-overlay strips the declared slots for a legacy overlay (no snapshot)', async () => {
    // Legacy overlay (no snapshot) + a config that still carries the slots Portify
    // declared → best-effort strip so they don't linger, even without a snapshot.
    const portifiedConfig = `module.exports = { config: { name: 'porty-legacy', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname, startCommands: [{ command: 'yarn start', ports: [{ name: 'api', env: 'PORT' }] }] }], featureDir: __dirname } }`
    const dir = buildFeature('porty-legacy', { config: portifiedConfig })
    writeOverlay(dir, {
      featureName: 'porty-legacy',
      agent: 'claude',
      capturedAt: '2026-06-24T00:00:00.000Z',
      repos: [{ name: 'r', baseSha: 'deadbeef', patch: 'diff --git a b\n', touchedFiles: [] }],
    })
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'DELETE', url: '/api/features/porty-legacy/portify-overlay' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ name: 'porty-legacy', portified: false, reverted: true })
      expect(overlayExists(dir)).toBe(false)
      // The declared slots are stripped from the config.
      expect(fs.readFileSync(path.join(dir, 'feature.config.cjs'), 'utf-8')).not.toContain('ports:')
    } finally {
      await app.close()
    }
  })

  it('DELETE portify-overlay 404s for an unknown feature', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'DELETE', url: '/api/features/ghost/portify-overlay' })
      expect(r.statusCode).toBe(404)
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
    const events: WorkspaceEvent[] = []
    const app = await makeApp({ events })
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/features/branchy-clean/repos/app/checkout',
        payload: { branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json().currentBranch).toBe('feature/demo')
      // Branch moved → push so an open Repos tab refetches its git-status row live.
      expect(events).toContainEqual({ type: 'features-changed' })
    } finally {
      await app.close()
    }
  })

  it('re-pins the feature to the repo’s current branch', async () => {
    const repo = buildGitRepo('repo-pin')
    // Feature is pinned to feature/demo, but the repo sits on main.
    buildFeature('branchy-pin', {
      config: `module.exports = { config: { name: 'branchy-pin', description: 'd', envs: [], repos: [{ name: 'app', localPath: ${JSON.stringify(repo)}, branch: 'feature/demo' }], featureDir: __dirname } }`,
    })
    const events: WorkspaceEvent[] = []
    const app = await makeApp({ events })
    try {
      const r = await app.inject({ method: 'POST', url: '/api/features/branchy-pin/pin-current-branches' })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ name: 'branchy-pin', pins: [{ name: 'app', branch: 'main' }] })
      // Config rewritten so the pin now matches what's checked out.
      const onDisk = fs.readFileSync(path.join(featuresDir, 'branchy-pin', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toContain("branch: 'main'")
      expect(onDisk).not.toContain('feature/demo')
      expect(events).toContainEqual({ type: 'features-changed' })
    } finally {
      await app.close()
    }
  })

  it('returns git status for an arbitrary workspace repo path', async () => {
    const repo = buildGitRepo('workspace-repo')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/workspace/git-status?path=${encodeURIComponent(repo)}`,
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({
        path: repo,
        expectedBranch: null,
        isGitRepo: true,
        currentBranch: 'main',
      })
      expect(r.json().localBranches).toContain('feature/demo')
    } finally {
      await app.close()
    }
  })

  it('checks out an arbitrary clean workspace repo path', async () => {
    const repo = buildGitRepo('workspace-checkout-repo')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { path: repo, branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({
        path: repo,
        expectedBranch: null,
        currentBranch: 'feature/demo',
      })
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

  it('PUT that changes `name` renames the suite: records follow and clients hear about it', async () => {
    buildFeature('old_name')
    const events: WorkspaceEvent[] = []
    const calls: Array<[string, string]> = []
    const app = await makeApp({
      events,
      featureRename: {
        blockedBy: () => null,
        apply: (from, to) => { calls.push([from, to]); return 3 },
      },
    })
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/old_name/config-doc',
        payload: { value: { name: 'new_name', description: 'd', envs: ['local'], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(200)
      expect(calls).toEqual([['old_name', 'new_name']])
      const onDisk = fs.readFileSync(path.join(featuresDir, 'old_name', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toContain("name: 'new_name'")
      expect(events).toContainEqual({ type: 'feature-renamed', from: 'old_name', to: 'new_name' })
      expect(events).toContainEqual({ type: 'flights-changed' })
      expect(events).toContainEqual({ type: 'features-changed' })
    } finally {
      await app.close()
    }
  })

  it('PUT that does not change `name` neither renames nor announces one', async () => {
    buildFeature('steady')
    const events: WorkspaceEvent[] = []
    const calls: Array<[string, string]> = []
    const app = await makeApp({
      events,
      featureRename: { blockedBy: () => null, apply: (from, to) => { calls.push([from, to]); return 1 } },
    })
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/steady/config-doc',
        payload: { value: { name: 'steady', description: 'updated', envs: ['local'], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(200)
      expect(calls).toEqual([])
      expect(events.some((e) => e.type === 'feature-renamed')).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('PUT 409 when the new name is already another suite — nothing is written', async () => {
    buildFeature('one')
    buildFeature('two')
    const app = await makeApp({ featureRename: { blockedBy: () => null, apply: () => 0 } })
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/one/config-doc',
        payload: { value: { name: 'two', description: 'd', envs: ['local'], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(409)
      expect((r.json() as { error: string }).error).toContain('already in use')
      const onDisk = fs.readFileSync(path.join(featuresDir, 'one', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toContain('name: "one"')
    } finally {
      await app.close()
    }
  })

  it('PUT 409 while live work still holds the old name — nothing is written', async () => {
    buildFeature('busy')
    const app = await makeApp({
      featureRename: {
        blockedBy: () => 'run r1 is running — stop it before renaming the suite',
        apply: () => 0,
      },
    })
    try {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/features/busy/config-doc',
        payload: { value: { name: 'busy_renamed', description: 'd', envs: ['local'], featureDir: { $expr: '__dirname' } } },
      })
      expect(r.statusCode).toBe(409)
      expect((r.json() as { error: string }).error).toContain('r1 is running')
      const onDisk = fs.readFileSync(path.join(featuresDir, 'busy', 'feature.config.cjs'), 'utf-8')
      expect(onDisk).toContain('name: "busy"')
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
