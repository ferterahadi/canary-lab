import fs from 'fs'
import path from 'path'
import { afterEach, expect, it, vi } from 'vitest'
import { atomicWriteJson } from './atomic-write'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'

const makeTemp = trackTempDirs('atomic-json-')
const options = { uniqueTemporary: true }
afterEach(() => vi.restoreAllMocks())

it('creates a missing JSON file with default permissions', () => {
  const file = path.join(makeTemp(), 'state.json')
  atomicWriteJson(file, { first: true }, undefined, options)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ first: true })
  expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json'])
})

it('creates parents and replaces complete JSON with its existing permissions', () => {
  const file = path.join(makeTemp(), 'nested', 'state.json')
  atomicWriteJson(file, { old: true }, 0o600, options)
  atomicWriteJson(file, { next: [1] }, undefined, options)
  expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "next": [\n    1\n  ]\n}\n')
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json'])
})

it('preserves permissions even when the current umask is stricter', () => {
  const file = path.join(makeTemp(), 'state.json')
  fs.writeFileSync(file, '{}')
  fs.chmodSync(file, 0o640)
  const previous = process.umask(0o077)
  try {
    atomicWriteJson(file, { next: true }, undefined, options)
  } finally {
    process.umask(previous)
  }
  if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o640)
})

it('keeps each overlapping writer on its own staging path', () => {
  const file = path.join(makeTemp(), 'state.json')
  fs.writeFileSync(file, '{"old":true}')
  const rename = fs.renameSync.bind(fs)
  const staging: string[] = []
  // Interleave two real writes at the replacement boundary, without timing races.
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    staging.push(String(from))
    if (staging.length === 1) {
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ old: true })
      atomicWriteJson(file, { writer: 'second' }, undefined, options)
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ writer: 'second' })
    }
    rename(from, to)
  })
  atomicWriteJson(file, { writer: 'first' }, undefined, options)
  expect(new Set(staging).size).toBe(2)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ writer: 'first' })
  expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json'])
})

it('preserves the old file and removes staging when replacement fails', () => {
  const file = path.join(makeTemp(), 'state.json')
  fs.writeFileSync(file, '{"old":true}')
  const failure = new Error('replacement denied')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure })
  expect(() => atomicWriteJson(file, { next: true }, undefined, options)).toThrow(failure)
  expect(fs.readFileSync(file, 'utf8')).toBe('{"old":true}')
  expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json'])
})

it('propagates destination inspection errors before writing staging', () => {
  const file = path.join(makeTemp(), 'not-a-directory')
  fs.writeFileSync(file, 'original')
  expect(() => atomicWriteJson(path.join(file, 'state.json'), {}, undefined, options)).toThrow(/ENOTDIR/)
  expect(fs.readFileSync(file, 'utf8')).toBe('original')
})
