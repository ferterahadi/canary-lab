import fs from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { listFiles } from './list-files'
import { listFiles as artifactFiles } from '../features/runs/logic/run-artifacts'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('file-walk-')

let root: string
beforeEach(() => { root = tempDir() })

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
