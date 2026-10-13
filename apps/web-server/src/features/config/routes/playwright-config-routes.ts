import { resolveConfigDocument, readConfigDocument, writeConfigDocument } from './config-document'
// Feature-config REST — the playwright.config.{ts,js,cjs} document.
// Split out of feature-config.ts; handler bodies are unchanged.
import type { FastifyInstance } from 'fastify'
import type { FeatureConfigRouteDeps } from './feature-config-deps'
import { readPlaywrightConfig, writePlaywrightConfig } from '../../../shared/config-ast'
import type { ConfigValue } from '../../../../../../shared/config-value'
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
      const written = writeConfigDocument(cfg, req.body.value, writePlaywrightConfig, readPlaywrightConfig)
      if (!written.ok) {
        reply.code(400)
        return { error: written.error }
      }
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return written.document
    },
  )
}
