import fs from 'fs'
import path from 'path'
import { createFeatureSkeleton, deleteFeature } from '../../../config/logic/feature-authoring'
import { readFeatureConfig } from '../../../config/logic/config-ast'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import type { FlightCheckpoint } from '../types'
import { featureDirFor, type FlightStageDeps } from './context'
import type { ScoutDraft } from './scout'

// Scaffold the feature with the existing create_feature core, lay the scout's
// draft config over the skeleton's placeholder, then park on config-approval
// against the REAL on-disk feature.config.cjs (non-yolo). The user edits it in
// place (Feature Setup digest) or via FeatureConfigEditor — both write the
// same doc — and `approve` re-reads the disk, so whatever they saved is what
// gets boot-verified next (env-capture's dry-run boot). `redraft` rewinds to
// scout for a fresh draft. Idempotent on resume: an already-scaffolded feature
// with this flight's config re-parks on approval instead of silently passing.

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

/** Injects `group:` after `name:` when the flight carries one (plan-features
 *  launches tag sibling features with a shared group) — the scout draft never
 *  contains the field, so this is a plain insert, not a replace. */
function withGroup(configSource: string, group: string | undefined): string {
  if (!group) return configSource
  return configSource.replace(/(\bname\s*:\s*(['"`])(?:(?!\2).)*\2\s*,?)/, `$1\n  group: '${group}',`)
}

export function scaffoldStage(deps: FlightStageDeps): StageAdapter {
  const approvalCheckpoint = (ctx: StageContext, extra?: { error?: string }): FlightCheckpoint => {
    const m = ctx.manifest()
    const configPath = path.join(featureDirFor(deps, m.feature), 'feature.config.cjs')
    let configSource = ''
    try {
      configSource = fs.readFileSync(configPath, 'utf-8')
    } catch {
      /* checkpoint still renders; approve will fail loudly */
    }
    return {
      kind: 'config-approval',
      message: extra?.error
        ? `The edited feature.config.cjs for "${m.feature}" does not parse — fix it and approve again. (${extra.error})`
        : `Feature "${m.feature}" is set up. Review the configuration (edit it in place via each service's ✎), then approve — it gets boot-verified after env capture. Redraft re-runs the repo scan.`,
      options: ['approve', 'redraft'],
      data: { feature: m.feature, configPath, configSource, ...(extra?.error ? { error: extra.error } : {}) },
    }
  }

  const ensureScaffolded = (ctx: StageContext): { ok: true; featureDir: string; written?: string[]; reused?: boolean } | { ok: false; outcome: StageOutcome } => {
    const m = ctx.manifest()
    const scout = m.stages.find((s) => s.key === 'scout')
    const draft = scout?.evidence as ScoutDraft | undefined
    if (!draft?.configSource) {
      return { ok: false, outcome: { kind: 'failed', error: 'no scout draft to scaffold from' } }
    }

    const configPath = path.join(featureDirFor(deps, m.feature), 'feature.config.cjs')
    // Resume: the feature already carries this flight's config, or the marker
    // says THIS flight scaffolded it (covers a user who edited the config via
    // the digest/editor while the approval was parked — still ours, never a
    // collision). A same-named feature with unrelated content is a collision
    // (similarity said "new") — fall through to the free-name pick.
    const markerPath = path.join(ctx.flightDir, 'scaffolded-feature')
    const writeMarker = (feature: string) => {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true })
      fs.writeFileSync(markerPath, feature)
    }
    let marker: string | null = null
    try {
      marker = fs.readFileSync(markerPath, 'utf-8').trim()
    } catch {
      /* no marker yet */
    }
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf-8')
      if (existing === withGroup(withFeatureName(draft.configSource, m.feature), m.opts.group) || marker === m.feature) {
        writeMarker(m.feature)
        return { ok: true, featureDir: featureDirFor(deps, m.feature), reused: true }
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
    if (!created.ok) return { ok: false, outcome: { kind: 'failed', error: created.error } }

    const finalConfig = withGroup(withFeatureName(draft.configSource, feature), m.opts.group)
    fs.writeFileSync(path.join(created.featureDir, 'feature.config.cjs'), finalConfig)
    try {
      readFeatureConfig(finalConfig)
    } catch (err) {
      // readFeatureConfig only ever throws real Error/SyntaxError instances.
      return { ok: false, outcome: { kind: 'failed', error: `scaffolded config does not parse: ${(err as Error).message}` } }
    }

    writeMarker(feature)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-created', feature })
    return { ok: true, featureDir: created.featureDir, written: created.written }
  }

  return {
    async run(ctx) {
      const scaffolded = ensureScaffolded(ctx)
      if (!scaffolded.ok) return scaffolded.outcome
      const m = ctx.manifest()
      const evidence = {
        featureDir: scaffolded.featureDir,
        ...(scaffolded.written ? { written: scaffolded.written } : {}),
        ...(scaffolded.reused ? { reused: true } : {}),
      }
      if (m.opts.yolo) return { kind: 'done', evidence }
      return { kind: 'checkpoint', checkpoint: approvalCheckpoint(ctx) }
    },
    async onCheckpointResponse(ctx, response) {
      const m = ctx.manifest()
      const configPath = path.join(featureDirFor(deps, m.feature), 'feature.config.cjs')

      // MCP/CLI clients (no editor at hand) may send the edited source in the
      // response — the disk stays the single source of truth, so write it
      // through the same path the config routes use, then validate like any
      // other edit.
      const edited = (response.data as { configSource?: string } | undefined)?.configSource
      if (typeof edited === 'string' && edited.trim() !== '') {
        fs.writeFileSync(configPath, edited)
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      }

      const choice = response.choice ?? ''
      if (choice === 'approve') {
        let source: string
        try {
          source = fs.readFileSync(configPath, 'utf-8')
        } catch {
          return { kind: 'failed', error: `feature.config.cjs disappeared from ${configPath}` }
        }
        try {
          readFeatureConfig(source)
        } catch (err) {
          // A live-editable config can be mid-edit — re-park with the parse
          // error instead of failing the flight.
          return { kind: 'checkpoint', checkpoint: approvalCheckpoint(ctx, { error: (err as Error).message }) }
        }
        return {
          kind: 'done',
          evidence: { featureDir: featureDirFor(deps, m.feature), approved: true },
        }
      }
      if (choice === 'redraft') {
        return { kind: 'rewind', to: 'scout', reason: 'config redraft requested at the approval checkpoint' }
      }
      // Legacy clients may still send 'reject' — honor it as a pause-worthy
      // failure, but it is no longer offered (Pause/Stop cover that intent).
      if (choice === 'reject') {
        return { kind: 'failed', error: 'config rejected at the approval checkpoint' }
      }
      return { kind: 'checkpoint', checkpoint: approvalCheckpoint(ctx) }
    },
    // R78 restart wipe. Guard: the whole feature dir goes ONLY when the marker
    // proves THIS flight scaffolded it — a pre-existing suite (the similarity →
    // enhance path) must survive a restart; its flight-collected contents are
    // wiped by the later stages' own resets instead.
    async reset(ctx) {
      const markerPath = path.join(ctx.flightDir, 'scaffolded-feature')
      let marker: string | null = null
      try {
        marker = fs.readFileSync(markerPath, 'utf-8').trim()
      } catch {
        /* no marker — not ours to delete */
      }
      if (marker && marker === ctx.manifest().feature) {
        const deleted = deleteFeature(
          { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
          { feature: marker, confirmName: marker },
        )
        if (deleted.ok) {
          publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-deleted', feature: marker })
        }
      }
      fs.rmSync(markerPath, { force: true })
    },
  }
}
