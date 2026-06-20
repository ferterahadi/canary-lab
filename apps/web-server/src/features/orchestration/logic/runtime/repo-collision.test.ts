import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { detectRepoCollision, normalizeRepoPaths } from './repo-collision'

describe('normalizeRepoPaths', () => {
  it('resolves ~, makes absolute, and dedupes', () => {
    const out = normalizeRepoPaths(['~/foo', '~/foo', '/tmp/bar'])
    expect(out).toContain(path.join(os.homedir(), 'foo'))
    expect(out).toContain('/tmp/bar')
    expect(out).toHaveLength(2)
  })

  it('ignores empty/undefined', () => {
    expect(normalizeRepoPaths(undefined)).toEqual([])
    expect(normalizeRepoPaths([''])).toEqual([])
  })
})

describe('detectRepoCollision', () => {
  it('returns null when candidate repos do not overlap any active run', () => {
    const collision = detectRepoCollision(['/repos/app-a'], [
      { runId: 'r1', feature: 'b', repoPaths: ['/repos/app-b'] },
    ])
    expect(collision).toBeNull()
  })

  it('detects an overlap and reports the conflicting run', () => {
    const collision = detectRepoCollision(['/repos/app-a', '/repos/shared'], [
      { runId: 'r1', feature: 'b', repoPaths: ['/repos/app-b'] },
      { runId: 'r2', feature: 'a', repoPaths: ['/repos/shared'] },
    ])
    expect(collision).not.toBeNull()
    expect(collision?.conflictingRunId).toBe('r2')
    expect(collision?.conflictingFeature).toBe('a')
    expect(collision?.repoPaths).toEqual(['/repos/shared'])
  })

  it('treats ~-relative and absolute forms of the same repo as colliding', () => {
    const home = os.homedir()
    const collision = detectRepoCollision(['~/repos/app'], [
      { runId: 'r1', feature: 'x', repoPaths: [path.join(home, 'repos/app')] },
    ])
    expect(collision?.conflictingRunId).toBe('r1')
  })

  it('never collides on an empty candidate set', () => {
    expect(detectRepoCollision([], [{ runId: 'r1', feature: 'x', repoPaths: ['/a'] }])).toBeNull()
    expect(detectRepoCollision(undefined, [{ runId: 'r1', feature: 'x', repoPaths: ['/a'] }])).toBeNull()
  })
})
