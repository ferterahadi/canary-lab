import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { copyDirRecursive } from './copy-dir'

describe('copyDirRecursive', () => {
  let dir: string
  let src: string
  let dst: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-dir-'))
    src = path.join(dir, 'src')
    dst = path.join(dir, 'dst')
    fs.mkdirSync(src, { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('copies files and nested directories', () => {
    fs.writeFileSync(path.join(src, 'top.txt'), 'top')
    fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true })
    fs.writeFileSync(path.join(src, 'a', 'b', 'deep.txt'), 'deep')
    copyDirRecursive(src, dst)
    expect(fs.readFileSync(path.join(dst, 'top.txt'), 'utf8')).toBe('top')
    expect(fs.readFileSync(path.join(dst, 'a', 'b', 'deep.txt'), 'utf8')).toBe('deep')
  })

  it('creates the target tree when it does not exist', () => {
    fs.writeFileSync(path.join(src, 'f.txt'), 'x')
    const nested = path.join(dir, 'not', 'yet', 'there')
    copyDirRecursive(src, nested)
    expect(fs.readFileSync(path.join(nested, 'f.txt'), 'utf8')).toBe('x')
  })

  it('copies an empty directory as an empty directory', () => {
    fs.mkdirSync(path.join(src, 'empty'))
    copyDirRecursive(src, dst)
    expect(fs.readdirSync(path.join(dst, 'empty'))).toEqual([])
  })

  it('overwrites a file already present in the target', () => {
    fs.writeFileSync(path.join(src, 'f.txt'), 'new')
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, 'f.txt'), 'old')
    copyDirRecursive(src, dst)
    expect(fs.readFileSync(path.join(dst, 'f.txt'), 'utf8')).toBe('new')
  })

  it('skips symlinks rather than following them out of the tree', () => {
    const outside = path.join(dir, 'outside.txt')
    fs.writeFileSync(outside, 'secret')
    fs.symlinkSync(outside, path.join(src, 'link.txt'))
    fs.writeFileSync(path.join(src, 'real.txt'), 'real')
    copyDirRecursive(src, dst)
    expect(fs.existsSync(path.join(dst, 'link.txt'))).toBe(false)
    expect(fs.readFileSync(path.join(dst, 'real.txt'), 'utf8')).toBe('real')
  })

  // The reason this helper exists instead of fs.cpSync: on Node 22 cpSync
  // aborts the whole process on an unreadable directory, so a best-effort
  // caller's try/catch never runs. Here it must be an ordinary JS throw.
  it('throws a catchable EACCES when a subdirectory cannot be read', () => {
    const blocked = path.join(src, 'blocked')
    fs.mkdirSync(blocked, { recursive: true })
    fs.writeFileSync(path.join(blocked, 'f.txt'), 'x')
    fs.chmodSync(blocked, 0o000)
    try {
      let code: string | undefined
      expect(() => {
        try {
          copyDirRecursive(src, dst)
        } catch (err) {
          code = (err as NodeJS.ErrnoException).code
          throw err
        }
      }).toThrow()
      expect(code).toBe('EACCES')
    } finally {
      fs.chmodSync(blocked, 0o755)
    }
  })
})
