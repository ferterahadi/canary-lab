import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { confinedFile, isPathUnder } from './path-containment'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-confined-')

afterEach(() => vi.restoreAllMocks())

it.each([true, false])('preserves equality policy %s', (allowEqual) => {
  expect(isPathUnder('/repo', '/repo/', allowEqual)).toBe(allowEqual)
  expect(isPathUnder('/repo/child/..', '/repo', allowEqual)).toBe(allowEqual)
})

it.each(['child/file', '..cache/file', '.../file', 'child/../file'])('accepts descendant %s', (suffix) => {
  expect(isPathUnder(`/repo/${suffix}`, '/repo', false)).toBe(true)
})

it.each(['/repo-v2/file', '/repo/../outside', '/repo/..', '/other/file'])('rejects outside path %s', (child) => {
  expect(isPathUnder(child, '/repo', true)).toBe(false)
})

it('rejects another Windows drive under Windows path semantics', () => {
  vi.spyOn(path, 'relative').mockImplementation(path.win32.relative)
  vi.spyOn(path, 'isAbsolute').mockImplementation(path.win32.isAbsolute)
  expect(isPathUnder('D:\\repo\\file', 'C:\\repo', true)).toBe(false)
})

it('resolves a file inside the root, existing or not', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'e2e'))
  fs.writeFileSync(path.join(root, 'e2e', 'a.spec.ts'), '')
  expect(confinedFile(root, 'e2e/a.spec.ts')).toBe(path.join(root, 'e2e', 'a.spec.ts'))
  expect(confinedFile(root, 'e2e/missing/b.spec.ts')).toBe(path.join(root, 'e2e', 'missing', 'b.spec.ts'))
})

it('refuses a path that leaves the root, directly or through a symlinked parent', () => {
  const root = tempDir()
  const outside = tempDir()
  fs.symlinkSync(outside, path.join(root, 'link'))
  expect(() => confinedFile(root, '../escape.ts')).toThrow('outside the suite')
  expect(() => confinedFile(root, 'link/missing.ts')).toThrow('outside the suite')
})
