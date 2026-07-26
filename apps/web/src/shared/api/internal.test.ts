import { describe, it, expect, vi } from 'vitest'
import {
  ApiError,
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
  deleteJournalEntry,
} from './runs'
import {
  deleteDraft,
} from './wizard'
import { fail } from './__fixtures__/response'

describe('api client core', () => {
  it('throws ApiError with null body when evaluation export download response is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    await expect(downloadEvaluationExportTask(
      {
        taskId: 'gone',
        runId: 'run-gone',
        feature: 'gone',
        mode: 'raw',
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

  it('deleteJournalEntry throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'iteration not found' }))
    await expect(deleteJournalEntry(99, { run: 'r1' }, { fetchImpl })).rejects.toBeInstanceOf(ApiError)
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
