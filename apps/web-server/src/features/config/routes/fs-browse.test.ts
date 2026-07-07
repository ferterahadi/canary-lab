import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { fsBrowseRoutes } from './fs-browse'

// The route is jailed to the real home tree, so valid-case fixtures must live
// under os.homedir(). We make a scratch dir there and clean it up after.
const homeReal = fs.realpathSync(os.homedir())
let scratch: string
// Absolute path outside home, for the escape-rejection cases.
let outside: string

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(homeReal, '.cl-browse-test-')))
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-browse-outside-')))
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(fsBrowseRoutes)
  await app.ready()
  return app
}

interface Body {
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
}

describe('GET /api/fs/browse-dirs', () => {
  it('defaults to the home directory when no path is given', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/fs/browse-dirs' })
      expect(r.statusCode).toBe(200)
      const body = r.json() as Body
      expect(body.path).toBe(homeReal)
      // At the home root, parent is null (never point above home).
      expect(body.parent).toBeNull()
    } finally {
      await app.close()
    }
  })

  it('lists only directories, sorted, excluding hidden and files', async () => {
    fs.mkdirSync(path.join(scratch, 'zebra'))
    fs.mkdirSync(path.join(scratch, 'apple'))
    fs.mkdirSync(path.join(scratch, '.hidden'))
    fs.writeFileSync(path.join(scratch, 'a-file.txt'), '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(scratch)}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as Body
      expect(body.path).toBe(scratch)
      expect(body.entries.map((e) => e.name)).toEqual(['apple', 'zebra'])
      // Each entry carries its own absolute path.
      expect(body.entries.find((e) => e.name === 'apple')?.path).toBe(path.join(scratch, 'apple'))
      // Parent is the scratch dir's parent (inside home), not null.
      expect(body.parent).toBe(path.dirname(scratch))
    } finally {
      await app.close()
    }
  })

  it('navigates into a child directory', async () => {
    const child = path.join(scratch, 'child')
    fs.mkdirSync(child)
    fs.mkdirSync(path.join(child, 'grand'))
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(child)}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as Body
      expect(body.path).toBe(child)
      expect(body.parent).toBe(scratch)
      expect(body.entries.map((e) => e.name)).toEqual(['grand'])
    } finally {
      await app.close()
    }
  })

  it('expands a leading ~', async () => {
    fs.mkdirSync(path.join(scratch, 'sub'))
    const rel = path.join('~', path.relative(homeReal, scratch))
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(rel)}`,
      })
      expect(r.statusCode).toBe(200)
      const body = r.json() as Body
      expect(body.path).toBe(scratch)
      expect(body.entries.map((e) => e.name)).toEqual(['sub'])
    } finally {
      await app.close()
    }
  })

  it('rejects a path outside the home directory (400)', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(outside)}`,
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('rejects a symlink inside home that escapes to outside home (400)', async () => {
    // A symlink under home pointing outside must not open the escape hatch —
    // the realpath comparison closes it.
    const link = path.join(scratch, 'escape')
    fs.symlinkSync(outside, link, 'dir')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(link)}`,
      })
      expect(r.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('404s a file path (not a directory)', async () => {
    const file = path.join(scratch, 'notadir.txt')
    fs.writeFileSync(file, '')
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(file)}`,
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('404s a non-existent path', async () => {
    const app = await makeApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: `/api/fs/browse-dirs?path=${encodeURIComponent(path.join(scratch, 'nope'))}`,
      })
      expect(r.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
