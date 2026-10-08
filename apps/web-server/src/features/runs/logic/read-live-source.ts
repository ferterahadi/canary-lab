import fs from 'fs'
import path from 'path'

export function readLiveSource(featureDir: string, relativePath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(featureDir, relativePath), 'utf8')
  } catch {
    return undefined // Missing or unreadable live source cannot supply requirement ids or integrity hints.
  }
}
