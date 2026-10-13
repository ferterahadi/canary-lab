import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as gitRepo from '../../../shared/git-repo'

import { git, initGitRepo } from '../../../../../../tools/test-helpers/git-repo'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { buildFeatureConfigApp, type FeatureConfigAppOptions } from './__fixtures__/feature-config-app'

const tempDir = trackTempDirs('cl-fcfg-')

let tmpDir: string

let featuresDir: string

function buildGitRepo(name: string): string {
  const dir = path.join(tmpDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  initGitRepo(dir, { branch: 'main' })
  git(dir, 'branch', 'feature/demo')
  return dir
}

const makeApp = (opts: FeatureConfigAppOptions = {}) => buildFeatureConfigApp(featuresDir, opts)

beforeEach(() => {
  tmpDir = tempDir()
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
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

describe('GET /api/workspace/git-status — error branches', () => {
  it('400 when path missing', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/workspace/git-status' })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('path query required')
    } finally {
      await app.close()
    }
  })

  it('400 when path is relative', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/workspace/git-status?path=relative/path',
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('path must be absolute or start with ~')
    } finally {
      await app.close()
    }
  })
})

describe('POST /api/workspace/checkout — error branches', () => {
  it('400 when branch missing (path present)', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { path: tmpDir },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('path and branch required')
    } finally {
      await app.close()
    }
  })

  it('400 when path missing (branch present)', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { branch: 'main' },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('path and branch required')
    } finally {
      await app.close()
    }
  })

  it('400 when path is relative', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { path: 'relative/path', branch: 'main' },
      })
      expect(r.statusCode).toBe(400)
      expect(r.json().error).toBe('path must be absolute or start with ~')
    } finally {
      await app.close()
    }
  })

  it('409 when the target repo is dirty (propagates checkoutBranch statusCode)', async () => {
    const repo = buildGitRepo('workspace-checkout-dirty')
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { path: repo, branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toContain('uncommitted changes')
    } finally {
      await app.close()
    }
  })

  it('500s (default status) when branch is not a string', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { path: tmpDir, branch: 123 },
      })
      // branch.trim() throws a plain TypeError (no .statusCode) before
      // checkoutBranch even runs — exercises the ternary's `: 500` default.
      expect(r.statusCode).toBe(500)
    } finally {
      await app.close()
    }
  })

  it('500 with String(err) when checkoutBranch rejects a non-Error value', async () => {
    const repo = buildGitRepo('ws-checkout-nonerror-repo')
    // A rejected non-Error (a bare string) drives the `String(err)` arm of the
    // catch's `err instanceof Error ? err.message : String(err)`.
    const spy = vi.spyOn(gitRepo, 'checkoutBranch').mockRejectedValue('ws string failure')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/checkout',
        payload: { path: repo, branch: 'feature/demo' },
      })
      expect(r.statusCode).toBe(500)
      expect(r.json().error).toBe('ws string failure')
    } finally {
      spy.mockRestore()
      await app.close()
    }
  })
})

describe('POST /api/workspace/clone — additional branches', () => {
  it('400 when no request body is sent at all', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'POST', url: '/api/workspace/clone' })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('500 with "unknown error" fallback when git clone fails silently (no stderr)', async () => {
    const fakeBin = path.join(tmpDir, 'fakebin-silent')
    fs.mkdirSync(fakeBin, { recursive: true })
    const fakeGit = path.join(fakeBin, 'git')
    fs.writeFileSync(fakeGit, '#!/bin/sh\nexit 1\n')
    fs.chmodSync(fakeGit, 0o755)
    const origPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${origPath ?? ''}`
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@x:o/r.git', parentDir: tmpDir, repoName: 'silent-fail' },
      })
      expect(r.statusCode).toBe(500)
      expect((r.json() as { error: string }).error).toBe('git clone failed: unknown error')
    } finally {
      process.env.PATH = origPath
      await app.close()
    }
  })

  it('500 when the git binary cannot be found on PATH (spawn error event)', async () => {
    const emptyBin = path.join(tmpDir, 'empty-bin')
    fs.mkdirSync(emptyBin, { recursive: true })
    const origPath = process.env.PATH
    process.env.PATH = emptyBin // no git binary anywhere on this PATH
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/workspace/clone',
        payload: { cloneUrl: 'git@x:o/r.git', parentDir: tmpDir, repoName: 'no-git-binary' },
      })
      expect(r.statusCode).toBe(500)
      expect((r.json() as { error: string }).error).toContain('git clone failed')
    } finally {
      process.env.PATH = origPath
      await app.close()
    }
  })
})
