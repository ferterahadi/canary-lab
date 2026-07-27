// Feature-config REST — the generic filesystem browser and the workspace dir
// picker (git remote/status, checkout, clone). Bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseDotenv } from '../logic/dotenv-edit'
import { checkoutBranch, getGitStatus, resolveRepoPath } from '../../../shared/git-repo'

export async function registerWorkspaceFsRoutes(app: FastifyInstance, deps: FeatureConfigRouteDeps): Promise<void> {
  // ─── generic filesystem browser ────────────────────────────────────────
  //
  // Lists files and folders at an absolute path. Used by the add-slot file
  // picker. canary-lab is a local-only dev tool, so the endpoint can read
  // anywhere the server process can; this is intentional.

  // Read an absolute file path and return parsed dotenv entries. Used by the
  // SlotEditor "Copy from… → From file" flow. Local-only dev tool — same posture
  // as /api/fs/browse.
  app.get<{ Querystring: { path?: string } }>('/api/fs/read-dotenv', async (req, reply) => {
    const home = os.homedir()
    const raw = (req.query.path ?? '').trim()
    if (!raw) {
      reply.code(400)
      return { error: 'path required' }
    }
    const expanded = raw.startsWith('~/') || raw === '~'
      ? path.join(home, raw.slice(1))
      : raw
    if (!path.isAbsolute(expanded)) {
      reply.code(400)
      return { error: 'path must be absolute or start with ~' }
    }
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isFile()) {
      reply.code(404)
      return { error: 'file not found' }
    }
    const content = fs.readFileSync(expanded, 'utf-8')
    const parsed = parseDotenv(content)
    return { path: expanded, entries: parsed.entries, unparsedLines: parsed.unparsedLines }
  })

  app.get<{ Querystring: { dir?: string } }>('/api/fs/browse', async (req) => {
    const home = os.homedir()
    const raw = (req.query.dir ?? '').trim()
    const expanded = raw.startsWith('~/') || raw === '~'
      ? path.join(home, raw.slice(1))
      : raw
    const target = expanded === ''
      ? home
      : path.isAbsolute(expanded)
        ? expanded
        : path.resolve(home, expanded)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { dir: home, parent: null, entries: [] }
    }
    let entries: Array<{ name: string; isDir: boolean }> = []
    try {
      entries = fs
        .readdirSync(target, { withFileTypes: true })
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    } catch {
      // Permission denied — return empty entries.
    }
    const parent = path.dirname(target)
    return {
      dir: target,
      parent: parent === target ? null : parent,
      entries,
    }
  })

  // ─── workspace dir picker ─────────────────────────────────────────────
  //
  // canary-lab is a local-only dev tool — the picker can browse anywhere on
  // the user's filesystem. `at` may be an absolute path or a path relative
  // to $HOME. Empty `at` defaults to $HOME.

  app.get<{ Querystring: { at?: string } }>('/api/workspace/dirs', async (req) => {
    const home = os.homedir()
    const requested = req.query.at ?? ''
    const expanded = requested.startsWith('~/') || requested === '~'
      ? path.join(home, requested.slice(1))
      : requested
    const target = expanded === ''
      ? home
      : path.isAbsolute(expanded)
        ? expanded
        : path.resolve(home, expanded)
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      return { root: home, at: '', absolute: home, parent: null, dirs: [] }
    }
    let dirs: string[] = []
    try {
      dirs = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort()
    } catch {
      // Permission denied — show the path with no dirs rather than crash.
    }
    const parent = path.dirname(target)
    return {
      root: home,
      at: target,
      absolute: target,
      parent: parent === target ? null : parent,
      dirs,
    }
  })

  // Read .git/config and return remote.origin.url for a folder.
  app.get<{ Querystring: { path?: string } }>('/api/workspace/git-remote', async (req, reply) => {
    const raw = req.query.path
    if (!raw) {
      reply.code(400)
      return { error: 'path query required' }
    }
    const home = os.homedir()
    const target = raw.startsWith('~/') || raw === '~' ? path.join(home, raw.slice(1)) : raw
    if (!path.isAbsolute(target)) {
      reply.code(400)
      return { error: 'path must be absolute or start with ~' }
    }
    const cfg = path.join(target, '.git', 'config')
    if (!fs.existsSync(cfg)) return { cloneUrl: null }
    let content: string
    try {
      content = fs.readFileSync(cfg, 'utf-8')
    } catch {
      return { cloneUrl: null }
    }
    const lines = content.split('\n')
    let inOrigin = false
    for (const raw of lines) {
      const line = raw.trim()
      if (line.startsWith('[')) {
        inOrigin = /^\[remote\s+"origin"\]$/.test(line)
        continue
      }
      if (inOrigin) {
        const m = /^url\s*=\s*(.+)$/.exec(line)
        if (m) return { cloneUrl: m[1].trim() }
      }
    }
    return { cloneUrl: null }
  })

  app.get<{ Querystring: { path?: string } }>('/api/workspace/path-exists', async (req, reply) => {
    const raw = req.query.path
    if (!raw) {
      reply.code(400)
      return { error: 'path query required' }
    }
    const home = os.homedir()
    const target = raw.startsWith('~/') || raw === '~' ? path.join(home, raw.slice(1)) : raw
    if (!path.isAbsolute(target)) {
      reply.code(400)
      return { error: 'path must be absolute or start with ~' }
    }
    const exists = fs.existsSync(target) && fs.statSync(target).isDirectory()
    return { exists }
  })

  app.get<{ Querystring: { path?: string } }>('/api/workspace/git-status', async (req, reply) => {
    const raw = req.query.path
    if (!raw) {
      reply.code(400)
      return { error: 'path query required' }
    }
    const target = resolveRepoPath(raw)
    if (!path.isAbsolute(target)) {
      reply.code(400)
      return { error: 'path must be absolute or start with ~' }
    }
    const status = await getGitStatus(target)
    return {
      ...status,
      path: target,
      expectedBranch: null,
    }
  })

  app.post<{ Body: { path?: string; branch?: string } }>('/api/workspace/checkout', async (req, reply) => {
    const raw = req.body?.path
    const branch = req.body?.branch
    if (!raw || !branch) {
      reply.code(400)
      return { error: 'path and branch required' }
    }
    const target = resolveRepoPath(raw)
    if (!path.isAbsolute(target)) {
      reply.code(400)
      return { error: 'path must be absolute or start with ~' }
    }
    try {
      const status = await checkoutBranch(target, branch.trim())
      return {
        ...status,
        path: target,
        expectedBranch: null,
      }
    } catch (err) {
      const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
      reply.code(code)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Clone a repo into <parentDir>/<repoName> via `git clone`. Uses spawn
  // with array args (no shell) so cloneUrl/repoName can't inject commands.
  app.post<{ Body: { cloneUrl?: string; parentDir?: string; repoName?: string } }>(
    '/api/workspace/clone',
    async (req, reply) => {
      const { cloneUrl, parentDir, repoName } = req.body ?? {}
      if (!cloneUrl || !parentDir || !repoName) {
        reply.code(400)
        return { error: 'cloneUrl, parentDir, repoName required' }
      }
      if (!path.isAbsolute(parentDir)) {
        reply.code(400)
        return { error: 'parentDir must be absolute' }
      }
      if (repoName.includes('/') || repoName.includes('\\') || repoName.startsWith('.')) {
        reply.code(400)
        return { error: 'invalid repoName' }
      }
      if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
        reply.code(400)
        return { error: 'parentDir does not exist' }
      }
      const target = path.join(parentDir, repoName)
      if (fs.existsSync(target)) {
        reply.code(409)
        return { error: `target already exists: ${target}` }
      }
      const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        const child = spawn('git', ['clone', cloneUrl, target], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (d) => { stderr += d.toString() })
        child.on('error', (err) => resolve({ ok: false, stderr: err.message }))
        child.on('close', (code) => resolve({ ok: code === 0, stderr }))
      })
      if (!result.ok) {
        reply.code(500)
        return { error: `git clone failed: ${result.stderr.trim() || 'unknown error'}` }
      }
      return { localPath: target }
    },
  )
}
