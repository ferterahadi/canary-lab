// Feature-config REST — the playwright.config.{ts,js,cjs} document.
// Split out of feature-config.ts; handler bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readPlaywrightConfig, writePlaywrightConfig, type ConfigValue } from '../../../shared/config-ast'
import { loadFeatures } from '../../../shared/feature-loader'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { PLAYWRIGHT_CONFIG_NAMES, findExistingConfig } from './feature-config-support'

export async function registerPlaywrightConfigRoutes(app: FastifyInstance, deps: FeatureConfigRouteDeps): Promise<void> {
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
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return { path: cfg.path, format: cfg.format, content: next, parsed }
    },
  )
}
