import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { stripPortSlots, revertPortification } from './unportify'
import { writeOverlay, overlayDir } from './overlay'

let tmpDir: string
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unportify-')))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── stripPortSlots ──────────────────────────────────────────────────────────

describe('stripPortSlots', () => {
  it('returns null for non-object values', () => {
    expect(stripPortSlots(null)).toBeNull()
    expect(stripPortSlots(undefined)).toBeNull()
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
