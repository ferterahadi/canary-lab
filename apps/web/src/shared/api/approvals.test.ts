import { afterEach, expect, it, vi } from 'vitest'
import { getApprovals, answerApproval } from './approvals'
import { ok, fail } from './__fixtures__/response'

afterEach(() => vi.unstubAllGlobals())

it('starts a fresh approval snapshot for a newer invalidation while an old read is pending', async () => {
  let finish!: (response: Response) => void
  const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    .mockResolvedValueOnce(ok([{ id: 'decision', status: 'answered' }]))
  const old = getApprovals({ fetchImpl, readRevision: 'one' })
  expect(await getApprovals({ fetchImpl, readRevision: 'two' })).toEqual([{ id: 'decision', status: 'answered' }])
  finish(ok([{ id: 'decision', status: 'pending' }]))
  expect(await old).toEqual([{ id: 'decision', status: 'pending' }])
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it('submits only the selected answer and surfaces server rejection', async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(ok({ id: 'decision', status: 'answered' }))
    .mockResolvedValueOnce(fail(409, { error: 'This approval expired' }))
  vi.stubGlobal('fetch', fetchImpl)
  expect(await answerApproval('decision', { choice: 'Update coverage first' })).toMatchObject({ status: 'answered' })
  expect(fetchImpl).toHaveBeenCalledWith('/api/approvals/decision/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: { choice: 'Update coverage first' } }),
  })
  await expect(answerApproval('decision', {})).rejects.toThrow('expired')
})
