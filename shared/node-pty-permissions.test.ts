import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureSpawnHelperExecutable, fixSpawnHelperPermissions, resolveNodePtyRoot } from './node-pty-permissions'

let tmp: string
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fix-pty-')))
})

function makeFakePty(root: string, files: { rel: string; mode: number }[]): void {
  for (const { rel, mode } of files) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(abs, mode)
  }
}

describe('fixSpawnHelperPermissions', () => {
  it('chmods all existing spawn-helper files to 0o755', () => {
    makeFakePty(tmp, [
      { rel: 'prebuilds/darwin-arm64/spawn-helper', mode: 0o644 },
      { rel: 'prebuilds/darwin-x64/spawn-helper', mode: 0o644 },
      { rel: 'prebuilds/linux-x64/spawn-helper', mode: 0o644 },
    ])

    const fixed = fixSpawnHelperPermissions(tmp, 'darwin', 'arm64')

    expect(fixed.length).toBeGreaterThanOrEqual(3)
    for (const rel of ['prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper', 'prebuilds/linux-x64/spawn-helper']) {
      const mode = fs.statSync(path.join(tmp, rel)).mode & 0o777
      expect(mode).toBe(0o755)
    }
  })

  it('silently skips candidates that do not exist', () => {
    makeFakePty(tmp, [
      { rel: 'prebuilds/darwin-arm64/spawn-helper', mode: 0o644 },
    ])
    const fixed = fixSpawnHelperPermissions(tmp, 'darwin', 'arm64')
    expect(fixed).toEqual([path.join(tmp, 'prebuilds/darwin-arm64/spawn-helper')])
  })

  it('returns [] on win32 (no unix spawn-helper to fix)', () => {
    makeFakePty(tmp, [
      { rel: 'prebuilds/darwin-arm64/spawn-helper', mode: 0o644 },
    ])
    const fixed = fixSpawnHelperPermissions(tmp, 'win32', 'x64')
    expect(fixed).toEqual([])
    expect(fs.statSync(path.join(tmp, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(0o644)
  })

  it('returns [] when ptyRoot is null (node-pty not installed)', () => {
    expect(fixSpawnHelperPermissions(null, 'darwin', 'arm64')).toEqual([])
  })

  it('also covers build/Release/spawn-helper for source-built node-pty', () => {
    makeFakePty(tmp, [
      { rel: 'build/Release/spawn-helper', mode: 0o644 },
    ])
    const fixed = fixSpawnHelperPermissions(tmp, 'linux', 'x64')
    expect(fixed).toContain(path.join(tmp, 'build/Release/spawn-helper'))
    expect(fs.statSync(path.join(tmp, 'build/Release/spawn-helper')).mode & 0o777).toBe(0o755)
  })
})

describe('ensureSpawnHelperExecutable', () => {
  it('fixes the real node-pty install and is idempotent', () => {
    // The regression this guards: a workspace whose npm blocked install
    // scripts left spawn-helper at 0o644, every run aborted with
    // "posix_spawnp failed", and nothing said why.
    const first = ensureSpawnHelperExecutable()
    expect(first.length).toBeGreaterThan(0)
    for (const file of first) {
      expect(fs.statSync(file).mode & 0o777).toBe(0o755)
    }
    expect(ensureSpawnHelperExecutable()).toEqual(first)
  })
})

describe('resolveNodePtyRoot', () => {
  it('resolves node-pty when installed', () => {
    // node-pty is a real dependency in this repo, so the real resolver should
    // find it. We don't assert the exact path — just that it ends in `node-pty`.
    const root = resolveNodePtyRoot()
    expect(root).not.toBeNull()
    expect(path.basename(root!)).toBe('node-pty')
  })

  it('returns null when require.resolve throws', () => {
    const fakeRequire = { resolve: () => { throw new Error('not found') } }
    expect(resolveNodePtyRoot(fakeRequire)).toBeNull()
  })
})
