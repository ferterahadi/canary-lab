import { isPathUnder } from '../../../shared/path-containment'
/** True when `target` is the same as or a descendant of `root`. */
export function isWithin(root: string, target: string): boolean {
  return isPathUnder(target, root, true)
}
