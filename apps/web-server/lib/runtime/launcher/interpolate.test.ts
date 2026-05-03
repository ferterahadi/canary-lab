import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { interpolateConfigTokens, interpolateFeatureTokens, makeTokenCache } from './interpolate'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interp-'))
  fs.mkdirSync(path.join(dir, 'local'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'local', 'api'), 'PORT=3030\nHOST=api.local\n')
  fs.mkdirSync(path.join(dir, 'prod'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'prod', 'api'), 'PORT=8080\nHOST=api.prod\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('interpolateFeatureTokens', () => {
  it('substitutes a single token', () => {
    expect(interpolateFeatureTokens('http://${api.HOST}', { envName: 'local', envsetsDir: dir }))
      .toBe('http://api.local')
  })

  it('substitutes multiple tokens', () => {
    expect(interpolateFeatureTokens('${api.HOST}:${api.PORT}', { envName: 'local', envsetsDir: dir }))
      .toBe('api.local:3030')
  })

  it('switches values by env', () => {
    expect(interpolateFeatureTokens('http://${api.HOST}:${api.PORT}', { envName: 'prod', envsetsDir: dir }))
      .toBe('http://api.prod:8080')
  })

  it('leaves token literal when slot file is missing', () => {
    expect(interpolateFeatureTokens('${ghost.X}', { envName: 'local', envsetsDir: dir }))
      .toBe('${ghost.X}')
  })

  it('leaves token literal when key is missing', () => {
    expect(interpolateFeatureTokens('${api.MISSING}', { envName: 'local', envsetsDir: dir }))
      .toBe('${api.MISSING}')
  })

  it('returns value unchanged when no env is selected', () => {
    expect(interpolateFeatureTokens('${api.PORT}', { envName: undefined, envsetsDir: dir }))
      .toBe('${api.PORT}')
  })

  it('early-exits on values without ${', () => {
    expect(interpolateFeatureTokens('http://localhost:3000', { envName: 'local', envsetsDir: dir }))
      .toBe('http://localhost:3000')
  })

  it('caches slot reads across calls', () => {
    const cache = makeTokenCache()
    const ctx = { envName: 'local', envsetsDir: dir }
    expect(interpolateFeatureTokens('${api.PORT}', ctx, cache)).toBe('3030')
    fs.writeFileSync(path.join(dir, 'local', 'api'), 'PORT=9999\n')
    // Second call uses the cached map, not the new file content.
    expect(interpolateFeatureTokens('${api.PORT}', ctx, cache)).toBe('3030')
  })
})

describe('interpolateConfigTokens', () => {
  const ctx = () => ({ envName: 'local', envsetsDir: dir })

  it('walks nested objects and arrays', () => {
    const node = {
      command: 'npm start',
      healthCheck: { http: { url: 'http://${api.HOST}:${api.PORT}' } },
      env: ['HOST=${api.HOST}', 'STATIC=value'],
      port: 3000,
      enabled: true,
      meta: null,
    }
    const out = interpolateConfigTokens(node, ctx())
    expect(out).toEqual({
      command: 'npm start',
      healthCheck: { http: { url: 'http://api.local:3030' } },
      env: ['HOST=api.local', 'STATIC=value'],
      port: 3000,
      enabled: true,
      meta: null,
    })
  })

  it('returns primitives unchanged', () => {
    expect(interpolateConfigTokens(42, ctx())).toBe(42)
    expect(interpolateConfigTokens(null, ctx())).toBe(null)
    expect(interpolateConfigTokens(undefined as unknown, ctx())).toBe(undefined)
  })
})
