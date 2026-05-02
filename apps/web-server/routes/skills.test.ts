import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { SkillRecord } from '../lib/skill-loader'
import { skillsRoutes } from './skills'

const fixture: SkillRecord[] = [
  { id: 'login', name: 'login-flow', description: 'Helps with login and authentication', source: 'user', path: '/x' },
  { id: 'voucher', name: 'voucher-redeem', description: 'Voucher redemption and discount logic', source: 'user', path: '/x' },
  { id: 'misc', name: 'misc', description: 'Random unrelated skill', source: 'user', path: '/x' },
]

async function make(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify()
  await skillsRoutes(app, { listSkills: () => fixture })
  return app
}

describe('GET /api/skills', () => {
  it('returns the full list', async () => {
    const app = await make()
    const r = await app.inject({ method: 'GET', url: '/api/skills' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toHaveLength(3)
    await app.close()
  })

  it('falls back to the default skill loader when no provider is injected', async () => {
    const app = Fastify()
    await skillsRoutes(app)
    const r = await app.inject({ method: 'GET', url: '/api/skills' })
    expect(r.statusCode).toBe(200)
    expect(Array.isArray(r.json())).toBe(true)
    await app.close()
  })
})

describe('POST /api/skills/recommend', () => {
  it('returns recommendations for matching PRD', async () => {
    const app = await make()
    const r = await app.inject({
      method: 'POST',
      url: '/api/skills/recommend',
      payload: { prdText: 'User login flow with authentication and voucher redemption.' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json() as { skillId: string }[]
    expect(body.length).toBeGreaterThan(0)
    expect(body.some((b) => b.skillId === 'login')).toBe(true)
    await app.close()
  })

  it('honors topN', async () => {
    const app = await make()
    const r = await app.inject({
      method: 'POST',
      url: '/api/skills/recommend',
      payload: { prdText: 'login authentication voucher redemption', topN: 1 },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json() as unknown[]
    expect(body).toHaveLength(1)
    await app.close()
  })

  it('400s on missing prdText', async () => {
    const app = await make()
    const r = await app.inject({ method: 'POST', url: '/api/skills/recommend', payload: {} })
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('400s on empty prdText', async () => {
    const app = await make()
    const r = await app.inject({ method: 'POST', url: '/api/skills/recommend', payload: { prdText: '   ' } })
    expect(r.statusCode).toBe(400)
    await app.close()
  })
})
