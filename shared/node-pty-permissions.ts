// node-pty 1.1.0 ships the unix `spawn-helper` binary without the execute bit
// in its npm tarball, so a fresh `npm install` leaves it mode 644 and
// `pty.spawn()` dies with "posix_spawnp failed". Known upstream packaging bug.
//
// This used to be fixed only by a `postinstall` hook. That is not enough: npm
// can refuse to run install scripts (`ignore-scripts`, or npm 11's
// `allowScripts` gate), and a workspace installed that way looked healthy right
// up until the first run aborted with no diagnosable error. So the fix lives
// here and is applied at the point of use — the pty spawner calls it once
// before its first spawn — with the hook kept only as a belt.

import fs from 'node:fs'
import path from 'node:path'

/** Just the slice of `require` this module needs — keeps the fake in tests tiny
 *  and works under the CommonJS output `shared/` compiles to. */
export interface ResolverLike { resolve(id: string): string }

/** Resolve node-pty's package root, or null when it isn't installed. */
export function resolveNodePtyRoot(
  requireFn: ResolverLike = require,
): string | null {
  try {
    return path.dirname(requireFn.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

/**
 * chmod 0o755 every spawn-helper candidate under `ptyRoot`, returning the files
 * actually changed. Missing candidates are skipped silently — each platform
 * ships only its own prebuild — and win32 has no unix helper to fix.
 */
export function fixSpawnHelperPermissions(
  ptyRoot: string | null,
  platform: string = process.platform,
  arch: string = process.arch,
): string[] {
  if (platform === 'win32' || ptyRoot == null) return []
  const candidates = [...new Set([
    path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'linux-x64', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'linux-arm64', 'spawn-helper'),
  ])]
  const fixed: string[] = []
  for (const file of candidates) {
    try {
      fs.chmodSync(file, 0o755)
      fixed.push(file)
    } catch {
      // missing prebuild for this triple, or a read-only install — skip
    }
  }
  return fixed
}

/** Idempotent one-shot for long-lived processes: resolve node-pty and fix it. */
export function ensureSpawnHelperExecutable(): string[] {
  return fixSpawnHelperPermissions(resolveNodePtyRoot())
}
