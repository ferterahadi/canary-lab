import type { WorkspaceEvent } from '../../../../../../shared/workspace-events'
import fs from 'fs'
import path from 'path'
import { beforeEach, expect, it } from 'vitest'
import { readFeatureConfig } from '../../../shared/config-ast'

import { removeFeaturePortification } from './remove-portification'
import { overlayDir, overlayExists, writeOverlay } from './runtime/overlay'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-remove-portification-')

let root: string
let featuresDir: string
let suite: string
let config: string
let events: WorkspaceEvent[]
const change = { type: 'features-changed' }
const source = (name = 'checkout') => `module.exports = { config: { name: '${name}', envs: ['local'], repos: [], featureDir: __dirname } }`
const portified = "module.exports = { config: { name: 'checkout', envs: ['local'], featureDir: __dirname, repos: [{ name: 'app', startCommands: [{ command: 'node app.js', ports: [{ name: 'http', env: 'PORT' }] }] }] } }"
const publish = (event: WorkspaceEvent) => { events.push(event) }
const remove = (name = 'checkout') => removeFeaturePortification({ featuresDir, workspaceEvents: { publish } }, name)
function overlay(snapshot: string | null) {
  writeOverlay(suite, { featureName: 'checkout', agent: 'claude', capturedAt: '2026-01-01T00:00:00Z', repos: [{ name: 'app', baseSha: 'fixture', patch: '', touchedFiles: [] }], originalConfig: snapshot })
}
beforeEach(() => {
  root = tempDir()
  featuresDir = path.join(root, 'features')
  suite = path.join(featuresDir, 'checkout')
  fs.mkdirSync(path.join(suite, 'envsets', 'staging'), { recursive: true })
  config = path.join(suite, 'feature.config.cjs')
  fs.writeFileSync(config, portified)
  events = []
})

it('restores snapshot settings using current environments and announces every successful call once', () => {
  overlay(source())
  expect(remove()).toEqual({ ok: true, value: { name: 'checkout', portified: false, reverted: true } })
  expect(readFeatureConfig(fs.readFileSync(config, 'utf8')).value.envs).toEqual(['staging'])
  expect(overlayExists(suite)).toBe(false)
  expect(events).toEqual([change])
  expect(remove()).toEqual({ ok: true, value: { name: 'checkout', portified: false, reverted: false } })
  expect(events).toEqual([change, change])
})

it('strips legacy port slots without changing the current environment declarations', () => {
  overlay(null)
  expect(remove()).toEqual({ ok: true, value: { name: 'checkout', portified: false, reverted: true } })
  expect(fs.readFileSync(config, 'utf8')).not.toContain('ports:')
  expect(readFeatureConfig(fs.readFileSync(config, 'utf8')).value.envs).toEqual(['local'])
  expect(events).toEqual([change])
})

it('refuses missing suites and suites without a directory without touching an existing overlay', () => {
  overlay(source())
  const refusal = { ok: false, statusCode: 404, error: 'feature not found' }
  expect(remove('missing')).toEqual(refusal)
  fs.writeFileSync(config, "module.exports = { config: { name: 'checkout', repos: [] } }")
  const bytes = fs.readFileSync(config, 'utf8')
  expect(remove()).toEqual(refusal)
  expect(fs.readFileSync(config, 'utf8')).toBe(bytes)
  expect(overlayExists(suite)).toBe(true)
  expect(events).toEqual([])
})

it('resolves a renamed suite by its declared name and works without an event publisher', () => {
  fs.writeFileSync(config, source('renamed'))
  overlay(source('renamed'))
  expect(removeFeaturePortification({ featuresDir }, 'renamed')).toEqual({ ok: true, value: { name: 'renamed', portified: false, reverted: true } })
  expect(overlayExists(suite)).toBe(false)
  expect(events).toEqual([])
})

it('preserves configured linked-suite directory handling', () => {
  const linked = path.join(root, 'linked-suite')
  fs.renameSync(suite, linked)
  fs.mkdirSync(suite)
  fs.writeFileSync(config, `module.exports = { config: { name: 'checkout', featureDir: ${JSON.stringify(linked)}, repos: [] } }`)
  suite = linked
  overlay(source())
  expect(remove()).toMatchObject({ ok: true, value: { name: 'checkout', portified: false, reverted: true } })
  expect(readFeatureConfig(fs.readFileSync(path.join(linked, 'feature.config.cjs'), 'utf8')).value.envs).toEqual(['staging'])
  expect(events).toEqual([change])
})

it('propagates synchronization failures without an event and keeps the snapshot for retry', () => {
  overlay(source())
  fs.rmSync(path.join(suite, 'envsets'), { recursive: true })
  fs.writeFileSync(path.join(suite, 'envsets'), 'not a directory')
  expect(() => remove()).toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
  expect(overlayExists(suite)).toBe(true)
  expect(events).toEqual([])
  fs.rmSync(path.join(suite, 'envsets'))
  expect(remove()).toMatchObject({ ok: true, value: { reverted: true } })
  expect(readFeatureConfig(fs.readFileSync(config, 'utf8')).value.envs).toEqual([])
  expect(events).toEqual([change])
})

it('retains legacy best-effort success when writing the config is refused', () => {
  overlay(null)
  fs.chmodSync(config, 0o444)
  try {
    expect(remove()).toEqual({ ok: true, value: { name: 'checkout', portified: false, reverted: false } })
    expect(fs.readFileSync(config, 'utf8')).toBe(portified)
    expect(events).toEqual([change])
  } finally { fs.chmodSync(config, 0o644) }
})

it('reports the actual overlay status when best-effort overlay removal cannot finish', () => {
  fs.writeFileSync(config, source())
  overlay(null)
  fs.chmodSync(overlayDir(suite), 0o555)
  try {
    expect(remove()).toEqual({ ok: true, value: { name: 'checkout', portified: true, reverted: false } })
    expect(overlayExists(suite)).toBe(true)
    expect(events).toEqual([change])
  } finally { fs.chmodSync(overlayDir(suite), 0o755) }
})
