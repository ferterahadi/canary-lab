import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import { loadFeatures, listSpecFiles } from '../lib/feature-loader'
import { extractTestsFromSource } from '../lib/ast-extractor'

export interface FeaturesRouteDeps {
  featuresDir: string
}

export async function featuresRoutes(app: FastifyInstance, deps: FeaturesRouteDeps): Promise<void> {
  app.get('/api/features', async () => {
    const features = loadFeatures(deps.featuresDir)
    return features.map((f) => ({
      name: f.name,
      description: f.description,
      repos: (f.repos ?? []).map((r) => ({ name: r.name, localPath: r.localPath })),
      envs: f.envs ?? [],
    }))
  })

  app.get<{ Params: { name: string } }>('/api/features/:name/tests', async (req, reply) => {
    const features = loadFeatures(deps.featuresDir)
    const feature = features.find((f) => f.name === req.params.name)
    if (!feature) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    const specFiles = listSpecFiles(feature.featureDir)
    return specFiles.map((file) => {
      let source = ''
      try { source = fs.readFileSync(file, 'utf-8') } catch { /* unreadable */ }
      const result = extractTestsFromSource(file, source)
      return {
        file,
        tests: result.tests,
        ...(result.parseError ? { parseError: result.parseError } : {}),
      }
    })
  })
}
