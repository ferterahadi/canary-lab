import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { realpathOrSelf } from './realpath-or-self'

const temp = trackTempDirs('realpath-self-')
afterEach(() => vi.restoreAllMocks())

it('resolves existing directories and symlinks', () => {
  const dir = temp()
  const link = path.join(dir, 'linked')
  fs.symlinkSync(dir, link)
  expect(realpathOrSelf(dir)).toBe(dir)
  expect(realpathOrSelf(link)).toBe(dir)
})

it('preserves a missing relative path verbatim', () => {
  const input = path.relative(process.cwd(), path.join(temp(), 'missing', '..', 'absent'))
  expect(realpathOrSelf(input)).toBe(input)
})

it('preserves the input for non-ENOENT failures too', () => {
  vi.spyOn(fs, 'realpathSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  expect(realpathOrSelf('./authored/../path')).toBe('./authored/../path')
})
