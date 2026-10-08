import { distinctRepoPaths } from '../../../../shared/lib/repository-paths'
import fs from 'fs'
import os from 'os'
import path from 'path'

export function resolveRepoPath(localPath: string): string {
  if (localPath === '~') return os.homedir()
  if (localPath.startsWith('~/')) return path.join(os.homedir(), localPath.slice(2))
  return localPath
}

/** Compare configured directories, not Git roots: sibling services and separate
 * worktrees remain distinct. Historical paths may no longer be resolvable. */
export function resolveRepoIdentity(localPath: string, mode: 'required' | 'best-effort'): string {
  const absolute = path.resolve(resolveRepoPath(localPath))
  try {
    return fs.realpathSync(absolute)
  } catch (error) {
    if (mode === 'required') throw error
    return absolute
  }
}

/** Repository order is incidental; repeated entries retain their multiplicity. */
export function sameRepoSet(a: readonly string[], b: readonly string[]): boolean {
  const norm = (paths: readonly string[]) => paths.map((p) => resolveRepoIdentity(p, 'best-effort')).sort().join('\n')
  return norm(a) === norm(b)
}


export function resolveRepoPaths(paths: readonly string[]): { ok: true; paths: string[] } | { ok: false; path: string } {
  const resolved: string[] = []
  for (const candidate of paths) {
    try {
      resolved.push(resolveRepoIdentity(candidate, 'required'))
    } catch {
      return { ok: false, path: candidate }
    }
  }
  return { ok: true, paths: resolved }
}


/** Configuration reads expand home paths before counting; no filesystem probe
 * is needed, so missing historical directories remain readable. */
export function configuredRepoPaths(repos: readonly { localPath?: string }[] | undefined): string[] {
  return distinctRepoPaths((repos ?? []).map((repo) => repo.localPath)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(resolveRepoPath))
}
