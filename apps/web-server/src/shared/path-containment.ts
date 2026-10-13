import fs from 'fs'
import path from 'path'

/** Lexical only: callers own realpath resolution and any filesystem policy. */
export function isPathUnder(child: string, parent: string, allowEqual: boolean): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return allowEqual
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** `relative` resolved inside `root`, or a throw when it would leave it.
 * Existing parents are resolved too, so a missing file behind a symlink cannot
 * pass the boundary a readable file would not. */
export function confinedFile(root: string, relative: string): string {
  const realRoot = fs.realpathSync(root)
  const target = path.resolve(realRoot, relative)
  let parent = target
  while (!fs.existsSync(parent)) parent = path.dirname(parent)
  const realTarget = path.resolve(fs.realpathSync(parent), path.relative(parent, target))
  if (!isPathUnder(realTarget, realRoot, false)) throw new Error('Test file is outside the suite')
  return realTarget
}
