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

  it('refuses an unknown suite and an unknown repair id with their HTTP status', async () => {
    expect(() => service.start('missing', owner)).toThrow('Feature not found')
    expect(() => service.get(`dr_${'0'.repeat(24)}`)).toThrow('Discovery repair not found')
  })

  it('hides a row whose record file is gone rather than listing an unopenable repair', async () => {
    const repair = service.start('suite', owner)
    await service.settled()
    fs.rmSync(path.join(service.store.recordDir(repair.id), 'repair.json'))
    expect(service.store.list()).toHaveLength(1)
    expect(service.list('suite')).toEqual([])
  })

  it('publishes nothing for a removed repair — the record the event names is already gone', async () => {
    const workspaceEvents = new WorkspaceEventBus()
    service = new DiscoveryRepairService({ projectRoot: root, featuresDir: path.join(root, 'features'), logsDir: path.join(root, 'logs'), listTests, workspaceEvents })
    const repair = service.start('suite', owner)
    await service.settled()
    const publish = vi.spyOn(workspaceEvents, 'publish')
    service.store.remove(repair.id)
    expect(publish).not.toHaveBeenCalled()
  })

  it('reports a rejection that is not an Error by its string form', async () => {
    listTests.mockRejectedValue('discovery exited 137')
    const repair = service.start('suite', owner)
    await service.settled()
    expect(service.get(repair.id)).toMatchObject({ status: 'failed', diagnostic: 'discovery exited 137' })
  })

  it('surfaces a repair deleted mid-flight through settled() instead of an unhandled rejection', async () => {
    let fail: (err: Error) => void = () => {}
    listTests.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    const repair = service.start('suite', owner)
    // The failure handler re-reads the record to write the diagnostic onto it;
    // with the record gone there is nothing to write, so the rejection has to
    // reach the caller rather than being swallowed into a lost repair.
    service.store.remove(repair.id)
    fail(new Error('discovery crashed'))
    await expect(service.settled()).rejects.toThrow('Discovery repair not found')
  })

  it('treats an empty roster at first discovery as the diagnostic to repair, not a success', async () => {
    listTests.mockResolvedValue([])
    const repair = service.start('suite', owner)
    await service.settled()
    expect(service.get(repair.id)).toMatchObject({ status: 'repairing', diagnostic: 'Discovery returned no test cases. Restore the complete suite.' })
    expect(fs.readFileSync(repair.promptPath, 'utf8')).toContain('Discovery returned no test cases')
  })

  it('falls back to a generic reason when discovery fails without saying why', async () => {
    const repair = service.start('suite', owner)
    await service.settled()
    listTests.mockResolvedValue(null)
    service.update(repair.id, 'owner', 'verify')
    await service.settled()
    expect(service.get(repair.id).diagnostic).toBe('Playwright could not enumerate the test cases')
  })

  it('ignores an owner report once the repair has settled or is already being verified', async () => {
    const settledRepair = service.start('suite', owner)
    await service.settled()
    service.update(settledRepair.id, 'owner', 'blocked')
    expect(service.get(settledRepair.id)).toMatchObject({ status: 'failed', diagnostic: 'External repair stopped; inspect its activity.' })
    expect(service.update(settledRepair.id, 'owner', 'progress', 'still going').message).not.toBe('still going')

    const next = service.start('suite', owner)
    await service.settled()
    listTests.mockResolvedValue(tests)
    expect(service.update(next.id, 'owner', 'verify').status).toBe('verifying')
    expect(service.update(next.id, 'owner', 'progress', 'one more edit').message).toBe('Canary is verifying discovery')
    await service.settled()
  })

  it('refuses an owner report made before the repair instructions exist', async () => {
    let finish: (value: null) => void = () => {}
    listTests.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const repair = service.start('suite', owner)
    expect(() => service.update(repair.id, 'owner', 'progress', 'already editing')).toThrow('Discovery is still being inspected')
    finish(null)
    await service.settled()
  })

  it('accepts a repeat repair whose roster still holds every recorded case', async () => {
    listTests.mockResolvedValue(tests)
    const first = service.start('suite', owner)
    await service.settled()
    expect(service.get(first.id).status).toBe('succeeded')
    const second = service.start('suite', owner)
    await service.settled()
    expect(service.get(second.id)).toMatchObject({ status: 'succeeded', discoveredCount: 1 })
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
