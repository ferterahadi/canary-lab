import path from 'path'

/** True when `target` is the same as or a descendant of `root`. */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
