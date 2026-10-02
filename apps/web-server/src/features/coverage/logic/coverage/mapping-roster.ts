/** Preserve the caller's roster, including its order and repeated names. External
 *  workflows supply the snapshot handed to the client, not the current suite. */
export function missingFromRoster(
  roster: readonly string[],
  mappings: ReadonlyArray<{ testName: string }>,
  unmappable: readonly string[],
): string[] {
  const accounted = new Set<string>([...mappings.map((m) => m.testName), ...unmappable])
  return roster.filter((name) => !accounted.has(name))
}
