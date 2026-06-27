import { describe, it, expect, vi } from 'vitest'
import { parseSemver, compareSemver, isOutdated, fetchLatestVersion } from './registry-version'

describe('parseSemver', () => {
  it('parses a plain release triple', () => {
    expect(parseSemver('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0 })
  })
  it('strips a leading v and prerelease/build metadata', () => {
    expect(parseSemver('v2.10.3-rc.1')).toEqual({ major: 2, minor: 10, patch: 3 })
    expect(parseSemver('1.0.0+sha.abc')).toEqual({ major: 1, minor: 0, patch: 0 })
  })
  it('returns null for non-semver input', () => {
    expect(parseSemver('1.4')).toBeNull()
    expect(parseSemver('latest')).toBeNull()
    expect(parseSemver(null)).toBeNull()
    expect(parseSemver(undefined)).toBeNull()
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('1.4.0', '1.3.9')).toBe(1)
    expect(compareSemver('1.4.1', '1.4.2')).toBe(-1)
    expect(compareSemver('1.4.0', '1.4.0')).toBe(0)
  })
  it('does NOT compare lexically (1.10 > 1.9)', () => {
    expect(compareSemver('1.9.0', '1.10.0')).toBe(-1)
  })
  it('treats unparseable versions as equal', () => {
    expect(compareSemver('latest', '1.0.0')).toBe(0)
  })
})

describe('isOutdated', () => {
  it('is true only when latest is strictly newer', () => {
    expect(isOutdated('1.4.0', '1.4.1')).toBe(true)
    expect(isOutdated('1.4.0', '1.4.0')).toBe(false)
    expect(isOutdated('1.5.0', '1.4.0')).toBe(false)
  })
  it('is false when either side is missing', () => {
    expect(isOutdated(null, '1.4.0')).toBe(false)
    expect(isOutdated('1.4.0', null)).toBe(false)
  })
})

describe('fetchLatestVersion', () => {
  it('returns the version from the registry payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.4.2' }),
    }) as unknown as typeof fetch
    expect(await fetchLatestVersion('canary-lab', { fetchImpl })).toBe('1.4.2')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.npmjs.org/canary-lab/latest',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    )
  })
  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch
    expect(await fetchLatestVersion('canary-lab', { fetchImpl })).toBeNull()
  })
  it('returns null when fetch rejects (offline / abort)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    expect(await fetchLatestVersion('canary-lab', { fetchImpl })).toBeNull()
  })
  it('returns null when the body has no version string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: 42 }) }) as unknown as typeof fetch
    expect(await fetchLatestVersion('canary-lab', { fetchImpl })).toBeNull()
  })
})
