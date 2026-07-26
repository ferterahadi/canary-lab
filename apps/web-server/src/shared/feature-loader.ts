import fs from 'fs'
import path from 'path'
import { DEFAULT_HEAL_ON_FAILURE_THRESHOLD, type FeatureConfig } from '../../../../shared/launcher/types'
import { normalizeStartCommand, validateHealthCheck } from './launcher-startup'

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
    const candidate = ['feature.config.cjs', 'feature.config.js', 'feature.config.ts']
      .map((name) => path.join(featuresDir, dir, name))
      .find((p) => fs.existsSync(p))
    if (!candidate) continue
    try {
      // Bust the require cache so tests can rewrite a fixture and re-load.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      delete require.cache[require.resolve(candidate)]
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate)
      const cfg = (mod.config ?? mod.default) as FeatureConfig | undefined
      if (cfg && typeof cfg === 'object' && typeof cfg.name === 'string') {
        // Every feature stops & heals after a default number of failures unless
        // it opts out. `??` preserves an explicit `0` (run the full suite) and
        // any explicit N; only an absent value picks up the default.
        cfg.healOnFailureThreshold = cfg.healOnFailureThreshold ?? DEFAULT_HEAL_ON_FAILURE_THRESHOLD
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
      if (err instanceof Error && err.message.includes('healthCheck')) {
        console.error(`[canary-lab] Skipping feature "${dir}" — invalid feature.config: ${err.message}`)
      }
      /* skip malformed config */
    }
  }
  return out
}

// Find a spec file glob result for a feature. Returns absolute paths.
export function listSpecFiles(featureDir: string): string[] {
  const e2eDir = path.join(featureDir, 'e2e')
  if (!fs.existsSync(e2eDir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(e2eDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      out.push(path.join(e2eDir, entry.name))
    }
  }
  return out.sort()
}
