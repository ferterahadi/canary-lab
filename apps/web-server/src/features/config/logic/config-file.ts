import fs from 'fs'
import path from 'path'

export const FEATURE_CONFIG_NAMES = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']

export interface ResolvedConfigPath {
  path: string
  format: 'cjs' | 'js' | 'ts'
}

export function findExistingConfig(dir: string, candidates: string[]): ResolvedConfigPath | null {
  for (const name of candidates) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) {
      return { path: p, format: name.split('.').pop() as 'cjs' | 'js' | 'ts' }
    }
  }
  return null
}

