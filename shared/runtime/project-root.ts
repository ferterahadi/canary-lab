import fs from 'fs'
import path from 'path'

export function looksLikeProjectRoot(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, 'features'))
}

// A genuine Canary Lab workspace declares `canary-lab` as a dependency — that's
// what `canary-lab init` always writes. A bare `features/` dir is NOT enough:
// a stray `features/` anywhere up the tree (e.g. a feature accidentally
// scaffolded into the home dir) makes `looksLikeProjectRoot` true, which is how
// `canary-lab ui` could boot rooted at `~`. The dependency marker is the
// intentional, init-only signal that the workspace was actually set up.
export function isCanaryLabWorkspace(candidate: string): boolean {
  const packageJson = path.join(candidate, 'package.json')
  if (!fs.existsSync(packageJson)) return false
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf-8')) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return parsed.name === 'canary-lab' ||
      !!parsed.dependencies?.['canary-lab'] ||
      !!parsed.devDependencies?.['canary-lab']
  } catch {
    return false
  }
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
