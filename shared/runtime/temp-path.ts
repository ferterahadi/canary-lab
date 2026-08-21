import fs from 'fs'
import os from 'os'
import path from 'path'

// Is this path inside the OS temp directory? Two callers need the same answer
// about two different kinds of path, which is why it lives here rather than
// beside either one: a CLI path under temp must never be written into a global
// client config (see `isTempInstallPath`), and a live server whose project root
// is under temp must never win an ambiguous pick (see `resolveActiveServer`).
// Both rest on the same fact — a temp path is one the OS may delete without
// warning, so anything durable that points at it is already broken.
export function isUnderTempDir(target: string): boolean {
  const resolved = path.resolve(target)
  // Both forms: on macOS os.tmpdir() is `/var/folders/…` while a real path under
  // it resolves to `/private/var/folders/…`, so a raw-only prefix test never
  // matches.
  const roots = new Set([path.resolve(os.tmpdir())])
  try {
    roots.add(fs.realpathSync(os.tmpdir()))
  } catch {
    // tmpdir unreadable — the raw form above still guards the common case.
  }
  return [...roots].some((root) => resolved === root || resolved.startsWith(root + path.sep))
}
