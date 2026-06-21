import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWrite } from './atomic-write'

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
})
