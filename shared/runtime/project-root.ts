import fs from 'fs'
import path from 'path'

export function looksLikeProjectRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, 'features'))
}

function looksLikeCanaryLabPackage(candidate: string): boolean {
  const packageJson = path.join(candidate, 'package.json')
  if (!fs.existsSync(packageJson)) return false

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf-8')) as { name?: string }
    return parsed.name === 'canary-lab'
  } catch {
    return false
  }
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

    if (looksLikeCanaryLabPackage(current)) {
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
