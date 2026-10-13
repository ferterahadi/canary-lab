import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { porcelainPath } from './git-status-path'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { initGitRepo } from '../../../../tools/test-helpers/git-repo'

const tempDir = trackTempDirs('git-paths-')

let root: string | undefined
afterEach(() => { root = undefined })

describe('porcelainPath', () => {
  it.each([
    [' M src/app.ts', 'src/app.ts'],
    ['?? new/file.ts', 'new/file.ts'],
    ['R  old/name.ts -> new/name.ts', 'new/name.ts'],
    [' M "src/with space.ts"', 'src/with space.ts'],
    [' M left -> right.txt', 'left -> right.txt'],
    ['??  padded ', ' padded '],
    [' M " padded "', ' padded '],
    [' M ""', ''],
    ['C  "old -> name" -> "new -> name"', 'new -> name'],
    [' R source -> "target\\tname"', 'target\tname'],
    ['RM "source\\\" -> name" -> target', 'target'],
    [' M "caf\\303\\251-😀.txt"', 'café-😀.txt'],
    [' M "\\a\\b\\f\\n\\r\\t\\v\\\"\\\\"', '\x07\b\f\n\r\t\v"\\'],
  ])('decodes %j without losing filename bytes', (line, expected) => {
    expect(porcelainPath(line)).toBe(expected)
  })

  it.each([
    '"unterminated', '"bad\\q"', '"bad\\40"', '"bad\\400"', '"bad\\777"',
    '"bad\\"', '"has"suffix', '"raw\ttab"',
  ])('retains the entire malformed payload %j', (payload) => {
    expect(porcelainPath(` M ${payload}`)).toBe(payload)
    expect(porcelainPath(`R  old -> ${payload}`)).toBe(`old -> ${payload}`)
    expect(porcelainPath(`C  ${payload} -> new`)).toBe(`${payload} -> new`)
  })

  it.each(['missing-separator', 'old -> ', ' -> new', 'old -> middle -> new'])('keeps an unrecognized rename opaque: %j', (payload) => {
    expect(porcelainPath(`R  ${payload}`)).toBe(payload)
  })

  it.each(['true', 'false'])('decodes real status, renames and copies with core.quotePath=%s', (quotePath) => {
    root = tempDir()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    const names = ['plain.txt', 'with space.txt', 'tab\tfile.txt', 'café.txt', 'quote"file.txt', 'back\\slash.txt', 'left -> right.txt', ' padded ', 'line\nbreak.txt']
    for (const name of names) fs.writeFileSync(path.join(root, name), `${name}: original\n`.repeat(20))
    initGitRepo(root)
    git('config', 'core.quotePath', quotePath)
    for (const name of names) fs.appendFileSync(path.join(root, name), 'edited\n')
    const status = () => git('--no-optional-locks', 'status', '--porcelain').split('\n').filter(Boolean)
    expect(status().map(porcelainPath).sort()).toEqual([...names].sort())

    const destination = 'new -> "café"\tname.txt'
    git('mv', 'left -> right.txt', destination)
    const rename = status().find((line) => line.startsWith('R'))!
    expect(rename).toBeDefined()
    expect(porcelainPath(rename)).toBe(destination)

    git('config', 'status.renames', 'copies')
    fs.copyFileSync(path.join(root, 'plain.txt'), path.join(root, 'copy -> café.txt'))
    git('add', '.')
    const copy = status().find((line) => line.startsWith('C'))!
    expect(copy).toBeDefined()
    expect(porcelainPath(copy)).toBe('copy -> café.txt')
  })
})
