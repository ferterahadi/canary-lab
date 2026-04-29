import type { FastifyInstance } from 'fastify'
import { loadSkills, type SkillRecord } from '../lib/skill-loader'
import { recommendSkills } from '../lib/skill-recommender'

export interface SkillsRouteDeps {
  // Lazy provider so tests can inject a fixed list. In production this calls
  // loadSkills() with the default roots (~/.claude/skills + plugin caches).
  listSkills?: () => SkillRecord[]
}

export async function skillsRoutes(app: FastifyInstance, deps: SkillsRouteDeps = {}): Promise<void> {
  const provide = deps.listSkills ?? (() => loadSkills())

  app.get('/api/skills', async () => {
    return provide()
  })

  app.post<{ Body: { prdText?: unknown; topN?: unknown } }>('/api/skills/recommend', async (req, reply) => {
    const prdText = req.body?.prdText
    if (typeof prdText !== 'string' || !prdText.trim()) {
      reply.code(400)
      return { error: 'prdText required' }
    }
    const topN = typeof req.body?.topN === 'number' ? req.body.topN : undefined
    const skills = provide()
    return recommendSkills(prdText, skills, topN ? { topN } : undefined)
  })
}
