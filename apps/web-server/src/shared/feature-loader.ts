import { listSpecFiles as sharedListSpecFiles, type SpecInventoryVersion } from '../../../../shared/spec-files'
import fs from 'fs'
import path from 'path'
import { DEFAULT_HEAL_ON_FAILURE_THRESHOLD, type FeatureConfig } from '../../../../shared/launcher/types'
import { normalizeStartCommand, validateHealthCheck } from './launcher-startup'
import { validateSingleAttempt } from './single-attempt'
import { FEATURE_CONFIG_NAMES, findExistingConfig } from './config-file'

// Discover features by scanning <featuresDir>/<feature>/feature.config.{cjs,js,ts}.
// Takes an explicit featuresDir so tests can point at a fixture tree.

export function loadFeatures(featuresDir: string): FeatureConfig[] {
  if (!fs.existsSync(featuresDir)) return []
  const out: FeatureConfig[] = []
  const dirs = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  for (const dir of dirs) {
    const candidate = findExistingConfig(path.join(featuresDir, dir), FEATURE_CONFIG_NAMES)?.path
    if (!candidate) continue
    try {
      // Bust the require cache so tests can rewrite a fixture and re-load.
       
      delete require.cache[require.resolve(candidate)]
       
      const mod = require(candidate)
      const cfg = (mod.config ?? mod.default) as FeatureConfig | undefined
      if (cfg && typeof cfg === 'object' && typeof cfg.name === 'string') {
        // Every feature stops & heals after a default number of failures unless
        // it opts out. `??` preserves an explicit `0` (run the full suite) and
        // any explicit N; only an absent value picks up the default.
        cfg.healOnFailureThreshold = cfg.healOnFailureThreshold ?? DEFAULT_HEAL_ON_FAILURE_THRESHOLD
        validateSingleAttempt(cfg.singleAttempt)
        // Validate every healthCheck shape — surface invalid configs at
        // load time with a descriptive error rather than at run time
        // when the orchestrator hits an unknown probe shape.
        for (const repo of cfg.repos ?? []) {
          for (let i = 0; i < (repo.startCommands ?? []).length; i++) {
            const norm = normalizeStartCommand(repo.startCommands![i], `${repo.name}-cmd-${i + 1}`)
            validateHealthCheck(norm.healthCheck, { feature: cfg.name, command: norm.name! })
          }
        }
        out.push(cfg)
      }
    } catch (err) {
      // A single malformed feature must not brick the whole workspace — one bad
      // generated config would otherwise take down `canary-lab ui` for every
      // feature. Surface healthCheck/validation errors loudly on the console
      // (the same place the user launched the UI) and skip just that feature,
      // so it is visibly unavailable rather than crashing the server. Truly
      // malformed configs (syntax errors, etc.) are skipped quietly as before.
      if (err instanceof Error && /healthCheck|singleAttempt/.test(err.message)) {
        console.error(`[canary-lab] Skipping feature "${dir}" — invalid feature.config: ${err.message}`)
      }
      /* skip malformed config */
    }
  }
  return out
}

export function findFeature(featuresDir: string, name: string): FeatureConfig | undefined {
  return loadFeatures(featuresDir).find((feature) => feature.name === name)
}

export type SuiteAvailability =
  | { kind: 'ready'; feature: FeatureConfig; configPath: string }
  | { kind: 'removed' }
  | { kind: 'config-missing'; featureDir: string; configPath: string; diagnostic: string }
  | { kind: 'config-invalid'; featureDir: string; configPath: string; diagnostic: string }

/** Resolve the discovery folder separately from a configured, possibly linked,
 * test directory. A suite omitted by loadFeatures is not necessarily deleted. */
export function suiteAvailability(featuresDir: string, name: string): SuiteAvailability {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name || !fs.existsSync(featuresDir)) return { kind: 'removed' }
  const feature = findFeature(featuresDir, name)
  const entry = fs.readdirSync(featuresDir, { withFileTypes: true }).find((item) => item.name === name && item.isDirectory())
  if (!entry && !feature) return { kind: 'removed' }
  const discoveryDir = entry ? path.join(featuresDir, name) : feature!.featureDir
  const configPath = findExistingConfig(discoveryDir, FEATURE_CONFIG_NAMES)?.path
  if (feature && fs.existsSync(feature.featureDir)) return { kind: 'ready', feature, configPath: configPath ?? path.join(discoveryDir, 'feature.config.cjs') }
  if (feature) return { kind: 'removed' }
  return configPath
    ? { kind: 'config-invalid', featureDir: discoveryDir, configPath, diagnostic: `Suite configuration could not load: ${path.basename(configPath)} is invalid or names a different suite.` }
    : { kind: 'config-missing', featureDir: discoveryDir, configPath: path.join(discoveryDir, 'feature.config.cjs'), diagnostic: 'Suite configuration is missing: feature.config.cjs, .js, or .ts was not found.' }
}

export function listSpecFiles(featureDir: string, version?: SpecInventoryVersion): string[] {
  return sharedListSpecFiles(featureDir, version)
}
