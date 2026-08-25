import { describe, expect, it } from 'vitest'
import { fileCountLabel, groupByDirectory, isTestPath, REPO_ROOT_DIR_LABEL } from './repair-files'

describe('isTestPath', () => {
  it('flags the spec and unit-test suffixes a repair must not have touched', () => {
    expect(isTestPath('e2e/checkout.spec.ts')).toBe(true)
    expect(isTestPath('src/lib/tax.test.ts')).toBe(true)
    expect(isTestPath('apps/web/src/ui/Card.test.tsx')).toBe(true)
    expect(isTestPath('src/store.spec.mjs')).toBe(true)
  })

  it('leaves product code inside a test-shaped directory alone', () => {
    // Matching on a `tests/` path segment would flag a product fixture folder
    // as a broken repair rule; the suffix is the honest signal.
    expect(isTestPath('src/tests/fixtures/order.ts')).toBe(false)
    expect(isTestPath('e2e/helpers/login.ts')).toBe(false)
    expect(isTestPath('src/api/orders.ts')).toBe(false)
  })
})

describe('groupByDirectory', () => {
  it('rolls files up per directory, heaviest first', () => {
    expect(groupByDirectory([
      'src/api/a.ts', 'src/api/b.ts', 'src/api/c.ts',
      'src/lib/d.ts', 'src/lib/e.ts',
      'pkg/f.ts',
    ])).toEqual([
      { dir: 'src/api', count: 3 },
      { dir: 'src/lib', count: 2 },
      { dir: 'pkg', count: 1 },
    ])
  })

  it('breaks a count tie alphabetically so the order is stable', () => {
    expect(groupByDirectory(['b/x.ts', 'a/y.ts'])).toEqual([
      { dir: 'a', count: 1 },
      { dir: 'b', count: 1 },
    ])
  })

  it('names the repo root instead of rendering an empty row', () => {
    // Captured names are repo-relative, so "no directory" means the root — and
    // a stray leading slash lands there too rather than in a nameless group.
    expect(groupByDirectory(['server.ts', '/Makefile'])).toEqual([
      { dir: REPO_ROOT_DIR_LABEL, count: 2 },
    ])
  })

  it('has nothing to roll up for no files', () => {
    expect(groupByDirectory([])).toEqual([])
  })
})

describe('fileCountLabel', () => {
  it('agrees with itself on one', () => {
    expect(fileCountLabel(1)).toBe('1 file')
    expect(fileCountLabel(0)).toBe('0 files')
    expect(fileCountLabel(40)).toBe('40 files')
  })
})
