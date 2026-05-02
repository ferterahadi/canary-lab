import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../shared/launcher/types'
import { normalizeStartCommand, validateHealthCheck } from '../../../shared/launcher/startup'

// Discover features by scanning <featuresDir>/<feature>/feature.config.{cjs,js,ts}.
// Mirrors `discoverFeatures` in shared/e2e-runner/runner.ts but takes an
// explicit featuresDir so tests can point at a fixture tree.

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
      // Re-throw validation errors so the user sees them; swallow truly
      // malformed configs (syntax errors, etc.) the same as before.
      if (err instanceof Error && err.message.includes('healthCheck')) throw err
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
