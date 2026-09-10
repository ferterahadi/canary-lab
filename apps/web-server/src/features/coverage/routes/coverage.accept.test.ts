import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coverageRoutes } from './coverage'
import { applyExternalSummary } from '../logic/coverage/feature-docs'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

let tmp: string
let featuresDir: string
let logsDir: string
let app: FastifyInstance
let events: WorkspaceEvent[]

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-accept-route-')))
  featuresDir = path.join(tmp, 'features')
  logsDir = path.join(tmp, 'logs')
  const dir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: 'checkout', description: 'd', envs: ['local'], repos: [{ name: 'r', localPath: __dirname }], featureDir: __dirname } }`,
  )
  fs.writeFileSync(path.join(dir, 'docs', 'spec.md'), '# Checkout\n\n## Totals\nThe total equals the sum of lines.\n')
  applyExternalSummary({
    featuresDir,
    feature: 'checkout',
    requirements: [{ title: 'Totals add up', text: 'The total equals the sum of lines.', pathTypes: ['happy'] }],
    now: '2026-09-01T00:00:00.000Z',
  })
  app = Fastify()
  events = []
  await app.register(coverageRoutes, { featuresDir, logsDir, projectRoot: tmp, workspaceEvents: { publish: (e) => events.push(e) } })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('retired requirement confirmation endpoint', () => {
  it('rejects the old endpoint without changing the summary, ledger, or workspace events', async () => {
    const file = path.join(featuresDir, 'checkout', 'docs', '_prd-summary.json')
    const before = fs.readFileSync(file, 'utf-8')
    const ledgerBefore = (await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json()
    const res = await app.inject({ method: 'POST', url: '/api/features/checkout/requirements/R1/accept' })
    expect(res.statusCode).toBe(404)
    expect(fs.readFileSync(file, 'utf-8')).toBe(before)
    expect((await app.inject({ method: 'GET', url: '/api/features/checkout/coverage' })).json()).toEqual(ledgerBefore)
    expect(events).toEqual([])
  })
})
