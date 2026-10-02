import path from 'path'

/** Lexical only: callers own realpath resolution and any filesystem policy. */
export function isPathUnder(child: string, parent: string, allowEqual: boolean): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return allowEqual
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
