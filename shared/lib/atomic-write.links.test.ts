import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicWriteJson } from './atomic-write'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'

const makeTemp = trackTempDirs('atomic-links-')
const options = { uniqueTemporary: true, followSymlinks: true, createParents: false }
afterEach(() => vi.restoreAllMocks())

it.each(['relative', 'absolute', 'chain', 'dangling', 'parent'])('preserves %s links and replaces the actual target', (kind) => {
  const root = makeTemp()
  const target = path.join(root, 'target', 'state.json')
  fs.mkdirSync(path.dirname(target))
  if (kind !== 'dangling') fs.writeFileSync(target, '{}', { mode: 0o640 })
  const oldInode = kind === 'dangling' ? undefined : fs.statSync(target).ino
  let link = path.join(root, 'state.json')
  if (kind === 'parent') {
    fs.symlinkSync('target', path.join(root, 'linked'), 'dir')
    link = path.join(root, 'linked', 'state.json')
  } else {
    if (kind === 'chain') fs.symlinkSync('target/state.json', path.join(root, 'middle'))
    fs.symlinkSync(kind === 'absolute' ? target : kind === 'chain' ? 'middle' : 'target/state.json', link)
  }
  atomicWriteJson(link, { next: true }, undefined, options)
  expect(fs.readFileSync(target, 'utf8')).toBe('{\n  "next": true\n}\n')
  expect(fs.lstatSync(kind === 'parent' ? path.dirname(link) : link).isSymbolicLink()).toBe(true)
  if (oldInode !== undefined) {
    expect(fs.statSync(target).ino).not.toBe(oldInode)
    expect(fs.statSync(target).mode & 0o777).toBe(0o640)
  }
  expect(fs.readdirSync(path.dirname(target))).toEqual(['state.json'])
})

it.each([false, true])('preserves missing-parent failures with uniqueTemporary=%s', (uniqueTemporary) => {
  const root = makeTemp()
  const file = path.join(root, 'missing', 'state.json')
  expect(() => atomicWriteJson(file, {}, undefined, { ...options, uniqueTemporary })).toThrow(/ENOENT/)
  expect(fs.readdirSync(root)).toEqual([])
})

it('does not create a dangling link target parent', () => {
  const root = makeTemp()
  const link = path.join(root, 'state.json')
  fs.symlinkSync('missing/state.json', link)
  expect(() => atomicWriteJson(link, {}, undefined, options)).toThrow(/ENOENT/)
  expect(fs.readlinkSync(link)).toBe('missing/state.json')
  expect(fs.readdirSync(root)).toEqual(['state.json'])
})

it('reports cycles and non-directory resolution failures without changing links', () => {
  const root = makeTemp()
  const link = path.join(root, 'state.json')
  fs.symlinkSync('state.json', link)
  expect(() => atomicWriteJson(link, {}, undefined, options)).toThrow(/ELOOP/)
  fs.writeFileSync(path.join(root, 'plain'), 'original')
  expect(() => atomicWriteJson(path.join(root, 'plain', 'state.json'), {}, undefined, options)).toThrow(/ENOTDIR/)
  expect(fs.readlinkSync(link)).toBe('state.json')
})

it.each(['writeFileSync', 'renameSync'] as const)('preserves linked content and cleans staging after %s failure', (operation) => {
  const root = makeTemp()
  const target = path.join(root, 'target.json')
  const link = path.join(root, 'state.json')
  fs.writeFileSync(target, 'original')
  fs.symlinkSync('target.json', link)
  const failure = Object.assign(new Error('directory write denied'), { code: 'EACCES' })
  if (operation === 'writeFileSync') {
    const write = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, body, opts) => {
      write(file, body, opts)
      throw failure
    })
  } else vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure })
  expect(() => atomicWriteJson(link, {}, undefined, options)).toThrow(failure)
  expect(fs.readFileSync(target, 'utf8')).toBe('original')
  expect(fs.readlinkSync(link)).toBe('target.json')
  expect(fs.readdirSync(root).sort()).toEqual(['state.json', 'target.json'])
})

it('can follow links with the existing non-unique staging policy', () => {
  const root = makeTemp()
  const link = path.join(root, 'state.json')
  fs.symlinkSync('target.json', link)
  atomicWriteJson(link, { next: true }, undefined, { followSymlinks: true, createParents: false })
  expect(fs.readFileSync(link, 'utf8')).toContain('"next": true')
  expect(fs.readlinkSync(link)).toBe('target.json')
})

it('resolves relative leaf links from their physical parent, including linked paths before ..', () => {
  const root = makeTemp()
  const physical = path.join(root, 'physical')
  fs.mkdirSync(path.join(physical, 'nested'), { recursive: true })
  fs.symlinkSync('physical/nested', path.join(root, 'alias'), 'dir')
  fs.symlinkSync('../target.json', path.join(physical, 'nested', 'state.json'))
  const target = path.join(physical, 'target.json')
  atomicWriteJson(path.join(root, 'alias', 'state.json'), { physical: true }, undefined, options)
  expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ physical: true })
  expect(fs.existsSync(path.join(root, 'target.json'))).toBe(false)
  fs.symlinkSync('alias/../other.json', path.join(root, 'other-link.json'))
  atomicWriteJson(path.join(root, 'other-link.json'), { traversed: true }, undefined, options)
  expect(JSON.parse(fs.readFileSync(path.join(physical, 'other.json'), 'utf8'))).toEqual({ traversed: true })
})

it('propagates a parent link cycle before staging any content', () => {
  const root = makeTemp()
  const loop = path.join(root, 'loop')
  fs.symlinkSync('loop', loop)
  expect(() => atomicWriteJson(path.join(loop, 'state.json'), {}, undefined, options)).toThrow(/ELOOP/)
  expect(fs.readdirSync(root)).toEqual(['loop'])
})
