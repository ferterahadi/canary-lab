import { describe, it, expect, vi } from 'vitest'
import {
  ApiError, readResponseBody, request, requestJson,
} from './internal'
import {
  downloadEvaluationExportTask,
} from './evaluation'
import {
  asRepoCollision,
  asBranchMismatch,
  startRun,
  pauseHealRun,
  stopRun,
} from './runs'
import {
  deleteDraft,
} from './wizard'
import { fail } from './__fixtures__/response'

describe('JSON requests', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('sends a %s through the configured client', async (method) => {
    const fetchImpl = vi.fn(async () => new Response('{"saved":true}'))
    await expect(requestJson('/api/items/a%2Fb', method, { value: 'x' }, { baseUrl: 'http://local', fetchImpl }))
      .resolves.toEqual({ saved: true })
    expect(fetchImpl).toHaveBeenCalledWith('http://local/api/items/a%2Fb', {
      method, headers: { 'content-type': 'application/json' }, body: '{"value":"x"}',
    })
  })

  it.each([{}, null, false, 0, '', []])('serializes a supplied %j body', async (body) => {
    const fetchImpl = vi.fn(async () => new Response(''))
    await expect(requestJson('/api/items', 'POST', body, { fetchImpl })).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledWith('/api/items', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  })

  it('omits both body and JSON headers for undefined', async () => {
    const fetchImpl = vi.fn(async () => new Response(''))
    await requestJson('/api/items', 'POST', undefined, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/items', { method: 'POST' })
  })

  it('keeps server errors and network failures', async () => {
    await expect(requestJson('/api/items', 'POST', {}, { fetchImpl: vi.fn(async () => fail(409, { error: 'conflict' })) }))
      .rejects.toMatchObject({ status: 409, message: 'conflict', body: { error: 'conflict' } })
    const failure = new Error('offline')
    await expect(requestJson('/api/items', 'POST', {}, { fetchImpl: vi.fn().mockRejectedValue(failure) }))
      .rejects.toBe(failure)
  })
})

describe('api client core', () => {
  it('throws ApiError with null body when evaluation export download response is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    await expect(downloadEvaluationExportTask(
      {
        taskId: 'gone',
        runId: 'run-gone',
        feature: 'gone',
        mode: 'raw',
        producer: 'internal',
        status: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        downloadReady: false,
      },
      { fetchImpl, documentRef: {} as Document },
    )).rejects.toMatchObject({ status: 500, body: null })
  })

  it('throws ApiError when evaluation export download fails with text body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('missing archive', { status: 404 }))
    await expect(downloadEvaluationExportTask(
      {
        taskId: 'missing',
        runId: 'run-1',
        feature: 'checkout',
        mode: 'raw',
        producer: 'internal',
        status: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        downloadReady: false,
      },
      { fetchImpl, documentRef: {} as Document },
    )).rejects.toMatchObject({
      status: 404,
      body: 'missing archive',
    })
  })

  it('startRun throws ApiError on 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(400, { error: 'feature required' }))
    await expect(startRun('', { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('stopRun throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'run not found' }))
    await expect(stopRun('missing', { fetchImpl })).rejects.toMatchObject({ status: 404 })
  })

  it('pauseHealRun throws ApiError on 409 with the reason in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(409, { reason: 'no-failures-yet' }))
    await expect(pauseHealRun('r10', { fetchImpl })).rejects.toMatchObject({
      status: 409,
      body: { reason: 'no-failures-yet' },
    })
  })

  it('pauseHealRun throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'run not active' }))
    await expect(pauseHealRun('ghost', { fetchImpl })).rejects.toMatchObject({ status: 404 })
  })

  it('deleteDraft throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'draft not found' }))
    await expect(deleteDraft('missing', { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('asRepoCollision returns the payload for a 409 collision ApiError, else null', () => {
    const collisionBody = {
      type: 'repo_collision_requires_choice',
      conflictingRunId: 'r1',
      conflictingFeature: 'foo',
      repoPaths: ['/a'],
      options: ['worktree', 'queue'],
      message: 'm',
    }
    expect(asRepoCollision(new ApiError(409, collisionBody))).toEqual(collisionBody)
    // Non-ApiError, wrong status, null body, non-object body, wrong type → null.
    expect(asRepoCollision(new Error('nope'))).toBeNull()
    expect(asRepoCollision(new ApiError(500, collisionBody))).toBeNull()
    expect(asRepoCollision(new ApiError(409, null))).toBeNull()
    expect(asRepoCollision(new ApiError(409, 'string body'))).toBeNull()
    expect(asRepoCollision(new ApiError(409, { type: 'something_else' }))).toBeNull()
  })

  it('asBranchMismatch returns the payload for a 409 branch-mismatch ApiError, else null', () => {
    const body = {
      type: 'repo_branch_mismatch',
      feature: 'foo',
      error: 'Repo branch check failed:\n...',
      repos: [{ name: 'app', path: '/a', expected: 'feature/x', current: 'main', detached: false, isGitRepo: true }],
    }
    expect(asBranchMismatch(new ApiError(409, body))).toEqual(body)
    expect(asBranchMismatch(new Error('nope'))).toBeNull()
    expect(asBranchMismatch(new ApiError(500, body))).toBeNull()
    expect(asBranchMismatch(new ApiError(409, { type: 'repo_collision_requires_choice' }))).toBeNull()
  })
})

describe('response body parsing', () => {
  it.each([
    ['', null], ['null', null], ['false', false], ['0', 0], ['"hello"', 'hello'],
    ['{"value":1}', { value: 1 }], ['[1,"two"]', [1, 'two']],
    ['not json', 'not json'], ['  \n', '  \n'],
  ])('preserves the body semantics of %j', async (text, expected) => {
    const response = new Response(text as string)
    const read = vi.spyOn(response, 'text')
    await expect(readResponseBody(response)).resolves.toEqual(expected)
    expect(read).toHaveBeenCalledTimes(1)
    expect(response.bodyUsed).toBe(true)
  })

  it('propagates body-read and network failures unchanged', async () => {
    const failure = new Error('stream closed')
    const response = new Response('partial')
    vi.spyOn(response, 'text').mockRejectedValue(failure)
    await expect(readResponseBody(response)).rejects.toBe(failure)
    await expect(request('/api/example', {}, vi.fn().mockResolvedValue(response))).rejects.toBe(failure)
    await expect(request('/api/example', {}, vi.fn().mockRejectedValue(failure))).rejects.toBe(failure)
  })

  it('keeps server messages for ordinary requests and HTTP messages for downloads', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"archive unavailable"}', { status: 409 }))
    await expect(request('/api/example', {}, fetchImpl)).rejects.toMatchObject({
      message: 'archive unavailable', status: 409, body: { error: 'archive unavailable' },
    })
    await expect(downloadEvaluationExportTask({
      taskId: 'export-1', runId: 'run-1', feature: 'checkout', mode: 'raw', producer: 'internal',
      status: 'failed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', downloadReady: false,
    }, { fetchImpl, documentRef: {} as Document })).rejects.toMatchObject({
      message: 'HTTP 409', status: 409, body: { error: 'archive unavailable' },
    })
  })

  it.each(['', 'false', '0', 'plain text', '{"error":42}'])('keeps the HTTP fallback message for %j', async (body) => {
    await expect(request('/api/example', {}, vi.fn(async () => new Response(body, { status: 500 }))))
      .rejects.toMatchObject({ message: 'HTTP 500' })
  })
})
