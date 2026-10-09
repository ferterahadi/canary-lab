import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { stripPortSlots, revertPortification } from './unportify'
import { writeOverlay, overlayDir } from './overlay'
import { readFeatureConfig } from '../../../../shared/config-ast'
import type { ConfigValue } from '../../../../../../../shared/config-value'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('unportify-')

let tmpDir: string
beforeEach(() => {
  tmpDir = tempDir()
})

// ─── stripPortSlots ──────────────────────────────────────────────────────────

describe('stripPortSlots', () => {
  it('returns null for non-object values', () => {
    expect(stripPortSlots(null)).toBeNull()
    // `undefined` is outside ConfigValue's contract (it mirrors JSON, which has
    // no `undefined`) but the guard is defensive against a JS caller passing one
    // anyway — exercise it explicitly with a cast past the type.
    expect(stripPortSlots(undefined as unknown as ConfigValue)).toBeNull()
    expect(stripPortSlots('string')).toBeNull()
    expect(stripPortSlots([])).toBeNull()
  })

  it('returns null when repos is not an array', () => {
    expect(stripPortSlots({ repos: 'not-array' })).toBeNull()
    expect(stripPortSlots({ name: 'feat' })).toBeNull()
  })

  it('returns null when no repos have ports to strip', () => {
    const config = {
      repos: [{ name: 'app', startCommands: [{ command: 'npm start' }] }],
    }
    expect(stripPortSlots(config)).toBeNull()
  })

  it('strips ports from a startCommand and returns the modified config', () => {
    const config = {
      repos: [{ name: 'app', startCommands: [{ command: 'npm start', ports: [{ name: 'api', env: 'PORT' }] }] }],
    }
    const result = stripPortSlots(config)
    expect(result).not.toBeNull()
    const repos = (result as any).repos
    expect(repos[0].startCommands[0]).not.toHaveProperty('ports')
    expect(repos[0].startCommands[0].command).toBe('npm start')
  })

  it('skips non-object repos entries', () => {
    const config = {
      repos: [null, 'string', { name: 'app', startCommands: [{ ports: [{}] }] }],
    }
    const result = stripPortSlots(config)
    expect(result).not.toBeNull()
  })

  it('skips repos where startCommands is not an array', () => {
    const config = {
      repos: [{ name: 'app', startCommands: 'not-array' }],
    }
    expect(stripPortSlots(config)).toBeNull()
  })
})

// ─── revertPortification ─────────────────────────────────────────────────────

const CONFIG_CONTENT = `const config = { name: 'feat', description: 'd', envs: ['local'], repos: [{ name: 'app', localPath: '.', startCommands: [{ command: 'node server.js' }] }] }
module.exports = { config }
`

const PORTIFIED_CONFIG = `const config = { name: 'feat', description: 'd', envs: ['local'], repos: [{ name: 'app', localPath: '.', startCommands: [{ command: 'node server.js', ports: [{ name: 'api', env: 'PORT' }] }] }] }
module.exports = { config }
`

const OVERLAY_INPUT = {
  featureName: 'feat',
  agent: 'claude' as const,
  capturedAt: '2026-01-01T00:00:00Z',
  repos: [],
}

describe('revertPortification', () => {
  it('restores from snapshot when overlay has an original-config backup', () => {
    fs.mkdirSync(path.join(tmpDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'feature.config.cjs'), PORTIFIED_CONFIG)
    writeOverlay(tmpDir, { ...OVERLAY_INPUT, originalConfig: CONFIG_CONTENT })
    const { reverted } = revertPortification(tmpDir)
    expect(reverted).toBe(true)
    expect(fs.readFileSync(path.join(tmpDir, 'feature.config.cjs'), 'utf-8')).toBe(CONFIG_CONTENT)
    expect(fs.existsSync(overlayDir(tmpDir))).toBe(false)
  })

  it('strips port slots when there is no snapshot (legacy overlay)', () => {
    fs.writeFileSync(path.join(tmpDir, 'feature.config.cjs'), PORTIFIED_CONFIG)
    writeOverlay(tmpDir, { ...OVERLAY_INPUT, originalConfig: null })
    const { reverted } = revertPortification(tmpDir)
    expect(reverted).toBe(true)
    const content = fs.readFileSync(path.join(tmpDir, 'feature.config.cjs'), 'utf-8')
    expect(content).not.toContain('ports:')
  })

  it('returns reverted=false when no feature config file exists', () => {
    writeOverlay(tmpDir, { ...OVERLAY_INPUT, originalConfig: null })
    const { reverted } = revertPortification(tmpDir)
    expect(reverted).toBe(false)
    expect(fs.existsSync(overlayDir(tmpDir))).toBe(false)
  })

  it('returns reverted=false when config has no ports to strip and no snapshot', () => {
    fs.writeFileSync(path.join(tmpDir, 'feature.config.cjs'), CONFIG_CONTENT)
    writeOverlay(tmpDir, { ...OVERLAY_INPUT, originalConfig: null })
    const { reverted } = revertPortification(tmpDir)
    expect(reverted).toBe(false)
  })
})

it.each([{ envs: [] }, { envs: ['staging'] }, { envs: ['staging', 'dev'] }])('restores snapshot settings with current environments $envs', ({ envs }) => {
  const config = path.join(tmpDir, 'feature.config.cjs')
  const original = '// Keep the app settings\n' + CONFIG_CONTENT
  fs.writeFileSync(config, PORTIFIED_CONFIG)
  for (const env of envs) fs.mkdirSync(path.join(tmpDir, 'envsets', env), { recursive: true })
  writeOverlay(tmpDir, { ...OVERLAY_INPUT, originalConfig: original })
  expect(revertPortification(tmpDir)).toEqual({ reverted: true })
  const source = fs.readFileSync(config, 'utf8')
  expect(source).toContain('// Keep the app settings')
  expect(readFeatureConfig(source).value).toEqual({ ...readFeatureConfig(original).value, envs: [...envs].sort() })
  expect(fs.existsSync(overlayDir(tmpDir))).toBe(false)
})

it('retains the backup when environment discovery fails and permits a corrected retry', () => {
  const config = path.join(tmpDir, 'feature.config.cjs')
  fs.writeFileSync(config, PORTIFIED_CONFIG)
  writeOverlay(tmpDir, { ...OVERLAY_INPUT, originalConfig: CONFIG_CONTENT })
  const envsets = path.join(tmpDir, 'envsets')
  fs.writeFileSync(envsets, 'not a directory')
  expect(() => revertPortification(tmpDir)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
  expect(fs.existsSync(overlayDir(tmpDir))).toBe(true)
  // No rollback: the snapshot was restored, but its backup remains for retry.
  expect(fs.readFileSync(config, 'utf8')).toBe(CONFIG_CONTENT)
  fs.rmSync(envsets)
  expect(revertPortification(tmpDir)).toEqual({ reverted: true })
  expect(readFeatureConfig(fs.readFileSync(config, 'utf8')).value.envs).toEqual([])
  expect(fs.existsSync(overlayDir(tmpDir))).toBe(false)
})
