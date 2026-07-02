import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFlyArgs, deriveFeatureName, findWorkspaceRoot } from './fly'

describe('parseFlyArgs', () => {
  const dirs = new Set(['/repo/shop', '/repo/api'])
  const isDir = (p: string) => dirs.has(p)

  it('splits positionals into repo paths + trailing description', () => {
    const parsed = parseFlyArgs(['/repo/shop', '/repo/api', 'checkout flow'], isDir)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.repoPaths).toEqual([path.resolve('/repo/shop'), path.resolve('/repo/api')])
    expect(parsed.args.description).toBe('checkout flow')
    // Defaults
    expect(parsed.args.env).toBe('local')
    expect(parsed.args.coverageTarget).toBe(100)
    expect(parsed.args.yolo).toBe(false)
    expect(parsed.args.fresh).toBe(false)
  })

  it('parses every flag', () => {
    const parsed = parseFlyArgs(
      ['/repo/shop', 'desc', '--feature', 'checkout', '--env', 'staging', '--coverage-target', '80', '--base', 'develop', '--yolo', '--fresh'],
      isDir,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args).toMatchObject({
      feature: 'checkout',
      env: 'staging',
      coverageTarget: 80,
      base: 'develop',
      yolo: true,
      fresh: true,
    })
  })

  it('rejects a missing description (last positional is a directory)', () => {
    const parsed = parseFlyArgs(['/repo/shop', '/repo/api'], isDir)
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('is a directory') })
  })

  it('rejects a repo path that does not exist', () => {
    const parsed = parseFlyArgs(['/repo/shop', '/repo/nope', 'desc'], isDir)
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('/repo/nope') })
  })

  it('rejects too few positionals, unknown flags, bad coverage targets, and missing flag values', () => {
    expect(parseFlyArgs(['desc'], isDir).ok).toBe(false)
    expect(parseFlyArgs(['/repo/shop', 'desc', '--wat'], isDir).ok).toBe(false)
    expect(parseFlyArgs(['/repo/shop', 'desc', '--coverage-target', '150'], isDir).ok).toBe(false)
    expect(parseFlyArgs(['/repo/shop', 'desc', '--feature'], isDir).ok).toBe(false)
    expect(parseFlyArgs(['/repo/shop', 'desc', '--feature', '--yolo'], isDir).ok).toBe(false)
  })
})

describe('deriveFeatureName', () => {
  it('prefers the explicit --feature name', () => {
    expect(deriveFeatureName(['/x/My Shop'], 'checkout')).toBe('checkout')
  })
  it('slugs the first repo basename otherwise', () => {
    expect(deriveFeatureName(['/x/My Shop_v2'])).toBe('my-shop-v2')
    expect(deriveFeatureName(['/x/---'])).toBe('first-flight')
  })
})

describe('findWorkspaceRoot', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-fly-ws-')))
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('walks up to the nearest dir whose package.json depends on canary-lab', () => {
    const ws = path.join(tmpDir, 'lab')
    const nested = path.join(ws, 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ dependencies: { 'canary-lab': '^1.0.0' } }))
    expect(findWorkspaceRoot(nested)).toBe(ws)
  })

  it('ignores a bare features/ dir (a product repo may have one) and returns null when nothing matches', () => {
    const repo = path.join(tmpDir, 'product')
    fs.mkdirSync(path.join(repo, 'features'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'product', dependencies: {} }))
    expect(findWorkspaceRoot(repo)).toBeNull()
  })
})
