import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'
import { readJsonOr, readTextOrNull } from './read-file-or'

const tempDir = trackTempDirs('read-file-or-')

it('reads text, and returns null for a missing file or a directory', () => {
  const dir = tempDir()
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'hello')
  expect(readTextOrNull(file)).toBe('hello')
  expect(readTextOrNull(path.join(dir, 'missing.txt'))).toBeNull()
  expect(readTextOrNull(dir)).toBeNull()
})

it('parses JSON, and falls back for a missing or malformed file', () => {
  const dir = tempDir()
  const good = path.join(dir, 'good.json')
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(good, '{"a":1}')
  fs.writeFileSync(bad, '{"a":')
  expect(readJsonOr(good, {})).toEqual({ a: 1 })
  expect(readJsonOr(bad, { fallback: true })).toEqual({ fallback: true })
  expect(readJsonOr(path.join(dir, 'missing.json'), null)).toBeNull()
})
