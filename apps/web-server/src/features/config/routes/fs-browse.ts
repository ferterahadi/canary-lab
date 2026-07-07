import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Directory-only browser jailed to the user's home tree. Backs a directory
// picker (choose a folder, never a file). Distinct from `/api/fs/browse` in
// feature-config.ts, which lists files+dirs anywhere for the envset slot
// picker — this one refuses to leave home and never lists files.
//
// Contract: GET /api/fs/browse-dirs?path=<abs> →
//   { path, parent: string | null, entries: [{ name, path }] }
// Read-only, so no workspace event.

interface DirEntry {
  name: string
  path: string
}

interface BrowseDirsResult {
  path: string
  parent: string | null
  entries: DirEntry[]
}

const MAX_ENTRIES = 200

export async function fsBrowseRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { path?: string } }>('/api/fs/browse-dirs', async (req, reply) => {
    const home = os.homedir()
    // realpathSync the home root so the containment check compares canonical
    // paths on both sides (home itself may sit behind a symlink, e.g. /var vs
    // /private/var on macOS).
    let homeReal: string
    try {
      homeReal = fs.realpathSync(home)
    } catch {
      homeReal = home
    }

    const raw = (req.query.path ?? '').trim()
    const expanded = raw === '' || raw === '~'
      ? homeReal
      : raw.startsWith('~/')
        ? path.join(homeReal, raw.slice(2))
        : raw

    if (!path.isAbsolute(expanded)) {
      reply.code(400)
      return { error: 'path must be absolute or start with ~' }
    }

    // Resolve symlinks before the containment check so a symlink inside home
    // that points outside can't be used to escape. A non-existent target has
    // no realpath — 404 rather than crash.
    let target: string
    try {
      target = fs.realpathSync(expanded)
    } catch {
      reply.code(404)
      return { error: 'directory not found' }
    }

    // Reject anything whose canonical path escapes the home tree. Compare with a
    // trailing separator so `/home/user-other` doesn't pass the `/home/user`
    // prefix test.
    const withinHome = target === homeReal || target.startsWith(homeReal + path.sep)
    if (!withinHome) {
      reply.code(400)
      return { error: 'path is outside the home directory' }
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      reply.code(404)
      return { error: 'directory not found' }
    }
    if (!stat.isDirectory()) {
      reply.code(404)
      return { error: 'not a directory' }
    }

    let entries: DirEntry[] = []
    try {
      entries = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_ENTRIES)
    } catch {
      // Permission denied — show the directory with no entries rather than crash.
    }

    // Never point above home: at the home root, parent is null.
    const parentPath = path.dirname(target)
    const parent = target === homeReal || parentPath === target ? null : parentPath

    const result: BrowseDirsResult = { path: target, parent, entries }
    return result
  })
}
