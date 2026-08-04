// Feature-config REST — envsets and feature-scoped port/env slots.
// Split out of feature-config.ts; handler bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseDotenv, writeDotenv, type KvEntry } from '../logic/dotenv-edit'
import { loadFeatures } from '../../../shared/feature-loader'
import { resolveVars } from '../../runs/logic/runtime/env-switcher/switch'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { EnvsetsConfigJson, buildAppRoots, isValidSlotName, isWithin, listEnvFolders, readEnvsetsConfig, shortenHome, syncEnvsInConfig, writeEnvsetsConfig } from './feature-config-support'

export async function registerEnvsetRoutes(app: FastifyInstance, deps: FeatureConfigRouteDeps): Promise<void> {
  // ─── envsets ──────────────────────────────────────────────────────────
  // Layout (per workspace convention):
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
      return { envs: [], slotDescriptions: {}, slotTargets: {} }
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
    const slotDescriptions: Record<string, string> = {}
    const slotTargets: Record<string, string> = {}
    const slotTargetsRaw: Record<string, string> = {}
    const cfg = readEnvsetsConfig(envsetsDir)
    const appRoots = buildAppRoots(cfg)
    if (cfg.slots) {
      for (const [k, v] of Object.entries(cfg.slots)) {
        if (v && typeof v === 'object') {
          if (typeof v.description === 'string') slotDescriptions[k] = v.description
          if (typeof v.target === 'string') {
            slotTargetsRaw[k] = v.target
            slotTargets[k] = shortenHome(resolveVars(v.target, appRoots))
          }
        }
      }
    }
    return { envs, slotDescriptions, slotTargets, slotTargetsRaw }
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
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature: feature.name })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
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
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature: feature.name })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
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
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature: feature.name })
      return { path: slotPath, content: next, ...parsed }
    },
  )

  // ─── feature-scoped slot management ────────────────────────────────────
  //
  // Slots are defined per-feature in envsets.config.json (`slots` object +
  // `feature.slots[]`). Each env folder under envsets/<env>/ holds a copy of
  // each slot file. Adding a slot replicates its initial content into every
  // env; deleting a slot wipes it from every env.

  app.post<{
    Params: { name: string }
    Body: { sourcePath: string; slotName?: string; target?: string; description?: string }
  }>('/api/features/:name/envsets/slots', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature?.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const sourceRaw = (req.body?.sourcePath ?? '').trim()
    if (!sourceRaw) {
      reply.code(400)
      return { error: 'sourcePath required' }
    }
    const home = os.homedir()
    const sourcePath = sourceRaw.startsWith('~/') || sourceRaw === '~'
      ? path.join(home, sourceRaw.slice(1))
      : sourceRaw
    if (!path.isAbsolute(sourcePath)) {
      reply.code(400)
      return { error: 'sourcePath must be absolute or start with ~' }
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      reply.code(400)
      return { error: 'sourcePath is not a file' }
    }
    const slotName = (req.body?.slotName ?? path.basename(sourcePath)).trim()
    if (!isValidSlotName(slotName)) {
      reply.code(400)
      return { error: 'slotName must match /^[a-zA-Z0-9._-]+$/ and name a file' }
    }
    const envsetsDir = path.join(feature.featureDir, 'envsets')
    const envs = listEnvFolders(feature.featureDir)
    if (envs.length === 0) {
      reply.code(400)
      return { error: 'create at least one env first' }
    }
    const cfg = readEnvsetsConfig(envsetsDir)
    if (cfg.slots && cfg.slots[slotName]) {
      reply.code(409)
      return { error: 'slot already exists' }
    }
    const target = (req.body?.target ?? sourcePath).trim() || sourcePath
    const description = (req.body?.description ?? '').trim()
    let content: string
    try {
      content = fs.readFileSync(sourcePath, 'utf-8')
    } catch (err) {
      reply.code(400)
      return { error: `cannot read sourcePath: ${(err as Error).message}` }
    }
    // `isValidSlotName` above and the on-disk env folder names make every
    // joined path a file inside `envsetsDir`, so no traversal re-check here.
    for (const env of envs) {
      fs.writeFileSync(path.join(envsetsDir, env, slotName), content)
    }
    const nextCfg: EnvsetsConfigJson = {
      ...cfg,
      slots: { ...(cfg.slots ?? {}), [slotName]: { description, target } },
      feature: {
        ...(cfg.feature ?? {}),
        slots: Array.from(new Set([...(cfg.feature?.slots ?? []), slotName])),
      },
    }
    writeEnvsetsConfig(envsetsDir, nextCfg)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature: feature.name })
    reply.code(201)
    return { slot: slotName }
  })

  app.delete<{ Params: { name: string; slot: string } }>(
    '/api/features/:name/envsets/slots/:slot',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const slotName = req.params.slot
      if (!isValidSlotName(slotName)) {
        reply.code(400)
        return { error: 'invalid slot name' }
      }
      const envsetsDir = path.join(feature.featureDir, 'envsets')
      const envs = listEnvFolders(feature.featureDir)
      // Same reasoning as the create route: the validated slot name plus a real
      // env folder name cannot join to a path outside `envsetsDir`.
      for (const env of envs) {
        const slotPath = path.join(envsetsDir, env, slotName)
        if (fs.existsSync(slotPath)) fs.rmSync(slotPath, { force: true })
      }
      const cfg = readEnvsetsConfig(envsetsDir)
      if (cfg.slots) delete cfg.slots[slotName]
      if (cfg.feature?.slots) {
        cfg.feature.slots = cfg.feature.slots.filter((s) => s !== slotName)
      }
      if (fs.existsSync(envsetsDir)) writeEnvsetsConfig(envsetsDir, cfg)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature: feature.name })
      reply.code(204)
      return null
    },
  )
}
