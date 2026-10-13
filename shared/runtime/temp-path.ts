import fs from 'fs'
import os from 'os'
import path from 'path'

// Is this path inside an OS temp directory? Two callers need the same answer
// about two different kinds of path, which is why it lives here rather than
// beside either one: a CLI path under temp must never be written into a global
// client config (see `isTempInstallPath`), and a live server whose project root
// is under temp must never win an ambiguous pick (see `resolveActiveServer`).
// Both rest on the same fact — a temp path is one the OS may delete without
// warning, so anything durable that points at it is already broken.
export function isUnderTempDir(target: string): boolean {
  const resolved = path.resolve(target)
  return tempRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

// os.tmpdir() already honours $TMPDIR on POSIX (TMPDIR → TMP → TEMP → /tmp), so
// listing $TMPDIR separately would add nothing. It is not the only temp root,
// though: macOS points it at the per-user `/var/folders/…/T` while `/tmp` —
// where Claude Code session scratchpads and most hand-made throwaway projects
// live — is a second sweepable root it never mentions. Observed live: an `init`
// under `/private/tmp/claude-<uid>/…` wrote its cli.js into the global Desktop,
// Claude Code, and Codex configs. Windows has no `/tmp`, so it keeps os.tmpdir()
// alone rather than matching a drive-relative `\tmp` by accident.
function tempRoots(): string[] {
  const candidates = [os.tmpdir()]
  if (process.platform !== 'win32') candidates.push('/tmp', '/private/tmp')
  // Both forms of each: on macOS os.tmpdir() is `/var/folders/…` and `/tmp` is a
  // symlink, while a real path under either resolves to `/private/…`, so a
  // raw-only prefix test never matches.
  const roots = new Set<string>()
  for (const candidate of candidates) {
    roots.add(path.resolve(candidate))
    try {
      roots.add(fs.realpathSync(candidate))
    } catch {
      // Root absent (no `/private/tmp` off macOS) — the raw form above still guards.
    }
  }
  return [...roots]
}
