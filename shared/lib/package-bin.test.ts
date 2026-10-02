import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'
import { readPackageBin } from './package-bin'

const temp = trackTempDirs('package-bin-')

it.each<[unknown, boolean, string | null]>([
  ['cli.js', false, 'cli.js'],
  ['', false, ''],
  [{ 'canary-lab': 'preferred.js', alternate: 'other.js' }, true, 'preferred.js'],
  [{ ignored: 3, alternate: 'other.js' }, true, 'other.js'],
  [{ alternate: 'other.js' }, false, null],
  [{ 'canary-lab': null, alternate: 'other.js' }, true, 'other.js'],
  [{ 'canary-lab': 3, alternate: 'other.js' }, true, null],
  [{ 'canary-lab': '', alternate: 'other.js' }, true, ''],
  [{ ignored: 3 }, true, null],
  [null, true, null],
  [null, false, null],
  [undefined, false, null],
])('selects bin %j with fallback %s', (bin, fallback, expected) => {
  const root = temp()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin }))
  expect(readPackageBin(root, 'canary-lab', fallback)).toBe(expected)
})

it('leaves target existence to the caller and honors the requested name', () => {
  const root = temp()
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { custom: 'missing.js' } }))
  expect(readPackageBin(root, 'custom', false)).toBe('missing.js')
})

it('returns null for missing, unreadable, malformed and null manifests', () => {
  const root = temp()
  const manifest = path.join(root, 'package.json')
  expect(readPackageBin(root, 'canary-lab', true)).toBeNull()
  fs.mkdirSync(manifest)
  expect(readPackageBin(root, 'canary-lab', true)).toBeNull()
  fs.rmdirSync(manifest)
  for (const raw of ['{', 'null']) {
    fs.writeFileSync(manifest, raw)
    expect(readPackageBin(root, 'canary-lab', true)).toBeNull()
  }
})
