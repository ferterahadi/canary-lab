import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { featureConfigRoutes } from './feature-config'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

let tmpDir: string

let featuresDir: string

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

describe('GET /api/fs/read-dotenv — tilde expansion', () => {
  it('expands ~/ before checking existence', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/fs/read-dotenv?path=~/__cl_test_does_not_exist__.env',
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('GET /api/fs/browse — additional branches', () => {
  it('resolves a relative dir against home (falls back when not found)', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/fs/browse?dir=__cl_relative_nonexistent__',
      })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { dir: string }).dir).toBe(os.homedir())
    } finally {
      await app.close()
    }
  })

  it('parent is null at the filesystem root', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/fs/browse?dir=/' })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { dir: string; parent: string | null }).parent).toBeNull()
    } finally {
      await app.close()
    }
  })
})

describe('GET /api/workspace/dirs — additional branches', () => {
  it('resolves a relative at against home', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/workspace/dirs?at=__cl_relative_nonexistent__',
      })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { absolute: string }).absolute).toBe(os.homedir())
    } finally {
      await app.close()
    }
  })

  it('parent is null at the filesystem root', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/workspace/dirs?at=/' })
      expect(r.statusCode).toBe(200)
      expect((r.json() as { parent: string | null }).parent).toBeNull()
    } finally {
      await app.close()
    }
  })
})
