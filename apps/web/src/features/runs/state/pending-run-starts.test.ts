// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPendingRunStarts, savePendingRunStarts } from './pending-run-starts'

const storageKey = 'canary.pending-run-starts'
const testRequest = { requestId: 'test-request', feature: 'checkout', mode: 'test' as const }
const bootRequest = { requestId: 'boot-request', feature: 'catalog', mode: 'boot' as const }

beforeEach(() => { sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('pending run-start persistence', () => {
  it('starts empty and preserves both test and boot requests across a read', () => {
    expect(readPendingRunStarts()).toEqual([])

    savePendingRunStarts([testRequest, bootRequest])

    expect(readPendingRunStarts()).toEqual([testRequest, bootRequest])
  })

  it('ignores malformed entries without dropping valid requests', () => {
    sessionStorage.setItem(storageKey, JSON.stringify([
      null, false, {}, { requestId: 3 }, { requestId: 'invalid', feature: 3 },
      { requestId: 'invalid', feature: 'checkout', mode: 'unknown' },
      testRequest, bootRequest,
    ]))

    expect(readPendingRunStarts()).toEqual([testRequest, bootRequest])
  })

  it.each(['{}', 'null', '"not an array"', '{invalid'])('recovers from invalid stored state %s', (stored) => {
    sessionStorage.setItem(storageKey, stored)

    expect(readPendingRunStarts()).toEqual([])
  })

  it('allows live observation when session storage cannot be read', () => {
    vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })

    expect(readPendingRunStarts()).toEqual([])
  })

  it('does not interrupt the live request when storage rejects a write', () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('storage quota exceeded') })

    expect(() => savePendingRunStarts([testRequest])).not.toThrow()
  })
})
