import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadFeatures } from '../../../config/logic/feature-loader'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import type { FlightStageDeps } from './context'

// Pre-flight similarity check: never silently create a near-duplicate of a
// feature that already covers the target repo(s). Deterministic scan — no
// agent. On a hit the flight parks on a three-way choice (rerun / enhance /
// new), the same ask-don't-guess philosophy as the run loop's repo-collision
// choice; `--yolo` defaults to rerun (the no-duplication path).

function real(p: string): string {
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
  try {
    return fs.realpathSync(path.resolve(expanded))
  } catch {
    return path.resolve(expanded)
  }
}

interface Match {
  feature: string
  description: string
  repo: string
}

function findMatch(deps: FlightStageDeps, repoPaths: string[], log: (m: string) => void): { match: Match | null; scanned: number } {
  const targets = new Set(repoPaths.map(real))
  let features: ReturnType<typeof loadFeatures> = []
  try {
    features = loadFeatures(deps.featuresDir)
  } catch (err) {
    // A broken unrelated feature config must not ground the flight — scan what
    // loads and say so.
    log(`[similarity] feature scan degraded: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  for (const feature of features) {
    for (const repo of feature.repos ?? []) {
      if (targets.has(real(repo.localPath))) {
        return {
          match: { feature: feature.name, description: feature.description, repo: repo.localPath },
          scanned: features.length,
        }
      }
    }
  }
  return { match: null, scanned: features.length }
}

function applyChoice(ctx: StageContext, match: Match, choice: string): StageOutcome {
  if (choice === 'rerun') {
    ctx.patchFlight({ feature: match.feature })
    return { kind: 'jump', to: 'run', skipReason: `rerun of existing feature ${match.feature}`, evidence: { match, choice } }
  }
  if (choice === 'enhance') {
    ctx.patchFlight({ feature: match.feature })
    return { kind: 'jump', to: 'docs', skipReason: `enhancing existing feature ${match.feature}`, evidence: { match, choice } }
  }
  // 'new' — proceed fresh; scaffold picks a non-colliding feature name.
  return { kind: 'done', evidence: { match, choice: 'new' } }
}

export function similarityStage(deps: FlightStageDeps): StageAdapter {
  return {
    async run(ctx) {
      const m = ctx.manifest()
      const { match, scanned } = findMatch(deps, m.repoPaths, ctx.appendLog)
      if (!match) return { kind: 'done', evidence: { scanned, match: null } }
      if (m.opts.yolo) {
        ctx.appendLog(`[similarity] ${match.feature} already covers ${match.repo} — yolo defaults to rerun\n`)
        return applyChoice(ctx, match, 'rerun')
      }
      return {
        kind: 'checkpoint',
        checkpoint: {
          kind: 'similarity-choice',
          message: `Feature "${match.feature}" already targets ${match.repo} ("${match.description}"). Rerun it, enhance it with this flight's docs/specs delta, or create a new feature?`,
          options: ['rerun', 'enhance', 'new'],
          data: { match },
        },
      }
    },
    async onCheckpointResponse(ctx, response) {
      const m = ctx.manifest()
      const stage = m.stages.find((s) => s.key === 'similarity')
      const match = (stage?.checkpoint?.data as { match?: Match } | undefined)?.match
      if (!match) return this.run(ctx)
      const choice = response.choice ?? ''
      if (!['rerun', 'enhance', 'new'].includes(choice)) {
        return {
          kind: 'checkpoint',
          checkpoint: stage!.checkpoint!,
        }
      }
      return applyChoice(ctx, match, choice)
    },
  }
}
