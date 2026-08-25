import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { isUnderTempDir } from './temp-path'

describe('isUnderTempDir', () => {
  it('accepts a path inside the OS temp dir', () => {
    expect(isUnderTempDir(path.join(os.tmpdir(), 'canary-lab-demo-x', 'demo-project'))).toBe(true)
  })

  it('accepts the temp dir itself', () => {
    expect(isUnderTempDir(os.tmpdir())).toBe(true)
  })

  // The bug this covers: on macOS `os.tmpdir()` is `/var/folders/…` while a real
  // path under it resolves to `/private/var/folders/…`, so comparing against the
  // raw form alone matched nothing and every temp path read as durable.
  it('accepts the realpath form of the temp dir', () => {
    const real = fs.realpathSync(os.tmpdir())
    expect(isUnderTempDir(path.join(real, 'canary-lab-demo-x'))).toBe(true)
  })

  it('rejects a durable workspace path', () => {
    expect(isUnderTempDir(path.join(os.homedir(), 'Documents', 'canary-lab-workspace'))).toBe(false)
  })

  // A sibling that merely shares a string prefix is not inside the directory.
  it('rejects a sibling whose name extends the temp dir', () => {
    expect(isUnderTempDir(`${path.resolve(os.tmpdir())}-not-temp`)).toBe(false)
  })
})
