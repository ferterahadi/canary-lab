import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PortifyRunStore } from '../../../../../web-server/src/features/portify/logic/runtime/store'
import type { PortifyManifest } from '../../../../../web-server/src/features/portify/logic/runtime/types'
import { portifyIndex } from './portify-state'

const { reducer: portifyReducer, initialState: initialPortifyState } = portifyIndex

let logs: string
beforeEach(() => { logs = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-index-parity-')) })
afterEach(() => { fs.rmSync(logs, { recursive: true, force: true }) })

function manifest(overrides: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'workflow-1', feature: 'checkout', featureDir: 'features/checkout',
    repos: [], agent: 'claude', branch: 'portify/scratch', status: 'editing',
    attempt: 1, maxAttempts: 3, startedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

it('keeps file-backed rows identical to snapshots and updates, including external metadata and completion', () => {
  const store = new PortifyRunStore(logs)
  const active = manifest({ producer: 'external' })
  store.save(active)
  let browser = portifyReducer(initialPortifyState, { type: 'snapshot', workflows: store.list(), details: {} })
  expect(browser.workflows[0]).toEqual({
    workflowId: active.workflowId, feature: active.feature, branch: 'portify/scratch',
    status: 'editing', startedAt: active.startedAt, producer: 'external',
  })
  for (const next of [active, { ...active, status: 'saved' as const, endedAt: '2026-01-01T00:01:00.000Z' }]) {
    store.save(next)
    browser = portifyReducer(browser, { type: 'update', workflowId: next.workflowId, manifest: next })
    expect(browser.workflows).toEqual(store.list())
    expect(browser.workflows[0].branch).toBe('portify/scratch')
    expect(browser.workflows[0].producer).toBe('external')
  }
  expect(browser.workflows[0].endedAt).toBe('2026-01-01T00:01:00.000Z')
  // The comparison reads the physical index through a fresh store instance.
  expect(new PortifyRunStore(logs).list()).toEqual(browser.workflows)
})

it.each([undefined, ''])('preserves legacy optional omissions and branch %s', (branch) => {
  const store = new PortifyRunStore(logs)
  const record = manifest({ branch, endedAt: '' })
  store.save(record)
  const browser = portifyReducer(initialPortifyState, { type: 'update', workflowId: record.workflowId, manifest: record })
  expect(browser.workflows).toEqual(store.list())
  expect(browser.workflows[0]).not.toHaveProperty('producer')
  expect(browser.workflows[0]).not.toHaveProperty('endedAt')
  if (branch === undefined) expect(browser.workflows[0].branch).toBeUndefined()
  else expect(browser.workflows[0].branch).toBe('')
})
