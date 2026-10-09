import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../tools/test-helpers/temp-dir'
import { isSpecFile, listSpecFiles, readSpecSource, scanSpecFiles } from './spec-files'

const temp = trackTempDirs('spec-inventory-')
function write(root: string, relative: string, source = '// spec'): string {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source)
  return file
}

describe('shared spec inventory', () => {
  it('lists every supported extension recursively, keeps duplicate basenames, and sorts absolute paths', () => {
    const dir = temp()
    const expected: string[] = []
    for (const suffix of ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']) {
      for (const kind of ['spec', 'test']) expected.push(write(dir, `e2e/${suffix}/case.${kind}.${suffix}`))
    }
    expected.push(write(dir, 'e2e/deep/nested/case.spec.ts'))
    expected.push(write(dir, 'e2e/case.spec.ts'))
    for (const file of ['unit/other.test.ts', 'e2e/helper.ts', 'e2e/case.spec.json', 'e2e/case.spec.ts.bak']) write(dir, file)
    expect(listSpecFiles(dir)).toEqual(expected.sort())
    expect(readSpecSource(expected[0])).toBe('// spec')
    expect(isSpecFile('case.test.cjsx')).toBe(false)
  })

  it('omits generated trees and descendant links, including cycles', () => {
    const dir = temp()
    const outside = temp()
    const file = write(dir, 'e2e/phase/case.spec.ts')
    write(outside, 'outside.spec.ts')
    for (const folder of ['node_modules', '.git', 'dist', 'logs', 'test-results', 'playwright-report']) write(dir, `e2e/${folder}/ignored.spec.ts`)
    fs.symlinkSync(outside, path.join(dir, 'e2e', 'linked'))
    fs.symlinkSync(file, path.join(dir, 'e2e', 'linked.spec.ts'))
    fs.symlinkSync(path.join(dir, 'e2e'), path.join(dir, 'e2e', 'phase', 'cycle'))
    expect(listSpecFiles(dir)).toEqual([file])
  })

  it('preserves the historical flat TypeScript inventory only when explicitly selected', () => {
    const dir = temp()
    const flat = write(dir, 'e2e/flat.spec.ts')
    write(dir, 'e2e/deep/nested.spec.ts')
    write(dir, 'e2e/other.test.js')
    expect(listSpecFiles(dir, 1)).toEqual([flat])
    expect(listSpecFiles(dir)).toHaveLength(3)
  })

  it('supports tool roots and exclusions without another traversal', () => {
    const dir = temp()
    const file = write(dir, 'tests/case.test.js')
    write(dir, '__fixtures__/skip.spec.ts')
    expect(scanSpecFiles(dir, { excludedDirectories: new Set(['__fixtures__']) })).toEqual([file])
  })

  it('returns empty for absent roots but surfaces non-directory and source-read errors', () => {
    const dir = temp()
    expect(listSpecFiles(dir)).toEqual([])
    const file = write(dir, 'e2e', '')
    expect(() => listSpecFiles(dir)).toThrow()
    expect(() => readSpecSource(`${file}/missing`)).toThrow()
  })

  it('surfaces unreadable nested directories instead of certifying an incomplete inventory', () => {
    const dir = temp()
    write(dir, 'e2e/locked/case.spec.ts')
    const locked = path.join(dir, 'e2e/locked')
    fs.chmodSync(locked, 0)
    try { expect(() => listSpecFiles(dir)).toThrow() }
    finally { fs.chmodSync(locked, 0o700) }
  })
})
