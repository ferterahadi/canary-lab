import path from 'path'

export function sameWorkspacePath(left: string, right: string): boolean {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
