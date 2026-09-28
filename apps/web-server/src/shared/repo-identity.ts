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
