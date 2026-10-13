import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { readPlaybackSourceDeclarations } from './playback-source-declarations'

const temp = trackTempDirs('playback-source-')
it('reads declaration identity without importing code or following test helpers', () => {
  const dir = temp()
  const file = path.join(dir, 'page.spec.ts')
  fs.writeFileSync(file, `throw new Error('must not execute');
test.describe('group', () => { test('renders', { tag: '@req-R1' }, () => { helper() }) });
test('no body'); test(dynamicTitle, () => {});`)
  expect(readPlaybackSourceDeclarations(dir)).toEqual([{ file, title: 'renders' }])
})
it('keeps missing and unreadable source from blocking evidence reads', () => {
  expect(readPlaybackSourceDeclarations(undefined)).toEqual([])
  expect(readPlaybackSourceDeclarations(path.join(temp(), 'gone'))).toEqual([])
  const dir = temp()
  const file = path.join(dir, 'page.spec.ts')
  fs.writeFileSync(file, "test('renders', () => {})")
  fs.chmodSync(file, 0)
  try { expect(readPlaybackSourceDeclarations(dir)).toEqual([]) }
  finally { fs.chmodSync(file, 0o600) }
  expect(readPlaybackSourceDeclarations(file)).toEqual([])
})
