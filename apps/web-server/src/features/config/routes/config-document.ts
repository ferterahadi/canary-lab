import fs from 'fs'
import { loadFeatures } from '../../../shared/feature-loader'
import { findExistingConfig, type ResolvedConfigPath } from '../../../shared/config-file'

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
