import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
// @ts-expect-error — plain .mjs helper, no type declarations by design.
import {
  DEMO_DIRECTORY_NAME,
  createDemoRoot,
  demoDirectory,
  parseDemoCleanupArgs,
  referencedDemoRoots,
  removeDemoRoots,
} from './demo-workspace.mjs'

const tmpDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('demo workspace location', () => {
  it('creates an interactive demo under the user home on every platform', () => {
    const homeDir = makeTempDir('cl-demo-home-')
    const root = createDemoRoot({ persistent: true, homeDir, tempDir: '/unused' })

    expect(root.startsWith(`${path.join(homeDir, DEMO_DIRECTORY_NAME, 'canary-lab-demo-')}`)).toBe(true)
    expect(fs.statSync(root).isDirectory()).toBe(true)
  })

  it('keeps the automated smoke demo in OS temp storage', () => {
    const homeDir = makeTempDir('cl-demo-home-')
    const tempDir = makeTempDir('cl-demo-temp-')
    const root = createDemoRoot({ persistent: false, homeDir, tempDir })

    expect(path.dirname(root)).toBe(tempDir)
    expect(fs.existsSync(demoDirectory(homeDir))).toBe(false)
  })
})

describe('parseDemoCleanupArgs', () => {
  it('accepts age and explicit force in either supported combination', () => {
    expect(parseDemoCleanupArgs([])).toEqual({ force: false, olderThanDays: 0 })
    expect(parseDemoCleanupArgs(['--older-than', '7', '--force'])).toEqual({ force: true, olderThanDays: 7 })
  })

  it('rejects unknown or invalid arguments before cleanup starts', () => {
    expect(() => parseDemoCleanupArgs(['--unknown'])).toThrow('Usage:')
    expect(() => parseDemoCleanupArgs(['--older-than', '-1'])).toThrow('Usage:')
  })
})

describe('removeDemoRoots', () => {
  it('removes only generated demo roots', () => {
    const homeDir = makeTempDir('cl-demo-clean-')
    const parent = demoDirectory(homeDir)
    const demoRoot = createDemoRoot({ persistent: true, homeDir, tempDir: '/unused' })
    const unrelated = path.join(parent, 'notes')
    fs.mkdirSync(unrelated)

    expect(removeDemoRoots({ homeDir })).toEqual({ removed: [demoRoot], skipped: [] })
    expect(fs.existsSync(demoRoot)).toBe(false)
    expect(fs.existsSync(unrelated)).toBe(true)
  })

  it('supports age-based pruning', () => {
    const homeDir = makeTempDir('cl-demo-age-')
    const oldRoot = createDemoRoot({ persistent: true, homeDir, tempDir: '/unused' })
    const recentRoot = createDemoRoot({ persistent: true, homeDir, tempDir: '/unused' })
    const now = Date.now()
    fs.utimesSync(oldRoot, new Date(now - 10 * 24 * 60 * 60 * 1000), new Date(now - 10 * 24 * 60 * 60 * 1000))

    expect(removeDemoRoots({ homeDir, olderThanDays: 7, now })).toEqual({ removed: [oldRoot], skipped: [] })
    expect(fs.existsSync(recentRoot)).toBe(true)
  })

  it('refuses to traverse a symlinked demo directory', () => {
    const homeDir = makeTempDir('cl-demo-link-')
    const target = makeTempDir('cl-demo-link-target-')
    fs.symlinkSync(target, demoDirectory(homeDir), 'dir')

    expect(() => removeDemoRoots({ homeDir })).toThrow('Refusing to clean')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('skips a demo named by the real workspace registry', () => {
    const homeDir = makeTempDir('cl-demo-registered-')
    const demoRoot = createDemoRoot({ persistent: true, homeDir, tempDir: '/unused' })
    const registryDir = path.join(homeDir, '.canary-lab')
    fs.mkdirSync(registryDir)
    fs.writeFileSync(path.join(registryDir, 'workspaces.json'), JSON.stringify({
      version: 1,
      workspaces: [{ name: 'demo-project', path: path.join(demoRoot, 'demo-project') }],
    }))
    const protectedRoots = referencedDemoRoots(homeDir)

    expect(removeDemoRoots({ homeDir, protectedRoots })).toEqual({ removed: [], skipped: [demoRoot] })
    expect(fs.existsSync(demoRoot)).toBe(true)
  })

  it('refuses cleanup when it cannot verify the real registry', () => {
    const homeDir = makeTempDir('cl-demo-registry-')
    const registryDir = path.join(homeDir, '.canary-lab')
    fs.mkdirSync(registryDir)
    fs.writeFileSync(path.join(registryDir, 'workspaces.json'), '{ broken')

    expect(() => referencedDemoRoots(homeDir)).toThrow('Refusing to clean')
  })
})
