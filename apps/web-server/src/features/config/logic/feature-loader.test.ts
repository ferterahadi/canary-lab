import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadFeatures, listSpecFiles } from './feature-loader'

let tmpDir: string

function writeFeature(name: string, body: string): string {
  const dir = path.join(tmpDir, 'features', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), body)
  return dir
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fl-')))
})

describe('loadFeatures', () => {
  it('returns [] when features dir missing', () => {
    expect(loadFeatures(path.join(tmpDir, 'nope'))).toEqual([])
  })

  it('loads valid feature configs', () => {
    const fdir = writeFeature(
      'alpha',
      `module.exports = { config: { name: 'alpha', description: 'd', envs: ['local'], featureDir: __dirname } }`,
    )
    const features = loadFeatures(path.join(tmpDir, 'features'))
    expect(features).toHaveLength(1)
    expect(features[0].name).toBe('alpha')
    expect(features[0].featureDir).toBe(fdir)
  })

  it('skips dirs without a feature.config.* file', () => {
    fs.mkdirSync(path.join(tmpDir, 'features', 'empty'), { recursive: true })
    expect(loadFeatures(path.join(tmpDir, 'features'))).toEqual([])
  })

  it('skips configs that throw on require', () => {
    writeFeature('boom', `throw new Error('nope')`)
    expect(loadFeatures(path.join(tmpDir, 'features'))).toEqual([])
  })

  it('skips configs whose export has no name', () => {
    writeFeature('weird', `module.exports = { config: { description: 'no name' } }`)
    expect(loadFeatures(path.join(tmpDir, 'features'))).toEqual([])
  })

  it('rethrows validation errors for invalid healthCheck', () => {
    writeFeature(
      'broken-hc',
      `module.exports = { config: {
        name: 'broken-hc',
        description: 'd',
        envs: [],
        featureDir: __dirname,
        repos: [{ name: 'r', localPath: __dirname, startCommands: [{ name: 'svc', command: 'echo', healthCheck: { type: 'http' } }] }],
      } }`,
    )
    expect(() => loadFeatures(path.join(tmpDir, 'features'))).toThrow(/healthCheck/)
  })

  it('defaults healOnFailureThreshold to 2 when the config omits it', () => {
    writeFeature(
      'no-threshold',
      `module.exports = { config: { name: 'no-threshold', description: 'd', envs: ['local'], featureDir: __dirname } }`,
    )
    const features = loadFeatures(path.join(tmpDir, 'features'))
    expect(features[0].healOnFailureThreshold).toBe(2)
  })

  it('preserves an explicit 0 (opt out of mid-run heal)', () => {
    writeFeature(
      'opt-out',
      `module.exports = { config: { name: 'opt-out', description: 'd', envs: ['local'], featureDir: __dirname, healOnFailureThreshold: 0 } }`,
    )
    const features = loadFeatures(path.join(tmpDir, 'features'))
    expect(features[0].healOnFailureThreshold).toBe(0)
  })

  it('preserves an explicit non-default threshold', () => {
    writeFeature(
      'explicit',
      `module.exports = { config: { name: 'explicit', description: 'd', envs: ['local'], featureDir: __dirname, healOnFailureThreshold: 5 } }`,
    )
    const features = loadFeatures(path.join(tmpDir, 'features'))
    expect(features[0].healOnFailureThreshold).toBe(5)
  })

  it('accepts default export shape', () => {
    writeFeature(
      'beta',
      `module.exports.default = { name: 'beta', description: 'd', envs: [], featureDir: __dirname }`,
    )
    const features = loadFeatures(path.join(tmpDir, 'features'))
    expect(features.map((f) => f.name)).toEqual(['beta'])
  })
})

describe('listSpecFiles', () => {
  it('returns [] when e2e dir is missing', () => {
    expect(listSpecFiles(tmpDir)).toEqual([])
  })

  it('returns sorted .spec.ts files only', () => {
    const e2e = path.join(tmpDir, 'e2e')
    fs.mkdirSync(e2e, { recursive: true })
    fs.writeFileSync(path.join(e2e, 'b.spec.ts'), '')
    fs.writeFileSync(path.join(e2e, 'a.spec.ts'), '')
    fs.writeFileSync(path.join(e2e, 'helper.ts'), '')
    fs.mkdirSync(path.join(e2e, 'sub'))
    const files = listSpecFiles(tmpDir).map((f) => path.basename(f))
    expect(files).toEqual(['a.spec.ts', 'b.spec.ts'])
  })
})
