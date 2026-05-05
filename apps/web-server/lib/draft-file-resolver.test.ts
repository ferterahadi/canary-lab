import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveDraftFile } from './draft-file-resolver'

let logsDir: string
const DRAFT_ID = 'd1'

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-dfr-')))
  const gen = path.join(logsDir, 'drafts', DRAFT_ID, 'generated')
  fs.mkdirSync(path.join(gen, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(gen, 'feature.config.cjs'), 'module.exports = {}')
  fs.writeFileSync(path.join(gen, 'tests', 'login.spec.ts'), 'test("x", () => {})')
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

describe('resolveDraftFile', () => {
  it('resolves a valid relative path inside generated/', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, 'feature.config.cjs')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absolute.endsWith('feature.config.cjs')).toBe(true)
  })

  it('resolves nested files', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, 'tests/login.spec.ts')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absolute.endsWith(path.join('tests', 'login.spec.ts'))).toBe(true)
  })

  it('rejects ".." traversal', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, '../../etc/passwd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-path')
  })

  it('rejects absolute paths', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, '/etc/passwd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-path')
  })

  it('rejects empty / leading-slash variants', () => {
    expect(resolveDraftFile(logsDir, DRAFT_ID, '').ok).toBe(false)
    const slash = resolveDraftFile(logsDir, DRAFT_ID, '\\bad')
    expect(slash.ok).toBe(false)
  })

  it('returns not-found for a missing file', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, 'missing.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('returns not-found for a normalized path to the generated root', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, '.')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('rejects directory path (not a file)', () => {
    const r = resolveDraftFile(logsDir, DRAFT_ID, 'tests')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })
})
