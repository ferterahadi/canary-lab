import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../test-helpers/temp-dir'
import { json } from './files'

const temp = trackTempDirs('study-json-')
afterEach(() => vi.restoreAllMocks())

it('creates parents and replaces exact pretty JSON while preserving existing permissions', () => {
  const file = path.join(temp(), 'nested', 'study.json')
  json(file, { first: true })
  expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "first": true\n}\n')
  fs.chmodSync(file, 0o640)
  json(file, { next: [1, 2] })
  expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "next": [\n    1,\n    2\n  ]\n}\n')
  expect(fs.statSync(file).mode & 0o777).toBe(0o640)
  expect(fs.readdirSync(path.dirname(file))).toEqual(['study.json'])
})

it('preserves the original file and removes its staging file when replacement fails', () => {
  const dir = temp()
  const file = path.join(dir, 'study.json')
  json(file, { original: true })
  const failure = new Error('rename denied')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure })
  expect(() => json(file, { replacement: true })).toThrow(failure)
  expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "original": true\n}\n')
  expect(fs.readdirSync(dir)).toEqual(['study.json'])
})

it('keeps staging independent when another writer replaces the same target before rename', () => {
  const dir = temp()
  const file = path.join(dir, 'study.json')
  const rename = fs.renameSync
  const staged: fs.PathLike[] = []
  // Interleave at the exact boundary that races across processes: A has staged
  // its body, then B completes before A renames. A must still publish A's body.
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    staged.push(from)
    if (staged.length === 1) json(file, { writer: 'B' })
    rename(from, to)
  })
  json(file, { writer: 'A' })
  expect(new Set(staged).size).toBe(2)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ writer: 'A' })
  expect(fs.readdirSync(dir)).toEqual(['study.json'])
})
