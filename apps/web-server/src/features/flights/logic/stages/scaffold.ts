import fs from 'fs'
import path from 'path'
import { createFeatureSkeleton } from '../../../config/logic/feature-authoring'
import { readFeatureConfig } from '../../../config/logic/config-ast'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { StageAdapter } from '../conductor'
import { featureDirFor, type FlightStageDeps } from './context'
import type { ScoutDraft } from './scout'

// Scaffold the feature with the existing create_feature core, then lay the
// scout's approved config over the skeleton's placeholder. Idempotent on
// resume: an already-scaffolded feature with a parseable config is done.

function freeFeatureName(deps: FlightStageDeps, wanted: string): string {
  if (!fs.existsSync(featureDirFor(deps, wanted))) return wanted
  for (let i = 2; ; i += 1) {
    const candidate = `${wanted}-${i}`
    if (!fs.existsSync(featureDirFor(deps, candidate))) return candidate
  }
}

/** Rewrites the config's `name:` to the (possibly de-conflicted) feature name. */
function withFeatureName(configSource: string, feature: string): string {
  return configSource.replace(/(\bname\s*:\s*)(['"`])(?:(?!\2).)*\2/, `$1'${feature}'`)
}

export function scaffoldStage(deps: FlightStageDeps): StageAdapter {
  return {
    async run(ctx) {
      const m = ctx.manifest()
      const scout = m.stages.find((s) => s.key === 'scout')
      const draft = scout?.evidence as ScoutDraft | undefined
      if (!draft?.configSource) {
        return { kind: 'failed', error: 'no approved scout draft to scaffold from' }
      }

      const configPath = path.join(featureDirFor(deps, m.feature), 'feature.config.cjs')
      // Resume: only when the existing config IS this flight's approved draft.
      // A same-named feature with different content is a collision (similarity
      // said "new"), not a resume — fall through to the free-name pick.
      if (fs.existsSync(configPath)) {
        const existing = fs.readFileSync(configPath, 'utf-8')
        if (existing === withFeatureName(draft.configSource, m.feature)) {
          return { kind: 'done', evidence: { featureDir: featureDirFor(deps, m.feature), reused: true } }
        }
      }

      // The similarity stage said "new" (or found nothing): never overwrite an
      // existing feature — pick a free name and re-point the flight.
      const feature = freeFeatureName(deps, m.feature)
      if (feature !== m.feature) {
        ctx.appendLog(`[scaffold] feature name ${m.feature} is taken — using ${feature}\n`)
        ctx.patchFlight({ feature })
      }

      const created = createFeatureSkeleton({
        projectRoot: deps.projectRoot,
        featuresDir: deps.featuresDir,
        feature,
        description: m.description,
        envs: [m.opts.env],
      })
      if (!created.ok) return { kind: 'failed', error: created.error }

      const finalConfig = withFeatureName(draft.configSource, feature)
      fs.writeFileSync(path.join(created.featureDir, 'feature.config.cjs'), finalConfig)
      try {
        readFeatureConfig(finalConfig)
      } catch (err) {
        return { kind: 'failed', error: `scaffolded config does not parse: ${err instanceof Error ? err.message : String(err)}` }
      }

      publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-created', feature })
      return { kind: 'done', evidence: { featureDir: created.featureDir, written: created.written } }
    },
  }
}
