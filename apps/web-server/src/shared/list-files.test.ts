import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listFiles } from './list-files'
import { listFiles as artifactFiles } from '../features/runs/logic/run-artifacts'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-walk-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('listFiles', () => {
  it('walks in directory order, including hidden files but excluding every symlink', () => {
    fs.mkdirSync(path.join(root, 'nested'))
    fs.mkdirSync(path.join(root, 'empty'))
    fs.writeFileSync(path.join(root, 'nested', 'child.txt'), 'child')
    fs.writeFileSync(path.join(root, '.hidden'), 'hidden')
    fs.writeFileSync(path.join(root, 'last.txt'), 'last')
    fs.symlinkSync(path.join(root, 'last.txt'), path.join(root, 'file-link'))
    fs.symlinkSync(root, path.join(root, 'nested', 'cycle'))
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'))
    fs.symlinkSync(path.join(root, 'nested'), path.join(root, 'directory-link'))
    const expected = fs.readdirSync(root).flatMap((name) => name === 'nested'
      ? [path.join(root, name, 'child.txt')]
      : ['.hidden', 'last.txt'].includes(name) ? [path.join(root, name)] : [])
    expect(listFiles(root)).toEqual(expected)
    expect(artifactFiles(root)).toEqual(expected)
    expect(listFiles(path.join(root, 'empty'))).toEqual([])
  })

  it('propagates missing-directory and non-directory errors', () => {
    fs.writeFileSync(path.join(root, 'file'), '')
    expect(() => listFiles(path.join(root, 'missing'))).toThrow()
    expect(() => listFiles(path.join(root, 'file'))).toThrow()
  })
})
