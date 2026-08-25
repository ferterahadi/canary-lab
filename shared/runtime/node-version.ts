// The Node floor lives in package.json `engines`, which npm only WARNS about:
// installing canary-lab on an unsupported Node succeeds, and the failure lands
// later somewhere unrelated — a require() of an ESM-only dependency, deep inside
// a command the user was running for another reason. This module is the check
// that turns that into one sentence at the entry point.
//
// Pure and dependency-free on purpose: the guard has to run before the module
// graph loads, so anything it imports is one more thing that could break first.
import { compareSemver } from './registry-version'

/** Must match `engines.node` in package.json — pinned by node-version.test.ts,
 *  because two sources of truth for a floor is how one of them goes stale. */
export const MINIMUM_NODE_VERSION = '22.12.0'

/**
 * False only when the running Node is definitively older than the floor.
 *
 * An unparseable version passes: `compareSemver` reports unknown versions as
 * equal, and refusing to start over a version string we could not read would be
 * a worse failure than the later one this is pre-empting.
 */
export function meetsMinimumNode(
  current: string,
  minimum: string = MINIMUM_NODE_VERSION,
): boolean {
  return compareSemver(current, minimum) >= 0
}

/** The whole message an unsupported Node gets. Says what is wrong, why nothing
 *  stopped the install, and the one action that fixes it. */
export function formatUnsupportedNode(
  current: string,
  minimum: string = MINIMUM_NODE_VERSION,
): string {
  return [
    `canary-lab needs Node ${minimum} or newer — this is Node ${current}.`,
    'npm only warns about that, so the install itself succeeded.',
    '',
    `Upgrade Node (for example \`nvm install 22\` or \`brew upgrade node\`), then run the command again.`,
  ].join('\n')
}
