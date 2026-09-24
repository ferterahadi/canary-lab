import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoveryRepairStore } from './discovery-repair-store'
import type { DiscoveryRepair, DiscoveryRepairOwner } from '../../../../../../shared/discovery-repair'

// The store's own wiring, driven directly: which records a restart writes off,
// and that a suite rename carries its repair history along. The repair
// lifecycle is `discovery-repair-service.test.ts`.

let logsDir: string

function record(id: string, over: Partial<DiscoveryRepair> = {}): DiscoveryRepair {
  const now = '2026-09-10T00:00:00.000Z'
  const internal: DiscoveryRepairOwner = { kind: 'internal', agent: 'claude' }
  return {
    id,
    feature: 'checkout',
    featureDir: path.join(logsDir, '..', 'features', 'checkout'),
    status: 'repairing',
    owner: internal,
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    message: 'Repairing discovery',
    diagnostic: '',
    log: [],
    promptPath: path.join(logsDir, 'discovery-repairs', id, 'prompt.md'),
    ...over,
  }
}

function save(rec: DiscoveryRepair): DiscoveryRepair {
  discoveryRepairStore(logsDir).save(rec)
  return rec
}

beforeEach(() => {
  // A fresh directory per test: the module memoizes one store per resolved
  // logsDir, so a shared path would carry records between tests.
  logsDir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-store-'))), 'logs')
})
afterEach(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }))

describe('discoveryRepairStore', () => {
  it('hands the same instance back for the same logs directory, so every caller shares one listener set', () => {
    expect(discoveryRepairStore(logsDir)).toBe(discoveryRepairStore(path.join(logsDir, '.', '')))
  })

  it('writes off a restart-orphaned repair — Canary\'s own agent is gone, and a claim with no instructions was never handed over', () => {
    const store = discoveryRepairStore(logsDir)
    save(record('dr_internal'))
    save(record('dr_verifying', { status: 'verifying', owner: { kind: 'external', clientKind: 'codex', sessionId: 'owner' } }))
    save(record('dr_no_prompt', { owner: { kind: 'external', clientKind: 'codex', sessionId: 'owner' } }))

    store.reconcileInterrupted(() => '2026-09-10T01:00:00.000Z')

    for (const id of ['dr_internal', 'dr_verifying', 'dr_no_prompt']) {
      expect(store.get(id)).toMatchObject({
        id,
        status: 'failed',
        endedAt: '2026-09-10T01:00:00.000Z',
        message: 'Repair interrupted by server restart',
        diagnostic: expect.stringContaining('Resume repair to verify the current files.'),
      })
    }
  })

  it('leaves an external repair whose instructions are on disk alone — a lost heartbeat is not evidence its editor stopped', () => {
    const store = discoveryRepairStore(logsDir)
    const rec = save(record('dr_external', { owner: { kind: 'external', clientKind: 'codex', sessionId: 'owner' } }))
    fs.writeFileSync(rec.promptPath, 'Fix test discovery.')

    store.reconcileInterrupted(() => '2026-09-10T01:00:00.000Z')

    expect(store.get('dr_external')?.status).toBe('repairing')
  })

  it('carries a suite rename into the repair history so the record still resolves under the new name', () => {
    const store = discoveryRepairStore(logsDir)
    save(record('dr_one', { status: 'succeeded' }))
    save(record('dr_other', { status: 'succeeded', feature: 'billing' }))

    expect(store.renameFeature('checkout', 'storefront')).toBe(1)
    expect(store.get('dr_one')?.feature).toBe('storefront')
    expect(store.get('dr_other')?.feature).toBe('billing')
    expect(store.list().map((e) => e.feature)).toContain('storefront')
  })
})
