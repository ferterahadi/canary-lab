import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { isPathUnder } from './path-containment'

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
