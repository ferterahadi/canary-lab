import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  resolveMcpOutputDir,
  ensureMcpOutputDir,
  listArtifacts,
  capArtifacts,
  renderHealIndexBullet,
  discoverPerFailureBullets,
  writeAttribution,
  MAX_FILES_PER_FAILURE,
  MAX_BYTES_PER_FAILURE,
} from './playwright-mcp-artifacts'

let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-mcp-')))
})

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('resolveMcpOutputDir', () => {
  it('uses per-failure dir when exactly one failure', () => {
    const r = resolveMcpOutputDir({ runDir: '/run', failedSlugs: ['test-case-one'] })
    expect(r.perFailure).toBe(true)
    expect(r.dir).toBe('/run/failed/test-case-one/playwright-mcp')
    expect(r.slug).toBe('test-case-one')
  })

  it('uses shared run dir when multiple failures', () => {
    const r = resolveMcpOutputDir({ runDir: '/run', failedSlugs: ['a', 'b'] })
    expect(r.perFailure).toBe(false)
    expect(r.dir).toBe('/run/playwright-mcp')
    expect(r.slug).toBeUndefined()
  })

  it('uses shared run dir when no failures', () => {
    const r = resolveMcpOutputDir({ runDir: '/run', failedSlugs: [] })
    expect(r.perFailure).toBe(false)
  })
})

describe('ensureMcpOutputDir', () => {
  it('creates the dir recursively', () => {
    const dir = path.join(tmp, 'a', 'b', 'c')
    ensureMcpOutputDir(dir)
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('listArtifacts', () => {
  it('returns [] for missing dir', () => {
    expect(listArtifacts(path.join(tmp, 'nope'))).toEqual([])
  })

  it('lists files sorted by mtime ascending and skips _-prefixed sidecars', async () => {
    fs.writeFileSync(path.join(tmp, 'console-1.log'), 'one')
    fs.writeFileSync(path.join(tmp, 'console-2.log'), 'two')
    fs.writeFileSync(path.join(tmp, '_attribution.json'), '[]')
    fs.mkdirSync(path.join(tmp, 'sub'))
    // Force a known mtime ordering.
    const now = Date.now() / 1000
    fs.utimesSync(path.join(tmp, 'console-1.log'), now - 10, now - 10)
    fs.utimesSync(path.join(tmp, 'console-2.log'), now, now)
    const list = listArtifacts(tmp)
    expect(list.map((a) => a.name)).toEqual(['console-1.log', 'console-2.log'])
  })

  it('tolerates files vanishing mid-stat', () => {
    // Just ensure the catch path is reachable by stating in a missing dir.
    expect(listArtifacts(path.join(tmp, 'missing'))).toEqual([])
  })
})

describe('capArtifacts', () => {
  it('drops oldest beyond maxFiles', () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmp, `f-${i}.log`), 'x')
      const t = Date.now() / 1000 + i
      fs.utimesSync(path.join(tmp, `f-${i}.log`), t, t)
    }
    const r = capArtifacts(tmp, { maxFiles: 3 })
    expect(r.kept).toHaveLength(3)
    expect(r.evicted.length).toBe(2)
    expect(fs.existsSync(path.join(tmp, 'f-0.log'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'f-4.log'))).toBe(true)
  })

  it('drops oldest beyond maxBytes', () => {
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(tmp, `b-${i}.log`), Buffer.alloc(1024, 0))
      const t = Date.now() / 1000 + i
      fs.utimesSync(path.join(tmp, `b-${i}.log`), t, t)
    }
    const r = capArtifacts(tmp, { maxFiles: 100, maxBytes: 2048 })
    expect(r.kept.reduce((s, a) => s + a.bytes, 0)).toBeLessThanOrEqual(2048)
    expect(r.evicted.length).toBeGreaterThan(0)
  })

  it('uses module-level defaults when no opts given', () => {
    const r = capArtifacts(tmp)
    expect(r.kept).toEqual([])
    expect(r.evicted).toEqual([])
    // sanity-check the constants stay in sync with the docs
    expect(MAX_FILES_PER_FAILURE).toBe(10)
    expect(MAX_BYTES_PER_FAILURE).toBe(5 * 1024 * 1024)
  })

  it('tolerates unlink errors during eviction', () => {
    fs.writeFileSync(path.join(tmp, 'a.log'), 'x')
    fs.writeFileSync(path.join(tmp, 'b.log'), 'x')
    // Pre-evict the file so unlink throws ENOENT inside cap.
    const orig = fs.unlinkSync
    let calls = 0
    ;(fs as unknown as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = (
      p: fs.PathLike,
    ) => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return orig(p)
    }
    try {
      const r = capArtifacts(tmp, { maxFiles: 1 })
      expect(r.evicted.length).toBe(1)
    } finally {
      ;(fs as unknown as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = orig
    }
  })
})

