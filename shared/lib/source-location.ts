/** Keep numeric suffixes as authored; callers own numeric conversion and path resolution. */
export function parseSourceLocation(location: string): { file: string; line?: string; column?: string } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(location)
  if (!match) return { file: location }
  return { file: match[1], line: match[2], ...(match[3] !== undefined ? { column: match[3] } : {}) }
}
