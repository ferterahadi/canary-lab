import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Isolate the catch(err) branch that calls String(err) when a non-Error is
// thrown from mergePortifyBranch. Real git always throws Error instances, so
// we mock the module for this single path.
vi.mock('./git-ops', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./git-ops')>()
  return {
    ...orig,
    getGitRoot: vi.fn().mockResolvedValue('/fake/root'),
    mergePortifyBranch: vi.fn().mockRejectedValue('plain string error'),
  }
})

vi.mock('./agent', () => ({ runPortifyAgent: vi.fn(), writePortifyClaudeRef: vi.fn() }))

import { PortifyRunStore } from './store'
import { createPortifyRunner } from './runner'
import type { PortifyManifest } from './types'

const roots: string[] = []
afterEach(() => {
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ } }
  roots.length = 0
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') })
})

describe('runner merge — String(err) fallback', () => {
  it('uses String(err) when mergePortifyBranch throws a non-Error', async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-str-err-'))
    roots.push(logsDir)
    const store = new PortifyRunStore(logsDir)
    const runner = createPortifyRunner({
      logsDir,
      store,
      ptyFactory: () => ({ pid: 1, onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }), write: () => {}, resize: () => {}, kill: () => {} }),
      loadFeatures: () => [],
      pickAgent: () => 'claude',
      now: () => '2026-06-07T00:00:00.000Z',
      healthCheck: async () => true,
      healthPollIntervalMs: 5,
      healthDeadlineMs: 400,
    })

    const m: PortifyManifest = {
      workflowId: 'w',
      feature: 'f',
      featureDir: '/f',
      repos: [{ name: 'app', path: '/fake/root', commitSha: 'abc123' }],
      agent: 'claude',
      branch: 'canary/dynamic-ports-f',
      status: 'committed',
      attempt: 1,
      maxAttempts: 1,
      startedAt: '2026-06-07T00:00:00.000Z',
      endedAt: '2026-06-07T00:00:00.000Z',
    }
    store.save(m)

    const res = await runner.merge('w')
    expect(res.ok).toBe(false)
    expect(res.results[0].error).toBe('plain string error')
  })
})
