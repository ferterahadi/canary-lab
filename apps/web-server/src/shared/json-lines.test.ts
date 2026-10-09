import fs from 'fs'
import path from 'path'
import { expect, it } from 'vitest'
import { trackTempDirs } from '../../../../tools/test-helpers/temp-dir'
import { appendJsonLine, readJsonLines } from './json-lines'

const temp = trackTempDirs('json-lines-')
const isString = (value: unknown): value is string => typeof value === 'string'

it('distinguishes unavailable files from readable empty files', () => {
  const root = temp()
  const file = path.join(root, 'events.jsonl')
  expect(readJsonLines(file, isString)).toBeUndefined()
  expect(readJsonLines(root, isString)).toBeUndefined()
  fs.writeFileSync(file, ' \r\n\n')
  expect(readJsonLines(file, isString)).toEqual([])
})

it('preserves accepted order and duplicates around corrupt or invalid records', () => {
  const file = path.join(temp(), 'events.jsonl')
  fs.writeFileSync(file, ' "first" \r\nnull\n{broken\n12\n"second"\n"first"\n{"partial":')
  expect(readJsonLines(file, isString)).toEqual(['first', 'second', 'first'])
})

it('appends one JSON line per value, creating the parent directory on first use', () => {
  const file = path.join(temp(), 'nested', 'events.jsonl')
  appendJsonLine(file, 'first')
  appendJsonLine(file, { second: true })
  expect(fs.readFileSync(file, 'utf-8')).toBe('"first"\n{"second":true}\n')
  expect(readJsonLines(file, isString)).toEqual(['first'])
})
