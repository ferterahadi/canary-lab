import type { FastifyInstance } from 'fastify'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readFeatureConfig,
  writeFeatureConfig,
  readPlaywrightConfig,
  writePlaywrightConfig,
  type ConfigValue,
} from '../lib/config-ast'
import { parseDotenv, writeDotenv, type KvEntry } from '../lib/dotenv-edit'
import { loadFeatures } from '../lib/feature-loader'

export interface FeatureConfigRouteDeps {
  featuresDir: string
}

const FEATURE_CONFIG_NAMES = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']
const PLAYWRIGHT_CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.cjs']

interface ResolvedConfigPath {
  path: string
  format: 'cjs' | 'js' | 'ts'
}

function findExistingConfig(dir: string, candidates: string[]): ResolvedConfigPath | null {
  for (const name of candidates) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) {
      return { path: p, format: name.split('.').pop() as 'cjs' | 'js' | 'ts' }
    }
  }
  return null
}

/** List the env folder names (alphabetised) under a feature's `envsets/` dir.
 *  This is the single source of truth for which envs a feature has — the
 *  `envs:` array in feature.config.cjs is auto-derived from this. */
function listEnvFolders(featureDir: string): string[] {
  const envsetsDir = path.join(featureDir, 'envsets')
  if (!fs.existsSync(envsetsDir)) return []
  return fs
    .readdirSync(envsetsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

/** Re-sync the `envs:` array in feature.config.{cjs,js,ts} to match the
 *  envset folders on disk. Called after envset add/delete and after every
 *  feature-config save. */
function syncEnvsInConfig(featureDir: string): void {
  const cfg = findExistingConfig(featureDir, FEATURE_CONFIG_NAMES)
  if (!cfg) return
  const source = fs.readFileSync(cfg.path, 'utf-8')
  const parsed = readFeatureConfig(source)
  const value = parsed.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const next = { ...(value as { [k: string]: ConfigValue }), envs: listEnvFolders(featureDir) }
  const written = writeFeatureConfig(source, next)
  if (written !== source) fs.writeFileSync(cfg.path, written)
}

/** True when `target` is the same as or a descendant of `root`. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export async function featureConfigRoutes(
  app: FastifyInstance,
  deps: FeatureConfigRouteDeps,
): Promise<void> {
  // ─── feature.config.{cjs,js,ts} ───────────────────────────────────────

  app.get<{ Params: { name: string } }>('/api/features/:name/config-doc', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature?.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const cfg = findExistingConfig(feature.featureDir, FEATURE_CONFIG_NAMES)
    if (!cfg) {
      reply.code(404)
      return { error: 'config file not found' }
    }
    const content = fs.readFileSync(cfg.path, 'utf-8')
    const parsed = readFeatureConfig(content)
    return { path: cfg.path, format: cfg.format, content, parsed }
  })

  app.put<{ Params: { name: string }; Body: { value: ConfigValue } }>(
    '/api/features/:name/config-doc',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const cfg = findExistingConfig(feature.featureDir, FEATURE_CONFIG_NAMES)
      if (!cfg) {
        reply.code(404)
        return { error: 'config file not found' }
      }
      const source = fs.readFileSync(cfg.path, 'utf-8')
      // Always sync `envs:` to match the actual envset folders on disk —
      // the General tab no longer edits this list (Envsets tab is the
      // single source of truth). We override whatever the client sent.
      const incoming = req.body.value
      const synced: ConfigValue =
        incoming && typeof incoming === 'object' && !Array.isArray(incoming)
          ? { ...(incoming as { [k: string]: ConfigValue }), envs: listEnvFolders(feature.featureDir) }
          : incoming
      let next: string
      try {
        next = writeFeatureConfig(source, synced)
      } catch (err) {
        reply.code(400)
        return { error: (err as Error).message }
      }
      fs.writeFileSync(cfg.path, next)
      const parsed = readFeatureConfig(next)
      return { path: cfg.path, format: cfg.format, content: next, parsed }
    },
  )

  // ─── playwright.config.{ts,js,cjs} ────────────────────────────────────

  app.get<{ Params: { name: string } }>('/api/features/:name/playwright', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature?.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const cfg = findExistingConfig(feature.featureDir, PLAYWRIGHT_CONFIG_NAMES)
    if (!cfg) {
      reply.code(404)
      return { error: 'playwright config not found' }
    }
    const content = fs.readFileSync(cfg.path, 'utf-8')
    const parsed = readPlaywrightConfig(content)
    return { path: cfg.path, format: cfg.format, content, parsed }
  })

  app.put<{ Params: { name: string }; Body: { value: ConfigValue } }>(
    '/api/features/:name/playwright',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const cfg = findExistingConfig(feature.featureDir, PLAYWRIGHT_CONFIG_NAMES)
      if (!cfg) {
        reply.code(404)
        return { error: 'playwright config not found' }
      }
      const source = fs.readFileSync(cfg.path, 'utf-8')
      let next: string
      try {
        next = writePlaywrightConfig(source, req.body.value)
      } catch (err) {
        reply.code(400)
        return { error: (err as Error).message }
      }
      fs.writeFileSync(cfg.path, next)
      const parsed = readPlaywrightConfig(next)
      return { path: cfg.path, format: cfg.format, content: next, parsed }
    },
  )

  // ─── envsets ──────────────────────────────────────────────────────────
  // Layout (per workspace convention, see CLAUDE.md):
  //   <featureDir>/envsets/envsets.config.json
  //   <featureDir>/envsets/<env>/<slot-file>
  //
  // We don't enforce a particular slot list — we just enumerate folders
  // under envsets/ as envs and the files inside as slots. envsets.config.json
  // (when present) provides slot descriptions for the UI.

  app.get<{ Params: { name: string } }>('/api/features/:name/envsets', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature?.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const envsetsDir = path.join(feature.featureDir, 'envsets')
    if (!fs.existsSync(envsetsDir)) {
      return { envs: [], slotDescriptions: {} }
    }
    const envs = fs
      .readdirSync(envsetsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        name: d.name,
        slots: fs
          .readdirSync(path.join(envsetsDir, d.name), { withFileTypes: true })
          .filter((f) => f.isFile())
          .map((f) => f.name),
      }))
    let slotDescriptions: Record<string, string> = {}
    const cfgPath = path.join(envsetsDir, 'envsets.config.json')
    if (fs.existsSync(cfgPath)) {
      try {
        const json = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
        if (json && typeof json === 'object' && json.slots && typeof json.slots === 'object') {
          for (const [k, v] of Object.entries(json.slots as Record<string, { description?: string }>)) {
            if (v && typeof v === 'object' && typeof v.description === 'string') {
              slotDescriptions[k] = v.description
            }
          }
        }
      } catch { /* ignore malformed */ }
    }
    return { envs, slotDescriptions }
  })

  app.post<{ Params: { name: string }; Body: { env: string } }>(
    '/api/features/:name/envsets',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const envName = (req.body?.env ?? '').trim()
      if (!envName || !/^[a-zA-Z0-9_.-]+$/.test(envName)) {
        reply.code(400)
        return { error: 'env must match /^[a-zA-Z0-9_.-]+$/' }
      }
      const envsetsDir = path.join(feature.featureDir, 'envsets')
      const envDir = path.join(envsetsDir, envName)
      if (!isWithin(envsetsDir, envDir)) {
        reply.code(400)
        return { error: 'invalid env name' }
      }
      if (fs.existsSync(envDir)) {
        reply.code(409)
        return { error: 'env already exists' }
      }
      fs.mkdirSync(envDir, { recursive: true })
      // Seed the new env with the same slot files as the first existing
      // env (empty-valued, structure preserved). If no other env exists,
      // create a default `feature.env` placeholder.
      const others = listEnvFolders(feature.featureDir).filter((n) => n !== envName)
      const seedFrom = others[0]
      if (seedFrom) {
        const seedDir = path.join(envsetsDir, seedFrom)
        for (const f of fs.readdirSync(seedDir, { withFileTypes: true })) {
          if (!f.isFile()) continue
          const src = fs.readFileSync(path.join(seedDir, f.name), 'utf-8')
          const blanked = parseDotenv(src).entries.map((e) => ({ key: e.key, value: '' }))
          fs.writeFileSync(path.join(envDir, f.name), writeDotenv('', blanked))
        }
      } else {
        fs.writeFileSync(path.join(envDir, 'feature.env'), '')
      }
      syncEnvsInConfig(feature.featureDir)
      reply.code(201)
      return { env: envName }
    },
  )

  app.delete<{ Params: { name: string; env: string } }>(
    '/api/features/:name/envsets/:env',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const envsetsDir = path.join(feature.featureDir, 'envsets')
      const envDir = path.join(envsetsDir, req.params.env)
      if (!isWithin(envsetsDir, envDir) || !fs.existsSync(envDir)) {
        reply.code(404)
        return { error: 'env not found' }
      }
      fs.rmSync(envDir, { recursive: true, force: true })
      syncEnvsInConfig(feature.featureDir)
      reply.code(204)
      return null
    },
  )

  app.get<{ Params: { name: string; env: string; slot: string } }>(
    '/api/features/:name/envsets/:env/:slot',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const slotPath = path.join(feature.featureDir, 'envsets', req.params.env, req.params.slot)
      // Defense-in-depth path-traversal guard: refuse if the resolved path
      // escapes the feature's envsets dir.
      const envsetsRoot = path.join(feature.featureDir, 'envsets')
      if (!isWithin(envsetsRoot, slotPath) || !fs.existsSync(slotPath)) {
        reply.code(404)
        return { error: 'slot not found' }
      }
      const content = fs.readFileSync(slotPath, 'utf-8')
      const parsed = parseDotenv(content)
      return { path: slotPath, content, ...parsed }
    },
  )

  app.put<{
    Params: { name: string; env: string; slot: string }
    Body: { entries: KvEntry[] }
  }>(
    '/api/features/:name/envsets/:env/:slot',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const slotPath = path.join(feature.featureDir, 'envsets', req.params.env, req.params.slot)
      const envsetsRoot = path.join(feature.featureDir, 'envsets')
      if (!isWithin(envsetsRoot, slotPath) || !fs.existsSync(slotPath)) {
        reply.code(404)
        return { error: 'slot not found' }
      }
      if (!Array.isArray(req.body?.entries)) {
        reply.code(400)
        return { error: 'entries[] required' }
      }
      const source = fs.readFileSync(slotPath, 'utf-8')
      const next = writeDotenv(source, req.body.entries)
      fs.writeFileSync(slotPath, next)
      const parsed = parseDotenv(next)
      return { path: slotPath, content: next, ...parsed }
    },
  )

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
