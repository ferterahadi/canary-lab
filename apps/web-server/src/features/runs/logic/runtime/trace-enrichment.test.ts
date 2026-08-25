import { describe, it, expect, vi } from 'vitest'
import { execFile } from 'child_process'
import { parseFailedActionIds, parseFirstFailedActionId, parseRequestIds, stripSnapshotsCliBlock } from './trace-enrichment'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

describe('parseFirstFailedActionId', () => {
  it('returns the ordinal of the first failed row', () => {
    const stdout = [
      '     # Time       Action                                                  Duration',
      '  ──── ─────────  ─────────────────────────────────────────────────────── ────────',
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
      '   26. 0:03.112  Wait for selector                                          15.0s  ✗',
    ].join('\n')
    expect(parseFirstFailedActionId(stdout)).toBe('25')
  })

  it('returns null when no failed action is present', () => {
    const stdout = [
      '     # Time       Action                                                  Duration',
      '  ──── ─────────  ─────────────────────────────────────────────────────── ────────',
    ].join('\n')
    expect(parseFirstFailedActionId(stdout)).toBeNull()
  })

  it('ignores rows without the ✗ marker', () => {
    const stdout = '   1. 0:00.001  Before Hooks                                               102ms'
    expect(parseFirstFailedActionId(stdout)).toBeNull()
  })

  it('handles two-line action rows (selector on continuation line)', () => {
    const stdout = [
      '   14. 1:00.276  Click getByRole(\'button\', { name: \'Sign In\' })              1.3m  ✗',
      '                 getByRole(\'button\', { name: \'Sign In\' })',
      '   15. 1:00.276  page.click                                                  1.3m  ✗',
    ].join('\n')
    expect(parseFirstFailedActionId(stdout)).toBe('14')
  })
})

describe('parseFailedActionIds', () => {
  it('returns all failed action ordinals in order', () => {
    const stdout = [
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
      '   26. 0:03.112  Wait for selector                                          15.0s  ✗',
      '   34. 0:05.489  Wait for selector                                          10.0s  ✗',
    ].join('\n')
    expect(parseFailedActionIds(stdout)).toEqual(['25', '26', '34'])
  })

  it('dedupes repeated ordinals', () => {
    const stdout = [
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
    ].join('\n')
    expect(parseFailedActionIds(stdout)).toEqual(['25'])
  })

  it('returns empty array when no failed rows', () => {
    expect(parseFailedActionIds('   1. ok\n')).toEqual([])
  })
})

describe('parseRequestIds', () => {
  it('returns all failed request ordinals in order', () => {
    const stdout = [
      '   # Method Status URL                          Duration',
      '─── ────── ────── ──────────────────────────── ────────',
      '  7. POST   500    https://example.test/api/pay   120ms',
      '  8. GET    404    https://example.test/api/x     50ms',
    ].join('\n')
    expect(parseRequestIds(stdout)).toEqual(['7', '8'])
  })

  it('dedupes repeated ordinals', () => {
    const stdout = [
      '  7. POST   500    https://example.test/api/pay   120ms',
      '  7. POST   500    https://example.test/api/pay   120ms',
    ].join('\n')
    expect(parseRequestIds(stdout)).toEqual(['7'])
  })
})

describe('stripSnapshotsCliBlock', () => {
  it('replaces the npx playwright trace snapshot usage line with a file pointer', () => {
    const input = [
      '  Snapshots',
      '    available: before, after',
      '    usage:     npx playwright trace snapshot 25 --name <before|after>',
    ].join('\n')
    const out = stripSnapshotsCliBlock(input)
    expect(out).not.toContain('npx playwright trace')
    expect(out).toContain('available: before, after')
    expect(out).toContain('trace-extract/snapshot-at-failure.txt')
  })

  it('leaves output without the usage line unchanged', () => {
    const input = '  Snapshots\n    available: before\n'
    expect(stripSnapshotsCliBlock(input)).toBe(input)
  })
})
