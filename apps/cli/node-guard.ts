// The Node floor check, as a side-effect import.
//
// It must be the FIRST import in cli.ts and it must run at module load, not from
// main(). TypeScript emits CommonJS `require` calls in import order, so every
// other import in that file has already executed its whole module graph by the
// time any function body runs — and it is that loading which fails on an
// unsupported Node (a require() of an ESM-only dependency). A guard placed after
// it would print its message only on the runs that did not need it.
import {
  MINIMUM_NODE_VERSION,
  formatUnsupportedNode,
  meetsMinimumNode,
} from '../../shared/runtime/node-version'

/** Returns true when this Node is supported. Otherwise prints why and exits 1 —
 *  `exit` is injectable so the check itself stays testable. */
export function assertSupportedNode(
  current: string = process.versions.node,
  deps: { error?: (msg: string) => void; exit?: (code: number) => void } = {},
): boolean {
  if (meetsMinimumNode(current)) return true
  ;(deps.error ?? console.error)(formatUnsupportedNode(current, MINIMUM_NODE_VERSION))
  ;(deps.exit ?? process.exit)(1)
  return false
}

assertSupportedNode()
