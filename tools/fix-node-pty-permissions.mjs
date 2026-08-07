#!/usr/bin/env node
// Belt for the node-pty spawn-helper permission bug — see
// shared/node-pty-permissions.ts for what it is and why.
//
// This hook is NOT the real fix any more, because npm can refuse to run it
// (`ignore-scripts`, npm 11's `allowScripts` gate) and a workspace installed
// that way used to fail every run with an undiagnosable abort. The spawner
// applies the same fix at the point of use. This just gets it done earlier
// when npm does let us.
//
// Silent no-op when `dist/` isn't built yet — that is the source-repo install,
// where the build follows and the runtime path covers it regardless.

const distModule = new URL('../dist/shared/node-pty-permissions.js', import.meta.url)

try {
  const { ensureSpawnHelperExecutable } = await import(distModule.href)
  ensureSpawnHelperExecutable()
} catch {
  // not built, or node-pty absent — the spawner will handle it
}
