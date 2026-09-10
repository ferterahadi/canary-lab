import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscoveryRepairService } from './discovery-repair-service'
import { listPlaywrightTests } from '../../runs/logic/playwright-list'
import { runDiscoveryRepairAgent } from './discovery-repair-agent'

// The production wiring, with only the two out-of-process edges faked: the
// Playwright `--list` subprocess and the repair agent. Every other test in this
// feature injects `listTests`/`runAgent`, which is what a caller would do — so
// the defaults those seams fall back to are only exercised here, and this is
// also the only place the envset warning reaches Canary's diagnostic.
vi.mock('../../runs/logic/playwright-list', () => ({ listPlaywrightTests: vi.fn(async () => null) }))
vi.mock('./discovery-repair-agent', () => ({ runDiscoveryRepairAgent: vi.fn(async () => {}) }))

let root: string
let featureDir: string
let service: DiscoveryRepairService

beforeEach(() => {
  // realpath: `feature.config.cjs` reports `__dirname`, which on macOS resolves
  // the /var → /private/var symlink, and the assertions compare that path.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-repair-defaults-')))
  featureDir = path.join(root, 'features', 'suite')
  fs.mkdirSync(path.join(featureDir, 'envsets'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports = { config: { name: 'suite', featureDir: __dirname, repos: [], envs: ['local'] } }")
  // Parses, but declares neither `feature.slots` nor `slots`, which is what
  // makes the env loader warn instead of throwing.
  fs.writeFileSync(path.join(featureDir, 'envsets', 'envsets.config.json'), '{}')
  service = new DiscoveryRepairService({ projectRoot: root, featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs') })
  vi.mocked(listPlaywrightTests).mockClear()
  vi.mocked(runDiscoveryRepairAgent).mockClear()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('discovery repair without injected seams', () => {
  it('lists through Playwright itself, uncached, and reports a broken envset as the diagnostic to fix', async () => {
    const repair = service.start('suite', { kind: 'external', clientKind: 'codex', sessionId: 'owner' })
    await service.settled()
    expect(vi.mocked(listPlaywrightTests).mock.calls[0]?.[0]).toBe(featureDir)
    expect(vi.mocked(listPlaywrightTests).mock.calls[0]?.[1]).toMatchObject({ fresh: true })
    expect(service.get(repair.id).diagnostic).toContain('envsets.config.json is missing required feature.slots')
    expect(fs.readFileSync(repair.promptPath, 'utf8')).toContain('envsets.config.json')
  })

  it('hands an internal repair to the real agent entry point', async () => {
    service.start('suite', { kind: 'internal', agent: 'claude' })
    await service.settled()
    expect(vi.mocked(runDiscoveryRepairAgent)).toHaveBeenCalledOnce()
    expect(vi.mocked(runDiscoveryRepairAgent).mock.calls[0]?.[1]).toBe(root)
  })
})
