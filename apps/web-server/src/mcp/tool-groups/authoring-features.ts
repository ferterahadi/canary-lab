// MCP tools — feature skeletons, feature docs, and the coverage read a client
// needs before authoring. Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import { captureFeatureEnvFiles, createFeatureSkeleton, writeFeatureDoc, deleteFeatureDoc, linkFeatureDoc, type EnvFileSource } from '../../features/config/logic/feature-authoring'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  listFeatureDocs,
} from '../../features/coverage/logic/coverage/service'
import { publishWorkspaceEvent } from '../../shared/workspace-events'
import { type ToolGroupContext, asJsonResult, authoringCtx, coverageBlockedNext, errorResult, failureResult } from '../tool-support'

export function registerFeatureAuthoringTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ─── external authoring and export control ───────────────────────────

  registerTool('create_feature', {
    description: 'Create a Canary Lab feature skeleton for an external client to author tests. This never generates test cases or starts a local Claude/Codex agent.',
    inputSchema: {
      feature: z.string().describe('Feature name to create under features/<name>.'),
      description: z.string().optional(),
      envs: z.array(z.string()).optional().describe('Envset names to declare. Defaults to local.'),
      repos: z.array(z.object({
        name: z.string(),
        localPath: z.string(),
        cloneUrl: z.string().optional(),
        branch: z.string().optional(),
        startCommands: z.array(z.unknown()).optional(),
        envs: z.array(z.string()).optional(),
      })).optional(),
      envSources: z.array(z.object({
        sourcePath: z.string(),
        env: z.string().optional(),
        slot: z.string().optional(),
        target: z.string().optional(),
        description: z.string().optional(),
        confirmOverwrite: z.boolean().optional(),
      })).optional().describe('Optional env/config files to copy into feature envsets. Values are never returned.'),
    },
  }, async ({ feature, description, envs, repos, envSources }) => {
    try {
      const created = createFeatureSkeleton({
        projectRoot: deps.projectRoot,
        featuresDir: deps.featuresDir,
        workspaceEvents: deps.workspaceEvents,
        feature,
        description,
        envs,
        repos,
      })
      if (!created.ok) return errorResult(created.error)
      const captured = envSources?.length
        ? captureFeatureEnvFiles(authoringCtx(deps), { feature, sources: envSources as EnvFileSource[] })
        : null
      if (captured && !captured.ok) return errorResult(captured.error)
      return asJsonResult({
        ...created,
        ...(captured?.ok ? { captured: captured.captured, envsets: captured.summary } : {}),
      })
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('write_feature_doc', {
    description:
      'Write a prose doc (session, plan, notes) into a feature\'s docs/ dir, OR link a LOCAL file in place via link_path (symlinked so the user\'s original stays the live source; copy fallback where symlinks aren\'t permitted). Create-or-replace (re-writing the same relPath overwrites); written docs are markdown only (.md/.markdown), linked docs may also be .txt. Use for "add this plan/distillation to feature <name>" or "use ~/Documents/prd.md as the requirements".',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      relPath: z.string().optional().describe('Path relative to the feature docs/ dir, e.g. "notes.md" or "sessions/2026-05-28.md". A leading "docs/" is optional. Required with content; defaults to the target basename with link_path.'),
      content: z.string().optional().describe('Markdown document body. Mutually exclusive with link_path.'),
      link_path: z.string().optional().describe('Absolute or ~-relative path of a LOCAL doc to link into docs/ instead of writing content. Mutually exclusive with content.'),
    },
  }, async ({ feature, relPath, content, link_path }) => {
    if ((content === undefined) === (link_path === undefined)) {
      return errorResult('pass exactly one of content (write a doc) or link_path (link a local file)')
    }
    if (link_path !== undefined) {
      const result = linkFeatureDoc(
        authoringCtx(deps),
        { feature, targetPath: link_path, ...(relPath ? { relPath } : {}) },
      )
      if (!result.ok) return errorResult(result.error)
      return asJsonResult({ written: true, linked: result.linked, path: result.writtenPath, relativePath: result.relativePath })
    }
    if (!relPath) return errorResult('relPath is required with content')
    const result = writeFeatureDoc(
      authoringCtx(deps),
      { feature, relPath, content: content! },
    )
    if (!result.ok) return errorResult(result.error)
    return asJsonResult({ written: true, path: result.writtenPath, relativePath: result.relativePath })
  })

  registerTool('delete_feature_doc', {
    description:
      'Delete a SOURCE doc from a feature\'s docs/ dir. Refuses generated artifacts (_prd-* / _coverage-* files canary manages). After removing docs, regenerate the PRD summary so coverage reflects the change.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      relPath: z.string().describe('Path of the source doc relative to docs/, e.g. "notes.md". A leading "docs/" is optional.'),
    },
  }, async ({ feature, relPath }) => {
    const result = deleteFeatureDoc(
      authoringCtx(deps),
      { feature, relPath },
    )
    if (!result.ok) return errorResult(result.error)
    return asJsonResult({ deleted: true, relativePath: result.relativePath })
  })

  registerTool('get_feature_coverage', {
    description:
      'Get the Semantic Coverage Ledger: PRD requirements → mapped tests → gap type (untested / path-incomplete / covered) with a coverage % (covered ÷ total declared paths) and mapped % (requirements with ≥1 test), per-test strength (strong/solid/basic/shallow from assertion tiers), and docs-drift. coveragePct is claim-based — a tag claims the test→requirement+path mapping, regardless of run results. When the feature has a recorded run the ledger ALSO carries an additive proven axis (provenPct, totals.proven, per-requirement/path proven, provenRunId): covered = a tag claims it; proven = the covering test actually passed in the latest run. These fields are omitted when no run is recorded. Use it to find untested/path-incomplete requirements and shallow tests. When the ledger is BLOCKED (state.coverage:"blocked") it carries a `next:` field with the recovery step; if it says no source doc exists, ASK THE USER to attach/paste the PRD in chat (never invent or pull one) before generating.',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      const ledger = computeFeatureCoverage({
        featuresDir: deps.featuresDir,
        logsDir: deps.store.logsDir,
        feature,
      })
      // Blocked ledger is silent on recovery — every sibling coverage tool returns a
      // `next:`. Attach one so the agent acts instead of hedging. The no-source-doc case
      // is the only one that needs a HUMAN step: ask for the doc, don't invent/pull one.
      if (ledger.state?.coverage === 'blocked') {
        const sourceDocCount = listFeatureDocs(deps.featuresDir, feature).sourceDocCount
        return asJsonResult({ ...ledger, next: coverageBlockedNext(feature, ledger.state.summary, sourceDocCount) })
      }
      return asJsonResult(ledger)
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('list_feature_docs', {
    description:
      'List the docs in a feature\'s docs/ directory (source docs the user added plus generated _prd-* PRD artifacts), with the PRD summary status and docs-drift flag. The UI Docs tab shows the same list — use this to see what source material the PRD summary was built from before regenerating it.',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      return asJsonResult(listFeatureDocs(deps.featuresDir, feature))
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })

  registerTool('clear_prd_summary', {
    description:
      'Reset a feature\'s coverage to a blank slate: remove the generated PRD summary + its coverage sidecars (pending mappings, run-state) and strip the @req-*/@path-*/@variant-* tags from the specs (other tags kept; specs revert to pre-coverage shape). Source docs are untouched; the feature returns to the "no summary" state. Returns { removed, untagged } (untagged = specs whose tags were cleared).',
    inputSchema: { feature: z.string().describe('Existing feature name (from list_features).') },
  }, async ({ feature }) => {
    try {
      const result = clearPrdSummary({ featuresDir: deps.featuresDir, feature })
      // Coverage badge + spec tags both change; refresh the ledger view and the
      // tests panel (specs were un-tagged) on every client without a reload.
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature })
      return asJsonResult(result)
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      throw err
    }
  })
}
