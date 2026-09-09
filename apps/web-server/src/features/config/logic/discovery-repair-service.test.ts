import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscoveryRepairService } from './discovery-repair-service'
import { WorkspaceEventBus } from '../../../shared/workspace-events'
import type { DiscoveryRepairOwner } from '../../../../../../shared/discovery-repair'
import type { runDiscoveryRepairAgent } from './discovery-repair-agent'
import type { FeatureConfig } from '../../../../../../shared/launcher/types'
import type { PlaywrightListEntry } from '../../runs/logic/playwright-list'

let root: string
let service: DiscoveryRepairService
let listTests: ReturnType<typeof vi.fn<(feature: FeatureConfig, diagnostic: (message: string) => void) => Promise<PlaywrightListEntry[] | null>>>
const owner: DiscoveryRepairOwner = { kind: 'external', clientKind: 'codex', sessionId: 'owner' }
const tests = [{ file: '/spec.ts', line: 1, title: 'preserved case', originFile: '/spec.ts', originLine: 1 }]
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-repair-'))
  const dir = path.join(root, 'features', 'suite')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.config.cjs'), "module.exports = { config: { name: 'suite', featureDir: __dirname, repos: [], envs: [] } }")
  listTests = vi.fn(async (_feature: FeatureConfig, diagnostic: (message: string) => void): Promise<PlaywrightListEntry[] | null> => { diagnostic('missing fixture'); return null })
  service = new DiscoveryRepairService({ projectRoot: root, featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs'), listTests })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('discovery repair lifecycle', () => {
  it('reserves one owner before async discovery, records progress, and only Canary can verify success', async () => {
    const repair = service.start('suite', owner)
    expect(service.start('suite', owner).id).toBe(repair.id)
    expect(() => service.start('suite', { ...owner, sessionId: 'other' })).toThrow('Another agent')
    await service.settled()
    expect(fs.readFileSync(repair.promptPath, 'utf8')).toContain('missing fixture')
    expect(() => service.update(repair.id, 'other', 'verify')).toThrow('does not own')
    service.update(repair.id, 'owner', 'progress', 'Moved the runtime read into setup')
    expect(service.get(repair.id).log.join('\n')).toContain('Moved the runtime read')
    expect(service.get(repair.id).status).toBe('repairing')
    listTests.mockResolvedValue(tests)
    expect(service.update(repair.id, 'owner', 'verify').status).toBe('verifying')
    await service.settled()
    expect(service.get(repair.id)).toMatchObject({ status: 'succeeded', discoveredCount: 1 })
    expect(fs.existsSync(path.join(service.store.recordDir(repair.id), 'discovered-tests.json'))).toBe(true)
  })

  it('returns to failed on verification errors and empty rosters; retry preserves the old attempt', async () => {
    const repair = service.start('suite', owner)
    await service.settled()
    service.update(repair.id, 'owner', 'verify')
    await service.settled()
    expect(service.get(repair.id)).toMatchObject({ status: 'failed', diagnostic: 'missing fixture' })
    const retry = service.start('suite', owner)
    await service.settled()
    listTests.mockResolvedValue([])
    service.update(retry.id, 'owner', 'verify')
    await service.settled()
    expect(service.get(retry.id).status).toBe('failed')
    expect(service.list('suite')).toHaveLength(2)
  })

  it('keeps external ownership after restart and only releases on its explicit stopped/blocked report', async () => {
    const repair = service.start('suite', owner)
    await service.settled()
    service.store.reconcileInterrupted(() => new Date().toISOString())
    expect(service.get(repair.id).status).toBe('repairing')
    service.update(repair.id, 'owner', 'blocked', 'Stopped editing: saved envset missing')
    expect(service.get(repair.id).status).toBe('failed')
    expect(service.start('suite', { ...owner, sessionId: 'next' }).id).not.toBe(repair.id)
    await service.settled()
  })

  it('does not treat an internal agent exit as a successful repair', async () => {
    const runAgent = vi.fn<typeof runDiscoveryRepairAgent>(async (_repair, _root, onSession) => { onSession({ agent: 'claude', sessionId: 'session' }) })
    service = new DiscoveryRepairService({ projectRoot: root, featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs'), listTests, runAgent })
    const repair = service.start('suite', { kind: 'internal', agent: 'claude' })
    await service.settled()
    expect(runAgent).toHaveBeenCalledOnce()
    expect(service.get(repair.id)).toMatchObject({ status: 'failed', sessionRef: { sessionId: 'session' } })
    expect(listTests).toHaveBeenCalledTimes(2)
  })

  it('rejects a smaller roster when a previous complete repair roster exists', async () => {
    listTests.mockResolvedValue([...tests, { ...tests[0], title: 'second case' }])
    const first = service.start('suite', owner)
    await service.settled()
    expect(service.get(first.id).status).toBe('succeeded')
    listTests.mockResolvedValue(tests)
    const second = service.start('suite', owner)
    await service.settled()
    expect(service.get(second.id).status).toBe('repairing')
    service.update(second.id, 'owner', 'verify')
    await service.settled()
    expect(service.get(second.id)).toMatchObject({ status: 'failed', diagnostic: expect.stringContaining('second case') })
  })

  it('publishes lifecycle updates and a tests event only after verified discovery', async () => {
    const workspaceEvents = new WorkspaceEventBus()
    const publish = vi.spyOn(workspaceEvents, 'publish')
    service = new DiscoveryRepairService({ projectRoot: root, featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs'), listTests, workspaceEvents })
    const repair = service.start('suite', owner)
    await service.settled()
    expect(publish).not.toHaveBeenCalledWith({ type: 'tests-changed', feature: 'suite' })
    listTests.mockResolvedValue(tests)
    service.update(repair.id, 'owner', 'verify')
    await service.settled()
    expect(publish).toHaveBeenCalledWith({ type: 'tests-changed', feature: 'suite' })
    expect(() => service.get('../secret')).toThrow('Invalid repair id')
  })
})
