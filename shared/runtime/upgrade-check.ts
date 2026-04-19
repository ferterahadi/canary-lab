import fs from 'fs'
import path from 'path'

const STAMP_FILENAME = '.canary-lab-version'

export interface DriftState {
  installed: string | null
  stamped: string | null
  drift: boolean
}

export function stampPath(projectRoot: string): string {
  return path.join(projectRoot, 'logs', STAMP_FILENAME)
}

/**
 * Reads the installed canary-lab package.json version. Resolved relative to
 * the compiled module location (`dist/shared/runtime/upgrade-check.js`), so
 * it points at the package root in both dev (`<repo>/package.json`) and
 * production (`node_modules/canary-lab/package.json`).
 */
export function getInstalledPackageVersion(
  pkgJsonPath: string = path.join(__dirname, '..', '..', '..', 'package.json'),
): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

export function readStamp(projectRoot: string): string | null {
  try {
    const raw = fs.readFileSync(stampPath(projectRoot), 'utf-8').trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export function writeStamp(projectRoot: string, version: string): void {
  const p = stampPath(projectRoot)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, version + '\n')
  } catch {
    /* non-fatal */
  }
}

/**
 * Side-effect-free check. Compares the installed package version against the
 * version stamp in `<project>/logs/.canary-lab-version`. The stamp is written
 * by `canary-lab upgrade`, so drift means the user's scaffolded files
 * (skills, managed docs) were synced for an older version.
 */
export function checkUpgradeDrift(
  projectRoot: string,
  installed: string | null = getInstalledPackageVersion(),
): DriftState {
  const stamped = readStamp(projectRoot)
  const drift = installed !== null && stamped !== installed
  return { installed, stamped, drift }
}

/**
 * Human-readable message for a drift state, or null when there's nothing to
 * say. Kept separate from the check so callers can render it however they
 * like (colour, indent, etc.).
 */
export function formatDriftNotice(state: DriftState): string | null {
  if (!state.drift || !state.installed) return null
  const origin =
    state.stamped === null
      ? 'have never been synced for this version'
      : `were last synced at ${state.stamped}`
  return (
    `canary-lab: installed version is ${state.installed}, but scaffolded files ${origin}.\n` +
    `Run \`npx canary-lab upgrade\` to refresh skills and managed docs.`
  )
}
