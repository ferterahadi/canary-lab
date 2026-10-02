import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturedEnvsetCount } from './envset-evidence'
import { hasCapturedEnvset } from './stage-evidence'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-evidence-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

function env(name: string): string {
  const dir = path.join(root, 'envsets', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('capturedEnvsetCount', () => {
  it('reports no evidence for missing, empty, unreadable or non-directory envsets', () => {
    expect(capturedEnvsetCount(root)).toBeUndefined()
    expect(capturedEnvsetCount(root, 'local')).toBeUndefined()
    env('local')
    expect(capturedEnvsetCount(root)).toBeUndefined()
    fs.writeFileSync(path.join(root, 'envsets', 'file'), 'x')
    expect(capturedEnvsetCount(root, 'file')).toBeUndefined()
    expect(capturedEnvsetCount(root)).toBeUndefined()
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('unreadable') })
    expect(capturedEnvsetCount(root)).toBeUndefined()
    expect(capturedEnvsetCount(root, 'local')).toBeUndefined()
  })

  it('counts entries in the first populated directory without summing or following directory links', () => {
    env('empty')
    const first = env('first')
    fs.mkdirSync(path.join(first, 'nested'))
    fs.symlinkSync(path.join(root, 'missing'), path.join(first, 'link'))
    fs.writeFileSync(path.join(env('second'), '.env'), 'x')
    fs.symlinkSync(first, path.join(root, 'envsets', 'alias'))
    fs.writeFileSync(path.join(root, 'envsets', 'file'), 'x')
    const populated = fs.readdirSync(path.join(root, 'envsets'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'empty')
    const expected = populated[0].name === 'first' ? 2 : 1
    expect(capturedEnvsetCount(root)).toBe(expected)
    expect(hasCapturedEnvset(root)).toBe(true)
    expect(capturedEnvsetCount(root, 'second')).toBe(1)
    expect(capturedEnvsetCount(root, 'empty')).toBeUndefined()
    expect(hasCapturedEnvset(root, 'empty')).toBe(false)
    expect(capturedEnvsetCount(root, 'alias')).toBe(2)
    expect(capturedEnvsetCount(root, '')).toBe(5)
  })
})
