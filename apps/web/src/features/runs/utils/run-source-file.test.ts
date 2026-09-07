import { describe, expect, it } from 'vitest'
import { sourceFileInRun } from './run-source-file'

const manifest = {
  featureDir: '/workspace/features/cns-wa',
  suiteSnapshot: { kind: 'taken' as const, dir: '/workspace/logs/runs/r1/suite', takenAt: '', digest: '' },
}

describe('sourceFileInRun', () => {
  it('maps only descendants of this run’s exact workspace suite', () => {
    expect(sourceFileInRun('/workspace/features/cns-wa/e2e/a.spec.ts', manifest)).toBe('/workspace/logs/runs/r1/suite/e2e/a.spec.ts')
    for (const other of ['/workspace/features/other/e2e/a.spec.ts', '/workspace/features/cns-wa-other/e2e/a.spec.ts', '/workspace/features/cns-wa']) {
      expect(sourceFileInRun(other, manifest)).toBe(other)
    }
  })
  it('preserves legacy and unavailable-snapshot paths', () => {
    const file = '/workspace/features/cns-wa/e2e/a.spec.ts'
    expect(sourceFileInRun(file, undefined)).toBe(file)
    expect(sourceFileInRun(file, {})).toBe(file)
    expect(sourceFileInRun(file, { featureDir: manifest.featureDir })).toBe(file)
    expect(sourceFileInRun(file, { ...manifest, suiteSnapshot: { kind: 'unavailable', at: '', reason: 'no copy' } })).toBe(file)
  })
  it('normalizes Windows separators and trailing root slashes', () => {
    expect(sourceFileInRun('C:\\suite\\e2e\\a.spec.ts', {
      featureDir: 'C:\\suite\\', suiteSnapshot: { ...manifest.suiteSnapshot, dir: 'C:\\run\\suite\\' },
    })).toBe('C:/run/suite/e2e/a.spec.ts')
  })
})
