import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoverageInputReads } from './input-reads'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-inputs-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

describe('coverage input checks', () => {
  it('tracks missing files, directory membership, linked trees and cycles without traversing outputs', () => {
    fs.mkdirSync(path.join(root, 'nested'))
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'nested', 'data.json'), '[]')
    fs.symlinkSync(root, path.join(root, 'nested', 'cycle'))
    const inputs = new CoverageInputReads()
    inputs.tree(root, true)
    inputs.optional(path.join(root, 'missing'))
    expect(inputs.isFile(path.join(root, 'missing'))).toBe(false)
    expect(inputs.isFile(path.join(root, 'nested', 'data.json'))).toBe(true)
    expect(inputs.isFile(root)).toBe(false)
    expect(inputs.isDirectory(path.join(root, 'missing'))).toBe(false)
    expect(inputs.unchanged()).toBe(true)
    fs.writeFileSync(path.join(root, 'node_modules', 'noise'), 'not an input')
    expect(inputs.unchanged()).toBe(true)
    fs.writeFileSync(path.join(root, 'missing'), 'now present')
    expect(inputs.unchanged()).toBe(false)
  })

  it('does not traverse nested directories when only top-level documents are inputs', () => {
    fs.mkdirSync(path.join(root, 'nested'))
    const inputs = new CoverageInputReads()
    inputs.tree(root, false)
    fs.writeFileSync(path.join(root, 'nested', 'ignored'), 'not selected')
    expect(inputs.unchanged()).toBe(true)
    fs.writeFileSync(path.join(root, 'selected.md'), '# New source')
    expect(inputs.unchanged()).toBe(false)
  })

  it('shares input checks across suites but never across reconciliation rounds', () => {
    const file = path.join(root, 'shared.md')
    fs.writeFileSync(file, 'same')
    const first = new CoverageInputReads()
    const second = new CoverageInputReads()
    first.text(file); second.text(file)
    const read = vi.spyOn(fs, 'readFileSync')
    const memo = new Map<string, string>()
    expect(first.unchanged(memo)).toBe(true)
    expect(second.unchanged(memo)).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    fs.writeFileSync(file, 'next')
    expect(first.unchanged()).toBe(false)
  })

  it('rejects inputs that changed within a calculation even if their original bytes return', () => {
    const file = path.join(root, 'source.md')
    fs.writeFileSync(file, 'before')
    const inputs = new CoverageInputReads()
    inputs.text(file)
    fs.writeFileSync(file, 'after')
    inputs.text(file)
    fs.writeFileSync(file, 'before')
    expect(inputs.unchanged()).toBe(false)
  })

  it('retains read errors as inputs and detects recovery without pretending unreadable bytes are equal', () => {
    const file = path.join(root, 'source.md')
    fs.writeFileSync(file, 'known bytes')
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('unavailable') })
    const inputs = new CoverageInputReads()
    inputs.optional(file)
    read.mockRestore()
    expect(inputs.unchanged()).toBe(false)
    const directory = new CoverageInputReads()
    directory.directory(root)
    fs.renameSync(root, `${root}-moved`)
    try { expect(directory.unchanged()).toBe(false) }
    finally { fs.renameSync(`${root}-moved`, root) }
  })
})
