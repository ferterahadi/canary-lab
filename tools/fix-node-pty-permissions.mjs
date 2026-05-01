#!/usr/bin/env node
// node-pty 1.1.0 ships the unix `spawn-helper` binary without the execute bit
// in its npm tarball, so every fresh `npm install` leaves it as mode 644 and
// `pty.spawn()` fails with "posix_spawnp failed". This is a known upstream
// packaging bug; we fix it on our side via a postinstall hook so canary-lab
// works after a clean install on every machine.
//
// Silent no-op when node-pty isn't installed (e.g. Windows-only consumer
// who pruned it) or when the prebuild for this platform doesn't exist.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * Resolve node-pty's package root, or null if it isn't installed.
 * Exported (not just for postinstall) so tests can stub the resolver.
 */
export function resolveNodePtyRoot(requireFn = createRequire(import.meta.url)) {
  try {
    return path.dirname(requireFn.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

/**
 * chmod 0o755 every spawn-helper candidate under the given node-pty root.
 * Returns the list of files that were actually chmodded (existed and were
 * writable). Missing files are silently skipped — different platforms ship
 * different prebuilds.
 */
export function fixSpawnHelperPermissions(ptyRoot, platform = process.platform, arch = process.arch) {
  if (platform === 'win32' || ptyRoot == null) return []
  const candidates = [...new Set([
    path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'linux-x64', 'spawn-helper'),
    path.join(ptyRoot, 'prebuilds', 'linux-arm64', 'spawn-helper'),
  ])]
  const fixed = []
  for (const file of candidates) {
    try {
      fs.chmodSync(file, 0o755)
      fixed.push(file)
    } catch {
      // missing prebuild for this triple — skip silently
    }
  }
  return fixed
}

// Run as CLI when invoked directly (postinstall entry point). Skip when
// imported by tests.
const isCli = import.meta.url === `file://${process.argv[1]}`
if (isCli) {
  fixSpawnHelperPermissions(resolveNodePtyRoot())
}
