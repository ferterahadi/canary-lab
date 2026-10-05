import fs from 'fs'
import { loadFeatures } from '../../../shared/feature-loader'
import { findExistingConfig, type ResolvedConfigPath } from '../../../shared/config-file'
import type { ConfigValue } from '../../../shared/config-ast'

/** Keep lookup precedence shared while the caller owns write/rename policy. */
export function resolveConfigDocument(featuresDir: string, name: string, candidates: string[], missingConfig: 'config file' | 'playwright config') {
  const features = loadFeatures(featuresDir)
  const feature = features.find((entry) => entry.name === name)
  if (!feature?.featureDir) return { ok: false as const, missing: 'feature' }
  const cfg = findExistingConfig(feature.featureDir, candidates)
  if (!cfg) return { ok: false as const, missing: missingConfig }
  return { ok: true as const, features, feature, cfg }
}

export function readConfigDocument<T>(cfg: ResolvedConfigPath, parse: (content: string) => T) {
  const content = fs.readFileSync(cfg.path, 'utf-8')
  return { path: cfg.path, format: cfg.format, content, parsed: parse(content) }
}

export function writeConfigDocument<T>(
  cfg: ResolvedConfigPath,
  value: ConfigValue,
  serialize: (source: string, value: ConfigValue) => string,
  parse: (content: string) => T,
) {
  const source = fs.readFileSync(cfg.path, 'utf-8')
  let content: string
  try {
    content = serialize(source, value)
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
  // Only serialization errors are client errors. I/O and parsing failures
  // retain the route's server-error path, and must not announce a saved config.
  fs.writeFileSync(cfg.path, content)
  return { ok: true as const, document: { path: cfg.path, format: cfg.format, content, parsed: parse(content) } }
}
