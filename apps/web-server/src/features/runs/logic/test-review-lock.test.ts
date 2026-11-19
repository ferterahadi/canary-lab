import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { describe, expect, it } from 'vitest'
import { withRunReviewLock } from './test-review-lock'
import type { RunStore } from './run-store'

const tempDir = trackTempDirs('cl-review-lock-')

describe('test review serialization', () => {
  it('releases a missing-run lock after a failed decision so the next request can inspect durable state', async () => {
    const store = { logsDir: tempDir(), get: () => null } as unknown as RunStore
    const first = withRunReviewLock(store, 'missing', async () => { throw new Error('write failed') })
    const second = withRunReviewLock(store, 'missing', async () => 'read-again')
    await expect(first).rejects.toThrow('write failed')
    await expect(second).resolves.toBe('read-again')
  })
})
