// Test names straight off an `e2e-summary.json` value, which every reader parses
// raw: a hand-edited or torn summary must degrade to "no names", never throw.
// Kept free of imports so the Playwright reporter process (heal-index) can use
// it without loading the rerun planner's TypeScript parser.

/** `passedNames`, keeping only the string entries. Empty strings are kept:
 *  callers that need them dropped (`passedNameSet`) filter on top. */
export function passedNames(summary: { passedNames?: unknown }): string[] {
  const raw: unknown[] = Array.isArray(summary.passedNames) ? summary.passedNames : []
  return raw.filter((name): name is string => typeof name === 'string')
}

/** The non-empty `name` of each `failed[]` entry, in order. */
export function failedNames(summary: { failed?: unknown }): string[] {
  const raw: unknown[] = Array.isArray(summary.failed) ? summary.failed : []
  return raw
    .map((entry) => {
      const name = (entry as { name?: unknown } | null | undefined)?.name
      return typeof name === 'string' ? name : ''
    })
    .filter((name) => name.length > 0)
}
