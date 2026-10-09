import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicReplace, atomicWrite, atomicWriteJson } from './atomic-write'
import { trackTempDirs } from '../../tools/test-helpers/temp-dir'

describe('atomicWrite', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the body to the target file', () => {
    const file = path.join(dir, 'out.json')
    atomicWrite(file, '{"a":1}')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}')
  })

  it('creates missing parent directories', () => {
    const file = path.join(dir, 'nested', 'deep', 'out.txt')
    atomicWrite(file, 'hello')
    expect(fs.readFileSync(file, 'utf8')).toBe('hello')
  })

  it('replaces an existing file', () => {
    const file = path.join(dir, 'out.txt')
    fs.writeFileSync(file, 'old')
    atomicWrite(file, 'new')
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
  })

  it('leaves no .tmp sibling behind on success', () => {
    const file = path.join(dir, 'out.txt')
    atomicWrite(file, 'x')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(fs.readdirSync(dir)).toEqual(['out.txt'])
  })

  it('creates private configuration files with the requested mode', () => {
    const file = path.join(dir, 'private.json')
    atomicWrite(file, '{}', 0o600)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('restricts a leftover temporary file before writing private configuration', () => {
    const file = path.join(dir, 'private.json')
    fs.writeFileSync(`${file}.tmp`, 'interrupted write', { mode: 0o644 })
    atomicWrite(file, '{}', 0o600)
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('writes JSON with two-space indent and a trailing newline', () => {
    const file = path.join(dir, 'state.json')
    atomicWriteJson(file, { a: [1] }, 0o600)
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": [\n    1\n  ]\n}\n')
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

const makeTemp = trackTempDirs('atomic-replace-')

describe('atomicReplace', () => {
  it('replaces exact bytes using the caller-owned temporary name', () => {
    const dir = makeTemp()
    const file = path.join(dir, 'out.txt')
    const temporaryPath = path.join(dir, 'unique.tmp')
    fs.writeFileSync(file, 'old')
    atomicReplace(file, 'new\r\nwithout trailing newline', { temporaryPath })
    expect(fs.readFileSync(file, 'utf8')).toBe('new\r\nwithout trailing newline')
    expect(fs.readdirSync(dir)).toEqual(['out.txt'])
  })

  it('does not create missing parent directories', () => {
    const parent = path.join(makeTemp(), 'missing')
    expect(() => atomicReplace(path.join(parent, 'out'), 'body')).toThrow()
    expect(fs.existsSync(parent)).toBe(false)
  })

  it('keeps the destination when the temporary write and its cleanup both fail', () => {
    const dir = makeTemp()
    const file = path.join(dir, 'out')
    const temporaryPath = `${file}.tmp`
    fs.writeFileSync(file, 'original')
    // A directory at the staging path makes both write and non-recursive rm
    // fail on a real filesystem; the reported failure must still be the write.
    fs.mkdirSync(temporaryPath)
    expect(() => atomicReplace(file, 'replacement', { cleanupOnError: true })).toThrow(/EISDIR/)
    expect(fs.readFileSync(file, 'utf8')).toBe('original')
    expect(fs.statSync(temporaryPath).isDirectory()).toBe(true)
  })

  it.each([false, true])('preserves a destination directory on rename failure (cleanup=%s)', (cleanupOnError) => {
    const file = path.join(makeTemp(), 'out')
    fs.mkdirSync(file)
    fs.writeFileSync(path.join(file, 'original'), 'original')
    expect(() => atomicReplace(file, 'replacement', { cleanupOnError })).toThrow()
    expect(fs.readFileSync(path.join(file, 'original'), 'utf8')).toBe('original')
    expect(fs.existsSync(`${file}.tmp`)).toBe(!cleanupOnError)
  })
})
