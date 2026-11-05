// The Node floor lives in package.json `engines`, which npm only WARNS about:
// installing canary-lab on an unsupported Node succeeds, and the failure lands
// later somewhere unrelated — a require() of an ESM-only dependency, deep inside
// a command the user was running for another reason. This module is the check
// that turns that into one sentence at the entry point.
//
// Pure and dependency-free on purpose: the guard has to run before the module
// graph loads, so anything it imports is one more thing that could break first.
import { compareSemver, parseSemver } from './registry-version'

/**
 * The first release of each supported Node line that carries the HTTP2Shell fix
 * (CVE-2026-111497, a remote-code-execution bug in Node's bundled Brotli
 * decoder). One floor per line, not one global minimum: 24.0.0 is newer than
 * 22.23.4 and still unpatched, so a single `>=` would let it through.
 *
 * A line missing from this list is refused — 23 and 25 are end of life and got
 * no fix. A line newer than the last entry is accepted, because it was cut
 * after the fix shipped.
 *
 * Must match `engines.node` in package.json — pinned by node-version.test.ts,
 * because two sources of truth for a floor is how one of them goes stale.
 */
export const SUPPORTED_NODE_FLOORS = ['22.23.4', '24.22.1', '26.12.1'] as const

/** The npm `engines.node` range that states `floors` — the bounded lines, then
 *  an open-ended last one. */
export function nodeEnginesRange(floors: readonly string[] = SUPPORTED_NODE_FLOORS): string {
  return floors
    .map((floor, i) => (i === floors.length - 1 ? `>=${floor}` : `>=${floor} <${majorOf(floor) + 1}.0.0`))
    .join(' || ')
}

/**
 * False only when the running Node is definitively unsupported: older than its
 * line's floor, on a line with no floor, or older than every line listed.
 *
 * An unparseable version passes: refusing to start over a version string we
 * could not read would be a worse failure than the later one this pre-empts.
 */
export function isSupportedNode(
  current: string,
  floors: readonly string[] = SUPPORTED_NODE_FLOORS,
): boolean {
  const running = parseSemver(current)
  if (!running) return true
  const floor = floors.find((f) => majorOf(f) === running.major)
  if (floor) return compareSemver(current, floor) >= 0
  return running.major > majorOf(floors[floors.length - 1])
}

/** The whole message an unsupported Node gets. Says what is wrong, why nothing
 *  stopped the install, and the one action that fixes it. */
export function formatUnsupportedNode(
  current: string,
  floors: readonly string[] = SUPPORTED_NODE_FLOORS,
): string {
  return [
    `canary-lab needs Node ${floors.join(', ')}, or a newer release on one of those lines — this is Node ${current}.`,
    'Those are the releases that fix the HTTP2Shell Brotli bug (CVE-2026-111497).',
    'npm only warns about that, so the install itself succeeded.',
    '',
    `Upgrade Node (for example \`nvm install 22\` or \`brew upgrade node\`), then run the command again.`,
  ].join('\n')
}

// Floors are literals in this file, so the leading number always parses.
function majorOf(version: string): number {
  return Number(version.split('.')[0])
}
