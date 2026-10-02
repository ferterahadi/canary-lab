import fs from 'fs'
import path from 'path'
import { readFeatureConfig, writeFeatureConfig } from '../../../shared/config-ast'
import { FEATURE_CONFIG_NAMES, findExistingConfig } from '../../../shared/config-file'

export interface EnvsetsConfigJson {
  appRoots?: Record<string, string>
  slots?: Record<string, { description?: string; target?: string }>
  feature?: { slots?: string[]; testCommand?: string; testCwd?: string }
}

/** Missing metadata is optional; unreadable or invalid existing metadata must not
 * become an empty configuration that a later mutation overwrites. */
export function readEnvsetsConfig(envsetsDir: string): EnvsetsConfigJson {
  const cfgPath = path.join(envsetsDir, 'envsets.config.json')
  let source: string
  try {
    source = fs.readFileSync(cfgPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw Object.assign(new Error('envsets.config.json must contain a valid JSON object'), { statusCode: 409 })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('envsets.config.json must contain a valid JSON object'), { statusCode: 409 })
  }
  return parsed as EnvsetsConfigJson
}

export function writeEnvsetsConfig(envsetsDir: string, cfg: EnvsetsConfigJson): void {
  fs.mkdirSync(envsetsDir, { recursive: true })
  const cfgPath = path.join(envsetsDir, 'envsets.config.json')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
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

