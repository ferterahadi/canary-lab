/** Display/count identity only: retain authored paths and first-seen order.
 * Filesystem identity, Git roots, and locking belong to the server. */
export function distinctRepoPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((value) => {
    const key = value.replace(/[\\/]+$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
