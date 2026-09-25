import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReadableRunLog, openEditor } from '@/shared/api/client'
import { openRunLog } from './open-run-log'

vi.mock('@/shared/api/client', () => ({
  createReadableRunLog: vi.fn(),
  openEditor: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(openEditor).mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof openEditor>>)
})

describe('openRunLog', () => {
  it('opens the readable copy the server built', async () => {
    vi.mocked(createReadableRunLog).mockResolvedValue({ path: '/runs/r1/readable-logs/svc-api.log' })
    await openRunLog('r1', '/runs/r1/svc-api.log')
    expect(createReadableRunLog).toHaveBeenCalledWith('r1', '/runs/r1/svc-api.log')
    expect(openEditor).toHaveBeenCalledWith({ file: '/runs/r1/readable-logs/svc-api.log' })
  })

  it('opens the raw log when no copy can be built, and swallows an editor failure', async () => {
    vi.mocked(createReadableRunLog).mockRejectedValue(new Error('400'))
    vi.mocked(openEditor).mockRejectedValue(new Error('no editor'))
    await expect(openRunLog('r1', '/elsewhere/dependency.log')).resolves.toBeUndefined()
    expect(openEditor).toHaveBeenCalledWith({ file: '/elsewhere/dependency.log' })
  })
})
