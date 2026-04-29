import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { featuresRoutes } from './features'

let tmpDir: string
let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-froutes-')))
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(featuresDir, { recursive: true })
})

function writeFeature(name: string, opts: { spec?: string } = {}): string {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: {
      name: ${JSON.stringify(name)},
      description: 'desc',
      envs: ['local'],
      repos: [{ name: 'repo1', localPath: __dirname }],
      featureDir: __dirname,
    } }`,
  )
  if (opts.spec !== undefined) {
    const e2eDir = path.join(dir, 'e2e')
    fs.mkdirSync(e2eDir, { recursive: true })
    fs.writeFileSync(path.join(e2eDir, 'a.spec.ts'), opts.spec)
  }
  return dir
}

async function build() {
  const app = Fastify()
  await app.register(featuresRoutes, { featuresDir })
  return app
}

describe('GET /api/features', () => {
  it('returns the list of discovered features', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ name: 'alpha', description: 'desc', envs: ['local'] })
    expect(body[0].repos).toHaveLength(1)
  })

  it('returns [] when no features exist', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features' })
    expect(res.json()).toEqual([])
  })
})

describe('GET /api/features/:name/tests', () => {
  it('parses spec files and returns tests with steps', async () => {
    writeFeature('alpha', {
      spec: `
        test('first', async () => {
          await test.step('one', async () => {})
          await test.step('two', async () => {})
        })
      `,
    })
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].tests[0].name).toBe('first')
    expect(body[0].tests[0].steps.map((s: { label: string }) => s.label)).toEqual(['one', 'two'])
  })

  it('returns [] when feature has no e2e dir', async () => {
    writeFeature('alpha')
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.json()).toEqual([])
  })

  it('404s on unknown feature', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/missing/tests' })
    expect(res.statusCode).toBe(404)
  })

  it('handles a feature with a malformed spec gracefully', async () => {
    const dir = writeFeature('alpha', { spec: '???? not really typescript ::' })
    expect(fs.existsSync(path.join(dir, 'e2e', 'a.spec.ts'))).toBe(true)
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/features/alpha/tests' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveLength(1)
    expect(body[0].tests).toEqual([])
  })
})
