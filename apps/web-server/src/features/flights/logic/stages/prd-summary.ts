import fs from 'fs'
import path from 'path'
import { clearPrdSummary, regeneratePrdSummary } from '../../../coverage/logic/coverage/service'
import { readPrdSummary } from '../../../coverage/logic/coverage/prd-summary'
import { writeWorkflowAgentRef } from '../../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { StageAdapter } from '../conductor'
import { featureDirFor, type FlightStageDeps } from './context'
import { agentProgressSink } from './agent-progress'

// Distill features/<f>/docs/ into the requirement summary through the
// existing agentic PRD engine (stable requirement ids preserved by the engine
// itself). Harness predicate: _prd-summary.json exists with ≥1 live
// requirement — never the agent's word for it. Skipped when a fresh summary
// already covers the docs (resume / enhance path).

function newestDocMtime(featureDir: string): number {
  const docsDir = path.join(featureDir, 'docs')
  let newest = 0
  try {
    for (const f of fs.readdirSync(docsDir)) {
      if (f.startsWith('_')) continue
      const mtime = fs.statSync(path.join(docsDir, f)).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch {
    /* no docs dir */
  }
  return newest
}

export function prdSummaryStage(deps: FlightStageDeps): StageAdapter {
  return {
    async run(ctx) {
      const m = ctx.manifest()
      const featureDir = featureDirFor(deps, m.feature)

      const existing = readPrdSummary(featureDir)
      const liveCount = (s: NonNullable<ReturnType<typeof readPrdSummary>>) =>
        s.requirements.filter((r) => !r.deprecated).length
      if (existing && liveCount(existing) > 0 && Date.parse(existing.generatedAt) >= newestDocMtime(featureDir)) {
        return { kind: 'done', evidence: { requirementCount: liveCount(existing), reused: true } }
      }

      const stageDir = path.join(ctx.flightDir, 'prd-summary')
      const regenerate = deps.coverage?.regenerate ?? regeneratePrdSummary
      await regenerate({
        featuresDir: deps.featuresDir,
        feature: m.feature,
        adapter: m.opts.agent,
        cwd: deps.projectRoot,
        // Pause/abort must actually stop the distiller, not just stop waiting
        // for it — see the same hand-off in every other agent-spawning stage.
        signal: ctx.signal,
        onOutput: agentProgressSink(ctx),
        onAgentSession: (session) => {
          writeWorkflowAgentRef(stageDir, {
            agent: session.agent,
            cwd: deps.projectRoot,
            spawnedAt: new Date().toISOString(),
            sessionId: session.sessionId,
          })
        },
      })

      const summary = readPrdSummary(featureDir)
      const count = summary ? liveCount(summary) : 0
      if (!summary || count === 0) {
        return { kind: 'failed', error: 'PRD summary produced no requirements — add richer docs and resume' }
      }
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
      return { kind: 'done', evidence: { requirementCount: count } }
    },
    // R78 restart wipe: the existing coverage "redo from the start" clear —
    // drops _prd-summary.json/.md (and the downstream coverage state, which the
    // specs-coverage reset that always follows discards anyway). The docs
    // themselves belong to the docs stage; a restart HERE keeps them.
    async reset(ctx) {
      const m = ctx.manifest()
      if (!fs.existsSync(featureDirFor(deps, m.feature))) return
      clearPrdSummary({ featuresDir: deps.featuresDir, feature: m.feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: m.feature })
    },
  }
}