describe('renderHealIndexBullet', () => {
  it('returns null for empty artifact list', () => {
    expect(renderHealIndexBullet({ runDir: '/r', slug: 's', artifacts: [] })).toBeNull()
  })

  it('renders relative path + count', () => {
    const out = renderHealIndexBullet({
      runDir: '/r',
      slug: 'test-case-foo',
      artifacts: [
        { name: 'a.log', path: '/x/a.log', bytes: 1, mtimeMs: 0 },
        { name: 'b.log', path: '/x/b.log', bytes: 1, mtimeMs: 0 },
      ],
    })
    expect(out).toBe('  - playwright-mcp: failed/test-case-foo/playwright-mcp/ (2 files)')
  })
})

describe('discoverPerFailureBullets', () => {
  it('returns bullets only for slugs with artifacts', () => {
    const runDir = tmp
    const a = path.join(runDir, 'failed', 'a', 'playwright-mcp')
    fs.mkdirSync(a, { recursive: true })
    fs.writeFileSync(path.join(a, 'console.log'), 'x')
    const out = discoverPerFailureBullets({ runDir, slugs: ['a', 'b'] })
    expect(Object.keys(out)).toEqual(['a'])
    expect(out.a).toContain('failed/a/playwright-mcp/')
  })
})

describe('writeAttribution', () => {
  it('attributes each file to the most-recently-failed test before its mtime', () => {
    const dir = tmp
    fs.mkdirSync(dir, { recursive: true })
    const artifacts = [
      { name: 'one.log', path: path.join(dir, 'one.log'), bytes: 1, mtimeMs: 100 },
      { name: 'two.log', path: path.join(dir, 'two.log'), bytes: 1, mtimeMs: 250 },
    ]
    const entries = writeAttribution({
      dir,
      artifacts,
      failureEndTimes: [
        { slug: 'first', endTimeMs: 50 },
        { slug: 'second', endTimeMs: 200 },
        { slug: 'third', endTimeMs: 400 },
      ],
    })
    expect(entries).toEqual([
      { filename: 'one.log', testSlug: 'first' },
      { filename: 'two.log', testSlug: 'second' },
    ])
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, '_attribution.json'), 'utf-8'),
    )
    expect(written).toHaveLength(2)
  })

  it('falls back to first slug or unknown when no failure precedes mtime', () => {
    const dir = tmp
    fs.mkdirSync(dir, { recursive: true })
    const out = writeAttribution({
      dir,
      artifacts: [{ name: 'x.log', path: path.join(dir, 'x.log'), bytes: 1, mtimeMs: 0 }],
      failureEndTimes: [],
    })
    expect(out[0].testSlug).toBe('unknown')

    const out2 = writeAttribution({
      dir,
      artifacts: [{ name: 'y.log', path: path.join(dir, 'y.log'), bytes: 1, mtimeMs: 5 }],
      failureEndTimes: [{ slug: 'only', endTimeMs: 999 }],
    })
    expect(out2[0].testSlug).toBe('only')
  })
})
