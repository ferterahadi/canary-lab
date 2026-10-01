import fs from 'fs'
import path from 'path'

export function resolveFirstExisting(pathsToTry: string[]): string {
  const match = pathsToTry.find((candidate) => fs.existsSync(candidate))
  if (!match) {
    throw new Error(`Could not resolve any expected path: ${pathsToTry.join(', ')}`)
  }
  return match
}

// Source runs resolve from apps/cli; installed runs resolve from dist/apps/cli.
export function resolvePackageAsset(asset: string, cliDir: string = __dirname): string {
  return resolveFirstExisting([
    path.resolve(cliDir, '../..', asset),
    path.resolve(cliDir, '../../..', asset),
  ])
}
