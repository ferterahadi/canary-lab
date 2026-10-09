import { afterEach, describe, expect, it } from 'vitest'
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

  // The live failure: `init` under a Claude Code scratchpad
  // (`/private/tmp/claude-<uid>/…`) registered its cli.js in the global client
  // configs, because on macOS os.tmpdir() is `/var/folders/…/T` and never names
  // `/tmp`. A real directory under `/tmp` exercises both spellings at once.
  describe.skipIf(process.platform === 'win32')('the POSIX /tmp root', () => {
    const made: string[] = []
    afterEach(() => {
      for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })
    const mkTmp = () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'canary-lab-temp-path-'))
      made.push(dir)
      return dir
    }

    it('accepts a real directory under /tmp by its raw path', () => {
      expect(isUnderTempDir(path.join(mkTmp(), 'project', 'cli.js'))).toBe(true)
    })

    // On macOS this is `/private/tmp/…`; on Linux `/tmp` is not a link and the
    // realpath is the raw path again — either way it must still read as temp.
    it('accepts the same directory by its realpath', () => {
      expect(isUnderTempDir(path.join(fs.realpathSync(mkTmp()), 'project', 'cli.js'))).toBe(true)
    })

    it('accepts /private/tmp even where it is not a real directory', () => {
      expect(isUnderTempDir('/private/tmp/claude-0/scratchpad/project')).toBe(true)
    })

    // Negative controls: the new roots must not swallow a durable path that
    // merely shares their spelling.
    it('rejects a sibling whose name extends /tmp', () => {
      expect(isUnderTempDir('/tmpfiles/project')).toBe(false)
      expect(isUnderTempDir('/private/tmpfiles/project')).toBe(false)
    })

    it('rejects a real durable directory', () => {
      expect(isUnderTempDir(os.homedir())).toBe(false)
      expect(isUnderTempDir('/usr/local/lib/node_modules/canary-lab/dist/apps/cli/cli.js')).toBe(false)
    })
  })

  // $TMPDIR is honoured through os.tmpdir(), not read separately — a root that
  // does not exist also proves a failed realpath leaves the raw form guarding.
  describe('a custom $TMPDIR', () => {
    const saved = process.env.TMPDIR
    afterEach(() => {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
    })

    it.skipIf(process.platform === 'win32')('accepts a path under it', () => {
      process.env.TMPDIR = '/nonexistent-canary-temp-root'
      expect(isUnderTempDir('/nonexistent-canary-temp-root/project')).toBe(true)
    })
  })

  // Windows keeps os.tmpdir() as its only root: `/tmp` there would resolve to a
  // drive-relative `\tmp` that is an ordinary folder.
  describe('on Windows', () => {
    const realPlatform = process.platform
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    })

    it('does not treat /tmp as a temp root', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      expect(isUnderTempDir('/tmp/project')).toBe(false)
      expect(isUnderTempDir(path.join(os.tmpdir(), 'project'))).toBe(true)
    })
  })
})
