import { resolveConfigDocument, readConfigDocument } from './config-document'
// Feature-config REST — the playwright.config.{ts,js,cjs} document.
// Split out of feature-config.ts; handler bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'
import fs from 'fs'
import { readPlaywrightConfig, writePlaywrightConfig, type ConfigValue } from '../../../shared/config-ast'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { PLAYWRIGHT_CONFIG_NAMES } from '../../../shared/playwright-config'
import { notFound } from '../../../shared/http-error'

export async function registerPlaywrightConfigRoutes(app: FastifyInstance, deps: FeatureConfigRouteDeps): Promise<void> {
  // ─── playwright.config.{ts,js,cjs} ────────────────────────────────────

  app.get<{ Params: { name: string } }>('/api/features/:name/playwright', async (req, reply) => {
    const document = resolveConfigDocument(deps.featuresDir, req.params.name, PLAYWRIGHT_CONFIG_NAMES, 'playwright config')
    if (!document.ok) return notFound(reply, document.missing)
    const { cfg } = document
    return readConfigDocument(cfg, readPlaywrightConfig)
  })

  app.put<{ Params: { name: string }; Body: { value: ConfigValue } }>(
    '/api/features/:name/playwright',
    async (req, reply) => {
      const document = resolveConfigDocument(deps.featuresDir, req.params.name, PLAYWRIGHT_CONFIG_NAMES, 'playwright config')
      if (!document.ok) return notFound(reply, document.missing)
      const { cfg } = document
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
