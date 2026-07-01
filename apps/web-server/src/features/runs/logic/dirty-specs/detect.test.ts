import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeDirty,
  hashContent,
  hashFeatureSpecs,
  hashFeatureSpecTests,
  listFeatureSpecs,
  promoteGreen,
  type DirtyBaseline,
} from './detect'
import * as astExtractor from '../../../config/logic/ast-extractor'

const EMPTY: DirtyBaseline = { lastGreenHashes: {}, runStartHashes: {}, approvedHashes: {} }

let dir: string

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
}

function writeSpec(name: string, body: string): string {
  const rel = path.join('e2e', name)
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  return rel
}

const PASS = `test('applies voucher', async () => { expect(1).toBe(1) })\n`
const TAMPERED = `test('applies voucher', async () => { expect(1).toBe(2) })\n`

const TWO_TESTS = `test('a', async () => { expect(1).toBe(1) })
test('b', async () => { expect(2).toBe(2) })
`
const TWO_TESTS_B_EDITED = `test('a', async () => { expect(1).toBe(1) })
test('b', async () => { expect(2).toBe(3) })
`
const TWO_TESTS_HELPER_EDITED = `const helper = () => 1
test('a', async () => { expect(1).toBe(1) })
test('b', async () => { expect(2).toBe(2) })
`

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-detect-'))
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.dev'])
  git(['config', 'user.name', 'test'])
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('computeDirty', () => {
  it('is clean when content matches the run-start baseline', async () => {
    const rel = writeSpec('voucher.spec.ts', PASS)
    const runStartHashes = hashFeatureSpecs(dir)
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes })
    expect(res.status).toBe('clean')
    expect(res.dirtySpecs).toEqual([])
    expect(rel).toBe('e2e/voucher.spec.ts')
  })

  it('falls back to run-start (no green) and flags an edit', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const runStartHashes = hashFeatureSpecs(dir)
    writeSpec('voucher.spec.ts', TAMPERED)
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes })
    expect(res.status).toBe('dirty')
    expect(res.dirtySpecs).toHaveLength(1)
    expect(res.dirtySpecs[0].file).toBe('e2e/voucher.spec.ts')
    expect(res.dirtySpecs[0].affectedTests).toEqual(['applies voucher'])
  })

  it('prefers the green baseline over run-start', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const green = hashFeatureSpecs(dir)
    // run-start captured a later (tampered) content, but a real green exists
    writeSpec('voucher.spec.ts', TAMPERED)
    const runStartHashes = hashFeatureSpecs(dir)
    const res = await computeDirty(dir, { ...EMPTY, lastGreenHashes: green, runStartHashes })
    expect(res.status).toBe('dirty')
  })

  it('clears once the change is committed (matches HEAD)', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const runStartHashes = hashFeatureSpecs(dir)
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'baseline'])
    // edit then commit — stale run-start baseline still holds PASS, but HEAD now
    // matches the working tree, so the committed change reads clean.
    writeSpec('voucher.spec.ts', TAMPERED)
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'change'])
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes })
    expect(res.status).toBe('clean')
  })

  it('clears when the current content is approved', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const runStartHashes = hashFeatureSpecs(dir)
    writeSpec('voucher.spec.ts', TAMPERED)
    const approvedHashes = hashFeatureSpecs(dir)
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes, approvedHashes })
    expect(res.status).toBe('clean')
  })

  it('is clean with no baseline at all (bootstrap)', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const res = await computeDirty(dir, EMPTY)
    expect(res.status).toBe('clean')
  })

  it('narrows affectedTests to only the test whose body changed', async () => {
    writeSpec('voucher.spec.ts', TWO_TESTS)
    const runStartHashes = hashFeatureSpecs(dir)
    const runStartTestHashes = hashFeatureSpecTests(dir)
    writeSpec('voucher.spec.ts', TWO_TESTS_B_EDITED)
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes, runStartTestHashes })
    expect(res.status).toBe('dirty')
    expect(res.dirtySpecs).toHaveLength(1)
    expect(res.dirtySpecs[0].affectedTests).toEqual(['b'])
  })

  it('falls back to flagging every test when the edit is outside any test body', async () => {
    writeSpec('voucher.spec.ts', TWO_TESTS)
    const runStartHashes = hashFeatureSpecs(dir)
    const runStartTestHashes = hashFeatureSpecTests(dir)
    writeSpec('voucher.spec.ts', TWO_TESTS_HELPER_EDITED)
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes, runStartTestHashes })
    expect(res.status).toBe('dirty')
    expect(res.dirtySpecs[0].affectedTests).toEqual(['a', 'b'])
  })

  it('flags a newly added test without re-flagging unchanged siblings', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const runStartHashes = hashFeatureSpecs(dir)
    const runStartTestHashes = hashFeatureSpecTests(dir)
    writeSpec('voucher.spec.ts', `${PASS}test('new one', async () => { expect(1).toBe(1) })\n`)
    const res = await computeDirty(dir, { ...EMPTY, runStartHashes, runStartTestHashes })
    expect(res.status).toBe('dirty')
    expect(res.dirtySpecs[0].affectedTests).toEqual(['new one'])
  })

  it('skips a spec that disappears between listing and hashing (no current hash)', async () => {
    const rel = writeSpec('voucher.spec.ts', PASS)
    const abs = path.join(dir, rel)
    const runStartHashes = hashFeatureSpecs(dir)

    // `computeDirty` first lists specs (reading each file to extract test
    // titles), then separately re-hashes them. Simulate the file vanishing in
    // between: the listing read succeeds, every later read of that path fails,
    // so `current[spec.rel]` is left undefined and the spec must be skipped
    // rather than crash or falsely flag.
    const realReadFileSync = fs.readFileSync
    let calls = 0
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p: any, enc?: any) => {
      if (p === abs) {
        calls++
        if (calls > 1) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException
          err.code = 'ENOENT'
          throw err
        }
      }
      return realReadFileSync(p, enc)
    })
    try {
      const res = await computeDirty(dir, { ...EMPTY, runStartHashes })
      expect(res.status).toBe('clean')
      expect(res.dirtySpecs).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('flags a test defensively when its body hash cannot be attributed (parse mismatch)', async () => {
    writeSpec('voucher.spec.ts', PASS)
    const runStartHashes = hashFeatureSpecs(dir)
    const runStartTestHashes = hashFeatureSpecTests(dir)
    // File-level content must diverge from the baseline too, or `computeDirty`
    // never reaches the per-test loop at all (it short-circuits clean at the
    // whole-file comparison first).
    writeSpec('voucher.spec.ts', TAMPERED)

    // Simulate a test that's declared (from the file-level listing) but whose
    // body hash never lands in `currentTests` — e.g. an extractor edge case.
    // The first `extractTestsFromSource` call (inside `listFeatureSpecs`) is
    // given an extra phantom test name; every other call (per-test hashing)
    // sees the real source unmodified.
    const real = astExtractor.extractTestsFromSource
    let calls = 0
    const spy = vi.spyOn(astExtractor, 'extractTestsFromSource').mockImplementation((file, source) => {
      calls++
      const result = real(file, source)
      if (calls === 1) {
        return {
          ...result,
          tests: [
            ...result.tests,
            { name: 'phantom test', bodySource: 'unused', line: 0, steps: [] } as (typeof result.tests)[number],
          ],
        }
      }
      return result
    })
    try {
      const res = await computeDirty(dir, { ...EMPTY, runStartHashes, runStartTestHashes })
      expect(res.status).toBe('dirty')
      expect(res.dirtySpecs[0].affectedTests).toContain('phantom test')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('promoteGreen', () => {
  it('promotes untampered specs and skips tampered ones', () => {
    const runStart = { 'e2e/a.spec.ts': 'A', 'e2e/b.spec.ts': 'B' }
    const verdict = { 'e2e/a.spec.ts': 'A', 'e2e/b.spec.ts': 'B2' }
    const next = promoteGreen(runStart, verdict, {})
    expect(next).toEqual({ 'e2e/a.spec.ts': 'A' })
  })

  it('keeps prior green entries', () => {
    const next = promoteGreen({ x: '1' }, { x: '1' }, { y: '9' })
    expect(next).toEqual({ x: '1', y: '9' })
  })
})

describe('listFeatureSpecs', () => {
  it('extracts test titles per spec', () => {
    writeSpec('voucher.spec.ts', PASS)
    const specs = listFeatureSpecs(dir)
    expect(specs).toHaveLength(1)
    expect(specs[0].tests).toEqual(['applies voucher'])
    expect(hashContent(PASS)).toMatch(/^[0-9a-f]{64}$/)
  })
})
