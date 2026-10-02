import fs from 'fs'
import path from 'path'

export function readPackageBin(packageRoot: string, preferredName: string, fallbackToFirst: boolean): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'))
    const bin = typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin?.[preferredName] ?? (fallbackToFirst ? Object.values(pkg.bin ?? {}).find((value) => typeof value === 'string') : undefined)
    return typeof bin === 'string' ? bin : null
  } catch {
    // An unreadable declaration is an unavailable install; callers own recovery.
    return null
  }
}
