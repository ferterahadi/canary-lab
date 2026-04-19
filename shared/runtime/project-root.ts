import fs from 'fs'
import path from 'path'

export function looksLikeProjectRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, 'features'))
}

export function getProjectRoot(): string {
  const explicitRoot = process.env.CANARY_LAB_PROJECT_ROOT
  if (explicitRoot) {
    return path.resolve(explicitRoot)
  }

  let current = path.resolve(process.cwd())

  while (true) {
    if (looksLikeProjectRoot(current)) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(process.cwd())
    }
    current = parent
  }
}

export function getFeaturesDir(): string {
  return path.join(getProjectRoot(), 'features')
}

