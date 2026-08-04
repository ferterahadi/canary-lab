import fs from 'fs'
import os from 'os'
import path from 'path'
import { readFeatureConfig, writeFeatureConfig } from '../../../shared/config-ast'
import { getProjectRoot } from '../../../../../../shared/runtime/project-root'

export const FEATURE_CONFIG_NAMES = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']

export const PLAYWRIGHT_CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.cjs']

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

/** List the env folder names (alphabetised) under a feature's `envsets/` dir.
 *  This is the single source of truth for which envs a feature has — the
 *  `envs:` array in feature.config.cjs is auto-derived from this. */
export function listEnvFolders(featureDir: string): string[] {
  const envsetsDir = path.join(featureDir, 'envsets')
  if (!fs.existsSync(envsetsDir)) return []
  return fs
    .readdirSync(envsetsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

/** Re-sync the `envs:` array in feature.config.{cjs,js,ts} to match the
 *  envset folders on disk. Called after envset add/delete and after every
 *  feature-config save. */
export function syncEnvsInConfig(featureDir: string): void {
  const cfg = findExistingConfig(featureDir, FEATURE_CONFIG_NAMES)
  if (!cfg) return
  const source = fs.readFileSync(cfg.path, 'utf-8')
  const { value } = readFeatureConfig(source)
  const next = { ...value, envs: listEnvFolders(featureDir) }
  const written = writeFeatureConfig(source, next)
  if (written !== source) fs.writeFileSync(cfg.path, written)
}

export const SLOT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/

/** A slot is one file name inside `envsets/<env>/`, so it must be a single path
 *  segment that names a file. The character class bars a separator; `.` and
 *  `..` are barred on top of it because they name a *directory* — without that
 *  second rule `path.join(envsetsDir, env, slot)` resolves to `envsets/<env>`
 *  or to `envsetsDir` itself, and the write lands on a directory (EISDIR).
 *  Together the two rules are what make the joined path provably a file inside
 *  `envsetsDir`, so callers that build a path this way need no `isWithin`
 *  re-check. Routes taking a raw `:slot` param still do — see `envset-routes`. */
export function isValidSlotName(name: string): boolean {
  return SLOT_NAME_PATTERN.test(name) && name !== '.' && name !== '..'
}

/** True when `target` is the same as or a descendant of `root`. */
export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export interface EnvsetsConfigJson {
  appRoots?: Record<string, string>
  slots?: Record<string, { description?: string; target?: string }>
  feature?: { slots?: string[]; testCommand?: string; testCwd?: string }
}

export function readEnvsetsConfig(envsetsDir: string): EnvsetsConfigJson {
  const cfgPath = path.join(envsetsDir, 'envsets.config.json')
  if (!fs.existsSync(cfgPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as EnvsetsConfigJson
  } catch {
    return {}
  }
}

export function writeEnvsetsConfig(envsetsDir: string, cfg: EnvsetsConfigJson): void {
  fs.mkdirSync(envsetsDir, { recursive: true })
  const cfgPath = path.join(envsetsDir, 'envsets.config.json')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
}

export function buildAppRoots(cfg: EnvsetsConfigJson): Record<string, string> {
  const root = getProjectRoot()
  return {
    CANARY_LAB_PROJECT_ROOT: root,
    CANARY_LAB: root,
    ...(cfg.appRoots ?? {}),
  }
}

export function shortenHome(p: string): string {
  const home = os.homedir()
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return '~' + p.slice(home.length)
  }
  return p
}
