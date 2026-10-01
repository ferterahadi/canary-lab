import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach } from 'vitest'

/** A maker of real temp directories for one test file, each removed after the
 *  test that made it. Call it at module scope: it registers the `afterEach`.
 *
 *  Each directory is realpath'd because macOS's `os.tmpdir()` sits behind the
 *  `/var` → `/private/var` symlink, and code under test that resolves a path
 *  (git does, `process.cwd()` does) would otherwise report a different string
 *  for the same directory than the test holds. */
export function trackTempDirs(prefix: string): (override?: string) => string {
  const made: string[] = []
  afterEach(() => {
    while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true })
  })
  return (override = prefix) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), override)))
    made.push(dir)
    return dir
  }
}
