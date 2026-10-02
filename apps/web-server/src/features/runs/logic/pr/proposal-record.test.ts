import { expect, it } from 'vitest'
import { proposalRecord } from './proposal-record'

const pr = { repoName: 'api', url: 'https://example.test/pr/1', branch: 'fix', base: 'main', createdAt: 'created' }

it.each([true, false])('records every result, preserving order, duplicates, and optional fields (auto=%s)', (auto) => {
  const results = [
    { repoName: 'api', ok: true, pr },
    { repoName: 'api', ok: true, pr, reason: '' },
    { repoName: 'web', ok: false, reason: 'push rejected' },
    { repoName: 'other', ok: false, pr },
    { repoName: 'empty', ok: true },
  ]
  const before = structuredClone(results)
  expect(proposalRecord(results, { at: 'attempt', auto })).toEqual({
    opened: [pr, pr],
    attempt: { at: 'attempt', auto, results: [
      { repoName: 'api', ok: true, url: pr.url },
      { repoName: 'api', ok: true, url: pr.url },
      { repoName: 'web', ok: false, reason: 'push rejected' },
      { repoName: 'other', ok: false, url: pr.url },
      { repoName: 'empty', ok: true },
    ] },
  })
  expect(results).toEqual(before)
})
it('records an empty attempt without creating proposals', () => {
  expect(proposalRecord([], { at: 'now', auto: true })).toEqual({ opened: [], attempt: { at: 'now', auto: true, results: [] } })
})
