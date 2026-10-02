import type { PathType } from './types'

export const PATH_TYPES: PathType[] = ['happy', 'sad', 'edge']

/** Exact vocabulary matching; defaults belong to the requirement or mapping caller. */
export function canonicalPathTypes(value: unknown): PathType[] {
  if (!Array.isArray(value)) return []
  return PATH_TYPES.filter((pathType) => value.includes(pathType))
}
