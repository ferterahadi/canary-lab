import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRegistry } from './run-registry'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rs-')))
})

describe('createRegistry', () => {
  it('round-trips orchestrator-like values', () => {
    const reg = createRegistry()
    const stub = {
      runId: 'r1',
      stop: async () => {},
      pauseAndHeal: async () => ({ ok: true as const, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true as const }),
    }
    reg.set('r1', stub)
    expect(reg.get('r1')).toBe(stub)
    expect(reg.list()).toEqual([stub])
    expect(reg.delete('r1')).toBe(true)
    expect(reg.get('r1')).toBeUndefined()
    expect(reg.delete('r1')).toBe(false)
  })
})
