// Feature-config REST — the feature.config.{cjs,js,ts} document itself, the
// portify-overlay reset, the per-repo git surface, and feature deletion.
// Split out of feature-config.ts; handler bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readFeatureConfig, writeFeatureConfig, type ConfigValue } from '../../../shared/config-ast'
import { loadFeatures } from '../../../shared/feature-loader'
import { checkoutBranch, findRepo, getGitStatus, resolveRepoPath } from '../../../shared/git-repo'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { overlayExists as portifyOverlayExists } from '../../portify/logic/runtime/overlay'
import { revertPortification } from '../../portify/logic/runtime/unportify'
import { FEATURE_CONFIG_NAMES, findExistingConfig, isWithin, listEnvFolders } from './feature-config-support'

export async function registerFeatureConfigDocRoutes(app: FastifyInstance, deps: FeatureConfigRouteDeps): Promise<void> {
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
      // Editing `name` renames the suite: `loadFeatures` keys every feature by
      // it, so the old name stops resolving the moment this file is written.
      // Validate + guard BEFORE the write — a refused rename must leave the
      // config untouched, not half-applied.
      const nextName = typeof (synced as { name?: unknown })?.name === 'string'
        ? ((synced as { name: string }).name).trim()
        : ''
      const renaming = nextName !== '' && nextName !== feature.name
      if (renaming) {
        if (features.some((f) => f.name === nextName)) {
          reply.code(409)
          return { error: `feature name already in use: ${nextName}` }
        }
        const blocked = deps.featureRename?.blockedBy(feature.name)
        if (blocked) {
          reply.code(409)
          return { error: blocked }
        }
      }
      let next: string
      try {
        next = writeFeatureConfig(source, synced)
      } catch (err) {
        reply.code(400)
        return { error: (err as Error).message }
      }
      fs.writeFileSync(cfg.path, next)
      const parsed = readFeatureConfig(next)
      if (renaming) {
        // The suite's history follows its identity. NOTE: the feature DIRECTORY
        // deliberately stays put — `loadFeatures` never reads it (`featureDir`
        // is `__dirname`), while run/coverage/portify records bake absolute
        // `features/<dir>/…` spec + config paths that a move would invalidate.
        const moved = deps.featureRename?.apply(feature.name, nextName) ?? 0
        publishWorkspaceEvent(deps.workspaceEvents, {
          type: 'feature-renamed',
          from: feature.name,
          to: nextName,
        })
        // Flight rows are keyed by feature name — refresh them too, so the
        // renamed suite and its flight stop looking like two separate things.
        if (moved > 0) {
          publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
        }
      }
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return { path: cfg.path, format: cfg.format, content: next, parsed }
    },
  )

  // ─── un-portify: always auto-clean, never prompt ──────────────────────
  // Portify makes two kinds of change: a reversible product-code overlay, AND
  // permanent edits to feature.config.cjs (the declared `ports` slots + the
  // `${port.x}` health-check / inter-service URL rewrites). So removal restores
  // the pre-Portify config — every overlay written since this shipped carries a
  // snapshot (captured at save), so the restore is exact and lossless.
  //
  // Legacy overlays (saved before snapshots existed) have nothing to restore;
  // rather than leave the slots lingering we best-effort strip the declared
  // `ports` so they don't show. Their `${port.x}` health-check tokens can't be
  // un-rewritten without the snapshot — re-run Portify to regenerate a clean
  // config. Either way the overlay is deleted and we never prompt the user.
  // Emits features-changed so the Portified badge flips live, no refresh.
  app.delete<{ Params: { name: string } }>('/api/features/:name/portify-overlay', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature?.featureDir) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const { reverted } = revertPortification(feature.featureDir)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
    return { name: feature.name, portified: portifyOverlayExists(feature.featureDir), reverted }
  })

  app.get<{ Params: { name: string; repo: string } }>(
    '/api/features/:name/repos/:repo/git',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const repo = findRepo(feature, req.params.repo)
      if (!repo) {
        reply.code(404)
        return { error: 'repo not found' }
      }
      const status = await getGitStatus(repo.localPath)
      return {
        ...status,
        path: resolveRepoPath(repo.localPath),
        expectedBranch: repo.branch ?? null,
      }
    },
  )

  app.post<{ Params: { name: string; repo: string }; Body: { branch?: string } }>(
    '/api/features/:name/repos/:repo/checkout',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const repo = findRepo(feature, req.params.repo)
      if (!repo) {
        reply.code(404)
        return { error: 'repo not found' }
      }
      if (deps.isRepoActive?.(feature.name, repo.name)) {
        reply.code(409)
        return { error: 'repo has an active service run' }
      }
      const branch = req.body?.branch
      if (typeof branch !== 'string' || branch.trim().length === 0) {
        reply.code(400)
        return { error: 'branch required' }
      }
      try {
        const status = await checkoutBranch(repo.localPath, branch.trim())
        // Branch moved; refresh the feature list + Repos tab git-status row live.
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
        return {
          ...status,
          path: resolveRepoPath(repo.localPath),
          expectedBranch: repo.branch ?? null,
        }
      } catch (err) {
        const code = typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500
        reply.code(code)
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Re-pin every repo's configured branch to whatever it's currently on. The
  // inverse of the checkout route: instead of moving working trees onto the
  // pinned branch, adopt the current branches as the new pins so future runs
  // test them. Powers the "Pin feature to current branches" action on the
  // run-start branch-mismatch dialog. 409 if any repo has no branch to pin.
  app.post<{ Params: { name: string } }>(
    '/api/features/:name/pin-current-branches',
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
      const pins: Array<{ name: string; branch: string }> = []
      for (const repo of feature.repos ?? []) {
        if (typeof repo.localPath !== 'string') continue
        const status = await getGitStatus(resolveRepoPath(repo.localPath))
        if (!status.isGitRepo || status.detached || !status.currentBranch) {
          reply.code(409)
          return { error: `${repo.name}: no branch to pin (detached HEAD or not a git repository)` }
        }
        pins.push({ name: repo.name, branch: status.currentBranch })
      }
      const source = fs.readFileSync(cfg.path, 'utf-8')
      const { value } = readFeatureConfig(source)
      const repos = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { repos?: unknown }).repos
        : undefined
      if (!Array.isArray(repos)) {
        reply.code(400)
        return { error: 'config has no editable repos array' }
      }
      for (const entry of repos) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const rec = entry as { name?: unknown; branch?: unknown }
          const pin = pins.find((p) => p.name === rec.name)
          if (pin) rec.branch = pin.branch
        }
      }
      let next: string
      try {
        next = writeFeatureConfig(source, value)
      } catch (err) {
        reply.code(400)
        return { error: (err as Error).message }
      }
      fs.writeFileSync(cfg.path, next)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return { name: feature.name, pins }
    },
  )

  app.delete<{ Params: { name: string }; Body: { confirmName?: string } }>(
    '/api/features/:name',
    async (req, reply) => {
      const features = loadFeatures(deps.featuresDir)
      const feature = features.find((f) => f.name === req.params.name)
      if (!feature?.featureDir) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      if (req.body?.confirmName !== feature.name) {
        reply.code(400)
        return { error: 'confirmName must match the feature name' }
      }
      const featuresRoot = path.resolve(deps.featuresDir)
      const featureDir = path.resolve(feature.featureDir)
      if (featureDir === featuresRoot || !isWithin(featuresRoot, featureDir)) {
        reply.code(400)
        return { error: 'feature directory is outside the features root' }
      }
      // R76: the suite's flight history goes with it — guarded first, so an
      // active flight blocks the whole deletion before anything is removed.
      const flights = deps.removeFlightRecordsFor?.(feature.name)
      if (flights?.error) {
        reply.code(409)
        return { error: flights.error }
      }
      fs.rmSync(featureDir, { recursive: true, force: true })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-deleted', feature: feature.name })
      if ((flights?.removed ?? 0) > 0) {
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
      }
      reply.code(204)
      return null
    },
  )
}
