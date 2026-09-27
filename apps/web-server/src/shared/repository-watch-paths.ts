import fs from 'fs'
import path from 'path'
import { runGit } from './git-repo'

export interface RepositoryWatchPath {
  path: string
  recursive: boolean
  accepts: (filename: string | null) => boolean
}

export async function repositoryWatchPaths(cwd: string, scope: 'repository' | 'directory'): Promise<RepositoryWatchPath[]> {
  const target = await fs.promises.realpath(cwd)
  const gitPath = async (args: string[]) => {
    const result = await runGit(target, ['rev-parse', ...args])
    if (result.code !== 0) throw new Error(result.stderr || 'Unable to locate repository metadata')
    return result.stdout.trim()
  }
  const [root, gitDir, commonDir] = await Promise.all([
    gitPath(['--show-toplevel']), gitPath(['--absolute-git-dir']),
    gitPath(['--path-format=absolute', '--git-common-dir']),
  ])
  const [ignored, tracked] = await Promise.all([
    runGit(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
    runGit(root, ['ls-files', '-z', '--cached']),
  ])
  // If ignore discovery fails, observe conservatively. It must never hide a
  // tracked file or prevent the authoritative status read from proceeding.
  const ignoredNames = ignored.code === 0 ? ignored.stdout.split('\0').filter(Boolean) : []
  const trackedNames = new Set(tracked.stdout.split('\0').filter(Boolean))
  for (const name of [...trackedNames]) {
    let parent = path.posix.dirname(name)
    while (parent !== '.') { trackedNames.add(parent); parent = path.posix.dirname(parent) }
  }
  const contentRoot = scope === 'repository' ? root : target
  const prefix = path.relative(root, contentRoot).split(path.sep).join('/')
  const watches: RepositoryWatchPath[] = [{
    path: contentRoot, recursive: true,
    accepts: (filename) => {
      if (!filename) return true
      const name = [prefix, filename.split(path.sep).join('/')].filter(Boolean).join('/')
      if (name.startsWith('.git/')) return false // metadata has its own bounded watches
      if (tracked.code !== 0 || trackedNames.has(name)) return true
      return !ignoredNames.some((ignoredName) => name === ignoredName.replace(/\/$/, '') || (ignoredName.endsWith('/') && name.startsWith(ignoredName)))
    },
  }, {
    // A deleted/recreated directory has a new inode. Watching its parent lets
    // the next read replace the old watch instead of waiting for lease expiry.
    path: path.dirname(contentRoot), recursive: false,
    accepts: (filename) => !filename || filename === path.basename(contentRoot),
  }]
  for (const dir of new Set([gitDir, commonDir])) {
    watches.push({
      path: dir, recursive: false,
      accepts: (filename) => !filename || ['HEAD', 'index', 'packed-refs', 'config', 'config.worktree', 'refs', 'commondir'].includes(filename),
    })
    const refs = path.join(dir, 'refs')
    if (fs.existsSync(refs)) watches.push({ path: refs, recursive: true, accepts: () => true })
  }
  return watches
}
