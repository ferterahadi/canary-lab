// MCP tools — external authoring and export control.
//
// Registration bodies are unchanged from the pre-split tools.ts; only the
// enclosing function is new. Add a tool here, then wire its name into the
// profile arrays in ../tool-support.ts (see the cl_add-mcp-tool skill).
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RunStore } from '../../features/runs/logic/run-store'
import type { RunDetail, RunStoreEvent } from '../../features/runs/logic/run-store'
import type { ExternalHealBroker } from '../../features/runs/logic/heal/external-heal-broker'
import type { ClientKind } from '../../../../../shared/run-mode'
import {
  buildExternalFailureDetail,
  buildExternalHealContext,
  buildExternalRunSnapshotSlim,
  normalizeRunCounts,
  slimRepeatHealContext,
  writeHealSignal,
  type ExternalHealContext,
  type NormalizedRunCounts,
} from '../../features/runs/logic/heal/external-heal-surface'
import { loadFeatures } from '../../features/config/logic/feature-loader'
import type { DirtySpecStore } from '../../features/runs/logic/dirty-specs/store'
import { isHealClaimAllowed } from '../../features/runs/logic/heal/heal-claim-policy'
import { computePortPreflight } from '../../features/runs/logic/runtime/port-preflight'
import { flightStageRemedy } from '../../features/flights/logic/stage-remedy'
import type { FlightManifest } from '../../../../../shared/flights/types'
import {
  createVerificationConfig,
  getVerificationConfig,
  listVerificationConfigs,
  updateVerificationConfig,
  type ResolveVerificationInput,
} from '../../features/coverage/logic/verification'
import {
  applyExternalDraftFiles,
  captureFeatureEnvFiles,
  checkoutFeatureRepoBranch,
  createFeatureSkeleton,
  deleteFeature,
  getFeatureEnvsetSummary,
  getFeatureRepoStatus,
  writeFeatureDoc,
  deleteFeatureDoc,
  linkFeatureDoc,
  type EnvFileSource,
} from '../../features/config/logic/feature-authoring'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  listFeatureDocs,
} from '../../features/coverage/logic/coverage/service'
import { deriveFeatureSlug } from '../../../../../shared/flights/types'
import { CoverageJobRunStore } from '../../features/coverage/logic/coverage/jobs/store'
import { CoverageJobConflictError } from '../../features/coverage/logic/coverage/jobs/runner'
import {
  startExternalCoverage,
  submitExternalCoverage,
  startExternalSummary,
  submitExternalSummary,
} from '../../features/coverage/logic/coverage/jobs/external'
import type { ParsedRequirement } from '../../features/coverage/logic/coverage/prd-summary'
import type { ProposedMapping, SummaryState } from '../../../../../shared/coverage/types'
import {
  createDraft,
  paths as draftPaths,
  readDraft,
  writeDraft,
  type DraftRecord,
  type ExternalDraftStage,
} from '../../features/wizard/logic/draft-store'
import {
  appendEvaluationExportLog,
  createEvaluationExportTask,
  deleteEvaluationExportTask,
  evaluationExportTaskView,
  listEvaluationExportTasks,
  patchEvaluationExportTask,
  readEvaluationExportTask,
  readEvaluationExportZip,
  writeEvaluationExportZip,
  type EvaluationExportTaskRecord,
} from '../../features/evaluation/logic/evaluation-export-store'
import { buildEvaluationExportArchive } from '../../features/evaluation/logic/evaluation-export-archive'
import {
  applyEvaluationTextSlotRewrite,
  buildTestReviewPacket,
  deterministicEvaluationRewrite,
  evaluationTextSlots,
  normalizeEvaluationRewrite,
  type EvaluationRewrite,
} from '../../features/evaluation/logic/test-review-export'
import {
  isActiveRunStatus,
  isTerminalRunStatus,
  deriveRunActionAvailability,
} from '../../../../../shared/run-state'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../shared/workspace-events'
import { encodeToonTable } from '../../shared/toon'
import type {
  PortifyManifest,
  StartExternalPortifyInput,
  StartExternalPortifyResult,
} from '../../features/portify/logic/runtime/types'
import { overlayExists as portifyOverlayExists } from '../../features/portify/logic/runtime/overlay'
import { type ToolGroupContext,
  EXTERNAL_DRAFT_STAGE,
  asJsonResult,
  asToonResult,
  coverageBlockedNext,
  coverageMappingInput,
  ensureExternalClaimForMcpCall,
  errorResult,
  evaluationRewriteInput,
  evaluationTextSlotInput,
  externalDraftAuthoringNextSteps,
  externalDraftView,
  externalEvaluationReportSchema,
  isToolErrorPayload,
  newDraftId,
  newEvaluationTaskId,
  safeFilename,
  statusForExternalStage,
  summarizeUnifiedDiff,
  summaryRequirementInput,
  variantDimensionInput } from '../tool-support'

export function registerAuthoringTools(ctx: ToolGroupContext): void {
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
        feature,
        description,
        envs,
        repos,
      })
      if (!created.ok) return errorResult(created.error)
      const captured = envSources?.length
        ? captureFeatureEnvFiles({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, { feature, sources: envSources as EnvFileSource[] })
        : null
      if (captured && !captured.ok) return errorResult(captured.error)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-created', feature })
      if (captured?.ok) publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
      return asJsonResult({
        ...created,
        ...(captured?.ok ? { captured: captured.captured, envsets: captured.summary } : {}),
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
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
        { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
        { feature, targetPath: link_path, ...(relPath ? { relPath } : {}) },
      )
      if (!result.ok) return errorResult(result.error)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
      return asJsonResult({ written: true, linked: result.linked, path: result.writtenPath, relativePath: result.relativePath })
    }
    if (!relPath) return errorResult('relPath is required with content')
    const result = writeFeatureDoc(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, relPath, content: content! },
    )
    if (!result.ok) return errorResult(result.error)
    // Docs feed the PRD summary; refresh the Docs rail + coverage headline live.
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
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
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, relPath },
    )
    if (!result.ok) return errorResult(result.error)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature })
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

  registerTool('start_external_summary', {
    description:
      'Start a PRD-summary pass YOU drive — no local agent. Returns the source docs (paths to read), the previous requirement ids to PRESERVE, and a `prompt`: read each source doc, extract testable requirements, then call submit_external_summary with the requirements[]. Canary reconciles ids against the prior summary (the stable spine) and writes docs/_prd-summary.{json,md} — never re-derives the requirements. Single-flight (rejected if a summary/coverage job is running). No source doc yet → status:"needs-docs" (ASK THE USER for the PRD; do not invent one). This is the FIRST step of coverage — follow it with start_external_coverage. Offload to a background task or fan out across docs when the PRD is large.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    try {
      const res = startExternalSummary(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          feature,
          sessionId: session_id,
          clientKind: client_kind,
          ...(conversation_name ? { conversationName: conversation_name } : {}),
          ...(external_session_url ? { sessionUrl: external_session_url } : {}),
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      if (res.kind === 'needs-docs') {
        return asJsonResult({
          status: 'needs-docs',
          feature,
          next: `No source doc on file for "${feature}". ASK THE USER to attach or paste the PRD/spec (do NOT invent one or pull an external file), then write_feature_doc("${feature}", "<name>.md", <content>) and call start_external_summary again.`,
        })
      }
      return asJsonResult({
        jobId: res.manifest.jobId,
        status: res.manifest.status,
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You read the source docs and propose requirements using context.prompt; Canary spawns no agent — submit_external_summary reconciles ids and writes the summary.',
        context: res.context,
        nextSteps: ['submit_external_summary'],
        next: `Follow context.prompt: read each doc in context.docs, extract requirements (reuse a context.previousRequirementIds id to preserve it), then call submit_external_summary with jobId "${res.manifest.jobId}" and requirements[].`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      if (err instanceof CoverageJobConflictError) return errorResult(`${err.message} (existing job ${err.existingJobId})`)
      throw err
    }
  })

  registerTool('submit_external_summary', {
    description:
      'Submit your extracted requirements for an external PRD-summary job. Canary reconciles ids against the prior summary (preserving surviving ids; new ones get fresh ids; dropped ones marked deprecated), writes docs/_prd-summary.{json,md}, marks the job done, and recomputes the ledger. Then call start_external_coverage to map tests → requirements.',
    inputSchema: {
      jobId: z.string().describe('Job id returned by start_external_summary.'),
      requirements: z.array(summaryRequirementInput).describe('The testable requirements extracted from the source docs.'),
      variantDimension: variantDimensionInput.optional().describe('The feature\'s single cross-cutting dimension (channel/tenant/region/...), if it has one. Omit when no dimension applies.'),
    },
  }, async ({ jobId, requirements, variantDimension }) => {
    try {
      const { manifest, result } = submitExternalSummary(
        {
          featuresDir: deps.featuresDir,
          jobId,
          requirements: requirements as ParsedRequirement[],
          ...(variantDimension ? { variantDimension } : {}),
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      return asJsonResult({
        jobId: manifest.jobId,
        feature: manifest.feature,
        status: manifest.status,
        requirementCount: result.summary.requirements.length,
        written: result.written,
        nextSteps: ['start_external_coverage'],
        next: `Wrote the PRD summary (${result.summary.requirements.length} requirement(s)). Call start_external_coverage("${manifest.feature}") to map tests → requirements.`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('start_external_coverage', {
    description:
      'Start a coverage mapping pass YOU drive — no local agent. Returns the active requirements, the feature\'s tests (with file paths to read), and a `prompt`: read each test, decide its requirement id(s), then call submit_external_coverage with the mappings. Canary writes the @req-* tags via its canonical tag-writer and recomputes the ledger (never re-derives the mapping). Single-flight (rejected if a coverage job is running). No PRD summary yet → status:"needs-summary" (call start_external_summary first). Offload to a background task or fan out across tests when there are many.',
    inputSchema: {
      feature: z.string().describe('Existing feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    try {
      const res = startExternalCoverage(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          feature,
          sessionId: session_id,
          clientKind: client_kind,
          ...(conversation_name ? { conversationName: conversation_name } : {}),
          ...(external_session_url ? { sessionUrl: external_session_url } : {}),
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      if (res.kind === 'needs-summary') {
        return asJsonResult({
          status: 'needs-summary',
          feature,
          next: `No PRD summary for "${feature}". Call start_external_summary first (read the docs, submit_external_summary), then start_external_coverage again.`,
        })
      }
      return asJsonResult({
        jobId: res.manifest.jobId,
        status: res.manifest.status,
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You do the mapping using context.prompt; Canary spawns no agent — submit_external_coverage writes the tags + recomputes the ledger.',
        context: res.context,
        nextSteps: ['submit_external_coverage'],
        next: `Follow context.prompt: read each test\'s file, decide its requirement id(s), then call submit_external_coverage with jobId "${res.manifest.jobId}" and mappings[].`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      if (err instanceof CoverageJobConflictError) return errorResult(`${err.message} (existing job ${err.existingJobId})`)
      throw err
    }
  })

  registerTool('submit_external_coverage', {
    description:
      'Submit your test→requirement mappings for an external coverage job. Canary writes each @req-* tag via its canonical tag-writer (idempotent/additive — never rewrites a test body), marks the job done, and recomputes the ledger; unknown ids/test names are dropped. Then call get_feature_coverage.',
    inputSchema: {
      jobId: z.string().describe('Job id returned by start_external_coverage.'),
      mappings: z.array(coverageMappingInput).describe('One entry per test you could map. Omit tests you cannot confidently map.'),
    },
  }, async ({ jobId, mappings }) => {
    try {
      const { manifest, result } = submitExternalCoverage(
        {
          featuresDir: deps.featuresDir,
          logsDir: deps.store.logsDir,
          jobId,
          mappings: mappings as ProposedMapping[],
        },
        { store: new CoverageJobRunStore(deps.store.logsDir), workspaceEvents: deps.workspaceEvents },
      )
      // Deterministic validation flags mappings (still applied — no review gate);
      // surface only a count here, token-cheap. Details ride on each applied
      // mapping's `issues` (flagMappingIssues in the coverage service).
      const flagged = result.applied.filter((m) => m.issues?.length).length
      return asJsonResult({
        jobId: manifest.jobId,
        feature: manifest.feature,
        status: manifest.status,
        applied: result.applied.length,
        ...(flagged ? { flagged } : {}),
        coveragePct: result.ledger.coveragePct,
        ...(result.ledger.provenPct !== undefined ? { provenPct: result.ledger.provenPct } : {}),
        nextSteps: ['get_feature_coverage'],
        next: `Wrote ${result.applied.length} covers tag(s)${flagged ? ` (${flagged} flagged by deterministic validation — sad-path/variant claims not evidenced in the test source)` : ''}. Call get_feature_coverage("${manifest.feature}") for the updated ledger.`,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) return errorResult(err.message)
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_feature_envset_summary', {
    description: 'List a feature envset layout, slot targets, redacted key previews, and the feature\'s declared repos (name/localPath/branch — pass repo name to get_feature_repo_status / checkout_feature_repo_branch). Secret values are never returned.',
    inputSchema: { feature: z.string() },
  }, async ({ feature }) => {
    const summary = getFeatureEnvsetSummary({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, feature)
    if (!summary) return errorResult(`feature not found: ${feature}`)
    return asJsonResult(summary)
  })

  registerTool('capture_feature_env_files', {
    description: 'Copy declared .env/properties files into feature envsets and update envsets.config.json. Returns redacted key previews only.',
    inputSchema: {
      feature: z.string(),
      sources: z.array(z.object({
        sourcePath: z.string(),
        env: z.string().optional(),
        slot: z.string().optional(),
        target: z.string().optional(),
        description: z.string().optional(),
        confirmOverwrite: z.boolean().optional(),
      })).min(1),
    },
  }, async ({ feature, sources }) => {
    try {
      const result = captureFeatureEnvFiles({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, { feature, sources: sources as EnvFileSource[] })
      if (!result.ok) return errorResult(result.error)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('write_envset', {
    description: 'Overwrite an envset slot file with the supplied key/value entries. Destructive — replaces existing keys and drops unparseable lines. Use capture_feature_env_files to bulk-copy from a source file instead.',
    inputSchema: {
      feature: z.string(),
      env: z.string().describe('Envset folder name, e.g. local or staging.'),
      slot: z.string().describe('Slot filename inside the envset, e.g. api.env or application.properties.'),
      entries: z.array(z.object({ key: z.string(), value: z.string() })).describe('Replacement key/value pairs. Empty array clears the file.'),
      confirm: z.literal(true).describe('Must be true. Guards against accidental envset overwrites.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ feature, env, slot, entries }) => {
    if (!deps.writeEnvsetSlot) return errorResult('writeEnvsetSlot dependency is not configured')
    try {
      const result = await deps.writeEnvsetSlot(feature, env, slot, entries)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
      return asJsonResult({ feature, env, slot, path: result.path, entries: result.entries, unparsedLines: result.unparsedLines })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('delete_feature', {
    description: 'Delete a Canary Lab feature (suite) directory AND its flight history — one deletion concept. Rejected while the feature has an active flight (pause it first). Requires confirmName to match the feature name.',
    inputSchema: {
      feature: z.string(),
      confirmName: z.string().describe('Must exactly match feature.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ feature, confirmName }) => {
    // Validate the confirm BEFORE the flight-history hook removes anything.
    if (confirmName !== feature) return errorResult('confirmName must match the feature name')
    // R76 guard — an active flight blocks the whole deletion before anything
    // is removed.
    const flights = deps.removeFlightRecordsFor?.(feature)
    if (flights?.error) return errorResult(flights.error)
    const result = deleteFeature({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, { feature, confirmName })
    if (!result.ok) return errorResult(result.error)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-deleted', feature })
    if ((flights?.removed ?? 0) > 0) publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
    return asJsonResult({ deleted: true, feature, featureDir: result.featureDir, flightRecordsRemoved: flights?.removed ?? 0 })
  })

  registerTool('get_feature_repo_status', {
    description: 'Get git branch/dirty status for a repo declared in feature.config.cjs.',
    inputSchema: { feature: z.string(), repo: z.string() },
  }, async ({ feature, repo }) => {
    const status = await getFeatureRepoStatus({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, feature, repo)
    if (!status) return errorResult(`repo not found: ${feature}/${repo}`)
    return asJsonResult(status)
  })

  registerTool('checkout_feature_repo_branch', {
    description: 'Checkout a branch in a repo declared in feature.config.cjs. Confirm-gated because it changes the user repo checkout.',
    inputSchema: {
      feature: z.string(),
      repo: z.string(),
      branch: z.string(),
      confirm: z.literal(true),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ feature, repo, branch, confirm }) => {
    const result = await checkoutFeatureRepoBranch(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, repo, branch, confirm },
    )
    if (isToolErrorPayload(result)) return errorResult(result.error)
    // Branch moved; refresh the feature list + Repos tab git-status row live.
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
    return asJsonResult(result)
  })

  registerTool('start_external_evaluation_export', {
    description: 'Create an evaluation export task for an external client to author. Returns run context plus the report/archive submission schema. Does not start any local LLM.',
    inputSchema: {
      runId: z.string(),
      language: z.string().default('English'),
      session_id: z.string(),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ runId, language, session_id, client_kind, conversation_name, external_session_url }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isTerminalRunStatus(detail.manifest.status)) {
      return errorResult('evaluation export is available after the run finishes')
    }
    const now = new Date().toISOString()
    const task: EvaluationExportTaskRecord = {
      taskId: newEvaluationTaskId(),
      runId,
      feature: detail.manifest.feature,
      mode: 'localized',
      producer: 'external',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      downloadReady: false,
      archiveBase: `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(runId)}`,
      clientKind: client_kind,
      sessionId: session_id,
      ...(conversation_name ? { conversationName: conversation_name } : {}),
      language,
      ...(external_session_url ? { externalSessionUrl: external_session_url } : {}),
    }
    createEvaluationExportTask(deps.store.logsDir, task)
    appendEvaluationExportLog(deps.store.logsDir, task.taskId, '[evaluation] external export task created\n')
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-created', task: evaluationExportTaskView(task) })
    return asJsonResult({
      task: evaluationExportTaskView(task),
      reportSchema: externalEvaluationReportSchema(detail),
      runSnapshotVia: `get_run("${runId}")`,
      nextSteps: ['call get_run(runId) if you need the run summary/failures while authoring', 'author structured evaluation wording', 'submit_external_evaluation_export'],
    })
  })

  registerTool('submit_external_evaluation_export', {
    description: 'Render structured external evaluation wording through Canary Lab’s canonical HTML export and mark the task completed.',
    inputSchema: {
      taskId: z.string(),
      textSlots: z.array(evaluationTextSlotInput).optional(),
      rewrite: evaluationRewriteInput.optional(),
    },
  }, async ({ taskId, textSlots, rewrite }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    if ((task.producer ?? 'internal') !== 'external') return errorResult('only external export tasks can be submitted through this tool')
    if (!rewrite && (!textSlots || textSlots.length === 0)) return errorResult('submit textSlots[] or rewrite')
    const detail = deps.store.get(task.runId)
    if (!detail) return errorResult(`run not found: ${task.runId}`)
    try {
      const packet = buildTestReviewPacket(detail)
      const normalizedRewrite = rewrite
        ? normalizeEvaluationRewrite(rewrite as EvaluationRewrite, packet)
        : applyEvaluationTextSlotRewrite(deterministicEvaluationRewrite(packet), textSlots!)
      if (!normalizedRewrite) {
        const expected = packet.tests.length
        const received = Array.isArray((rewrite as EvaluationRewrite | undefined)?.cases)
          ? (rewrite as EvaluationRewrite).cases.length
          : 0
        return errorResult(
          `rewrite.cases must contain exactly ${expected} ${expected === 1 ? 'entry' : 'entries'} — one per evaluated test, in the same order as reportSchema.rewrite.cases (got ${received}). Do NOT merge, dedupe, or drop skipped or duplicate run entries; every run entry needs its own case. Each case requires title, whatWasChecked, whyItMatters, and confidence (all strings).`,
        )
      }
      const built = await buildEvaluationExportArchive(detail, {
        logsDir: deps.store.logsDir,
        audienceAdapter: 'deterministic',
        rewrite: normalizedRewrite,
      })
      writeEvaluationExportZip(deps.store.logsDir, taskId, built.zip)
      appendEvaluationExportLog(deps.store.logsDir, taskId, '[evaluation] external report submitted\n')
      const next = patchEvaluationExportTask(deps.store.logsDir, taskId, {
        archiveBase: built.archiveBase,
        status: 'completed',
        downloadReady: true,
      })
      if (next) {
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(next) })
      }
      return asJsonResult({
        ...evaluationExportTaskView(next!),
        // Compact, chat-ready digest of the rendered evaluation so the agent can
        // relay the result in the conversation instead of only pointing at the
        // UI. Kept small (titles + verdicts, not full flow steps); the full
        // rendered evaluation.html ships via download_evaluation_export.
        evaluation: {
          featureTitle: normalizedRewrite.featureTitle ?? next!.feature,
          summary: normalizedRewrite.summary,
          cases: normalizedRewrite.cases.map((c) => ({ title: c.title, confidence: c.confidence })),
        },
        nextSteps: [
          'Present this evaluation to the user in chat — the featureTitle, the summary, and the per-case title + confidence verdicts. Do not just say it is available in the UI.',
          'download_evaluation_export returns the full rendered evaluation.html archive if the user wants the file.',
        ],
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('list_evaluation_exports', {
    description: 'List persisted evaluation export tasks. Returned as a TOON table: a `[N]{col,...}:` header line followed by one comma-separated row per task (quoted cells are JSON-escaped strings).',
    inputSchema: { runId: z.string().optional() },
  }, async ({ runId }) => {
    const tasks = listEvaluationExportTasks(deps.store.logsDir, runId ? { runId } : {})
    return asToonResult(tasks.map(evaluationExportTaskView))
  })

  registerTool('get_evaluation_export', {
    description: 'Fetch one evaluation export task.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    return asJsonResult(evaluationExportTaskView(task))
  })

  registerTool('download_evaluation_export', {
    description: 'Return a completed evaluation export archive as base64 for MCP clients.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    const zip = task.status === 'completed' ? readEvaluationExportZip(deps.store.logsDir, taskId) : null
    if (!zip) return errorResult('evaluation export is not ready')
    return asJsonResult({
      task: evaluationExportTaskView(task),
      filename: `${task.archiveBase}.zip`,
      archiveBase64: zip.toString('base64'),
    })
  })

  registerTool('delete_evaluation_export', {
    description: 'Delete an evaluation export task and stored archive. Requires confirm: true.',
    inputSchema: { taskId: z.string(), confirm: z.literal(true) },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ taskId }) => {
    const deleted = deleteEvaluationExportTask(deps.store.logsDir, taskId)
    if (!deleted) return errorResult(`evaluation export task not found: ${taskId}`)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-deleted', taskId })
    return asJsonResult({ deleted: true, taskId })
  })

  registerTool('start_external_draft', {
    description: 'Create an external test-authoring draft/task record. This never starts the internal wizard agents.',
    inputSchema: {
      feature: z.string(),
      stage: EXTERNAL_DRAFT_STAGE.default('scaffolding'),
      session_id: z.string(),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, stage, session_id, client_kind, conversation_name, external_session_url }) => {
    const featureConfig = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === feature)
    if (!featureConfig) return errorResult(`feature not found: ${feature}`)
    const draftId = newDraftId()
    const record = createDraft(deps.store.logsDir, {
      draftId,
      prdText: `External client is authoring tests for ${feature}.`,
      prdDocuments: [],
      repos: (featureConfig.repos ?? []).map((repo) => ({
        name: repo.name,
        localPath: repo.localPath,
        ...(repo.branch ? { branch: repo.branch } : {}),
      })),
      featureName: feature,
      producer: 'external',
      externalStage: stage as ExternalDraftStage,
      externalClientKind: client_kind,
      externalSessionId: session_id,
      ...(conversation_name ? { externalConversationName: conversation_name } : {}),
      ...(external_session_url ? { externalSessionUrl: external_session_url } : {}),
    })
    const next: DraftRecord = {
      ...record,
      status: statusForExternalStage(stage as ExternalDraftStage),
      updatedAt: new Date().toISOString(),
    }
    writeDraft(deps.store.logsDir, next)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-created', draft: next })
    return asJsonResult({
      ...externalDraftView(next),
      canaryLabBehavior: 'tracking-only',
      statusMeaning: 'External client is authoring tests; Canary Lab is not running an internal wizard agent.',
      nextSteps: externalDraftAuthoringNextSteps(feature),
    })
  })

  registerTool('update_external_draft_stage', {
    description: 'Update the visible stage for an external draft/task record.',
    inputSchema: {
      draftId: z.string(),
      stage: EXTERNAL_DRAFT_STAGE,
      message: z.string().optional(),
    },
  }, async ({ draftId, stage, message }) => {
    const current = readDraft(deps.store.logsDir, draftId)
    if (!current) return errorResult(`draft not found: ${draftId}`)
    if ((current.producer ?? 'internal') !== 'external') return errorResult('draft is not external-owned')
    const next: DraftRecord = {
      ...current,
      externalStage: stage as ExternalDraftStage,
      status: statusForExternalStage(stage as ExternalDraftStage),
      ...(stage === 'error' && message ? { errorMessage: message } : {}),
      updatedAt: new Date().toISOString(),
    }
    writeDraft(deps.store.logsDir, next)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
    return asJsonResult(externalDraftView(next))
  })

  registerTool('apply_external_draft', {
    description: 'Validate externally authored test files and apply them to the target feature. Requires confirm: true. This never starts internal wizard agents.',
    inputSchema: {
      draftId: z.string(),
      confirm: z.literal(true),
      files: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ draftId, files }) => {
    const current = readDraft(deps.store.logsDir, draftId)
    if (!current) return errorResult(`draft not found: ${draftId}`)
    if ((current.producer ?? 'internal') !== 'external') return errorResult('draft is not external-owned')
    if (!current.featureName) return errorResult('external draft has no featureName')
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === current.featureName)
    if (!feature?.featureDir) return errorResult(`feature not found: ${current.featureName}`)
    const applied = applyExternalDraftFiles({
      featureDir: feature.featureDir,
      files: files?.map((file) => ({ path: file.path, content: file.content })),
    })
    if (!applied.ok) return errorResult(applied.error)
    const p = draftPaths(deps.store.logsDir, draftId)
    fs.mkdirSync(p.generatedDir, { recursive: true })
    for (const file of files ?? []) {
      const target = path.join(p.generatedDir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
    }
    const next: DraftRecord = {
      ...current,
      externalStage: 'applied',
      status: 'accepted',
      generatedFiles: applied.written,
      updatedAt: new Date().toISOString(),
    }
    writeDraft(deps.store.logsDir, next)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: current.featureName })
    return asJsonResult({
      draftId,
      feature: current.featureName,
      status: 'applied',
      written: applied.written,
    })
  })

  // ── Flight (`canary-lab flight` — conducted onboarding pipeline) ──────
  const FLIGHT_DATA_INLINE_BUDGET = 8 * 1024 // ≈2K tokens — past this, review in the web UI
  const flightView = (raw: unknown): Record<string, unknown> => {
    const m = raw as {
      flightId: string; feature: string; status: string; currentStage: string | null
      pauseReason?: string
      runVerdict?: string; error?: string; links?: unknown
      stages?: Array<{ key: string; status: string; error?: string; skipReason?: string; checkpoint?: unknown }>
    }
    const waiting = (m.stages ?? []).find((s) => s.status === 'waiting-for-approval')
    let checkpoint = waiting?.checkpoint as { data?: unknown } | undefined
    if (checkpoint?.data !== undefined && JSON.stringify(checkpoint.data).length > FLIGHT_DATA_INLINE_BUDGET) {
      checkpoint = { ...checkpoint, data: { omitted: true, reason: 'payload over the inline budget — review it in the web UI flight view, then respond here' } }
    }
    return {
      flightId: m.flightId,
      feature: m.feature,
      status: m.status,
      currentStage: m.currentStage,
      ...(m.pauseReason ? { pauseReason: m.pauseReason } : {}),
      ...(m.runVerdict ? { runVerdict: m.runVerdict } : {}),
      ...(m.error ? { error: m.error } : {}),
      ...(m.links ? { links: m.links } : {}),
      stages: (m.stages ?? []).map((s) => ({
        key: s.key,
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
        ...(s.skipReason ? { skipReason: s.skipReason } : {}),
      })),
      ...(waiting && checkpoint ? { checkpoint: { stage: waiting.key, ...checkpoint } } : {}),
    }
  }
  const flightNext = (view: Record<string, unknown>): string => {
    if (view.status === 'waiting-for-approval') {
      const cp = view.checkpoint as {
        stage?: string
        kind?: string
        options?: string[]
        data?: { lastAttempt?: { mode?: string; outcome?: string; reason?: string } }
      } | undefined
      const base = `Flight is parked on the ${cp?.kind ?? 'checkpoint'} checkpoint — call respond_flight_checkpoint(flightId, choice: one of ${JSON.stringify(cp?.options ?? [])}).`
      if (cp?.kind === 'prd-source') {
        const fork = `${base} The Requirements stage ALWAYS pauses here — a two-path fork; ask your user which path. (a) Supply docs yourself: distill THIS conversation with write_feature_doc("${String(view.feature)}", "conversation-prd.md", <markdown>) or link a local file with write_feature_doc(link_path: "~/path/to/prd.md"), then respond "continue". (b) Have Canary's agent gather them guided by the flight's frozen intent: respond "collect-repo-docs" (the agent copies in repo docs relevant to the intent) or "infer-from-diff" (the agent derives requirements from the branch diff vs base). If a previous gather went wrong, pass feedback:"<what was wrong>" with the choice — it is added to the agent's prompt.`
        // A re-park after an empty gather must NOT read as a neutral first
        // visit: repeating the same collector over the same repos is the one
        // choice already known to fail. Mirrors the web UI, which flips its
        // recommendation to the manual path on the same `lastAttempt`.
        const last = cp.data?.lastAttempt
        if (!last) return fork
        const what = last.outcome === 'no-diff'
          ? 'found no meaningful diff vs the base branch'
          : last.reason
            ? `searched and found nothing relevant: ${last.reason}`
            : 'ran but produced no requirements doc'
        return `${fork} NOTE — a previous "${String(last.mode)}" gather already ${what}. Do NOT simply repeat that same choice: the material is not in these repos. Prefer (a) supplying the docs yourself, or re-run the agent ONLY with feedback:"<what it missed>" or after the user points the flight at different repos.`
      }
      if (cp?.kind === 'config-approval') {
        return `${base} The feature is scaffolded — the config being approved is the REAL on-disk feature.config.cjs (checkpoint data carries a snapshot + configPath). Approve as-is, pass an edited configSource via data, or answer "redraft" to re-run the repo scan.`
      }
      if (cp?.kind === 'export-mode') {
        return `${base} raw = fast report straight from run evidence; localized = an agent rewrites per-test reasoning (slower, more readable).`
      }
      if (cp?.kind === 'portify-gate') {
        return `${base} This is the UPFRONT parallel-readiness ask, before any agent or double-boot cost: "run" starts the portify workflow (agent edits port wiring in a throwaway worktree, concurrent double-boot verifies — heavy stacks can take 30-60+ min; a sibling feature's saved overlay for the same app is reused and verified first, so the agent may not run at all); "skip" keeps the feature serial (runs go one at a time) and the flight continues — a later flight can ask again.`
      }
      if (cp?.kind === 'portify-apply') {
        return `${base} The diff passed a concurrent double-boot. "apply" SAVES it as the feature's overlay (nothing lands in the product repos — runs apply it into throwaway per-run worktrees); "revise" REQUIRES feedback:"<what to change>" and sends the agent back for another edit + re-verify pass (the checkpoint re-parks with the new diff); "cancel" discards the edits and SKIPS the stage — the flight continues WITHOUT parallel readiness (the feature stays serial; a later flight can retry).`
      }
      return base
    }
    if (view.status === 'running') return 'Flight is running — re-call get_flight to follow it; it parks on checkpoints and settles to done/paused/failed.'
    if (view.status === 'paused' && view.pauseReason === 'queued') return 'Flight is queued — it is waiting its turn behind another flight on the same repo(s) and starts automatically when that repo frees. No action needed; tell the user it is queued, not stuck. Only if they want it started early, re-call start_flight (it resumes a queued flight now).'
    if (view.status === 'paused') return 'Flight is paused (a stage failed, the server restarted, or the user paused it). Fix the cause if needed, then start_flight on the same repos resumes it from the first open stage — its repos and intent are frozen, so re-call without new repoPaths/description (they are reused).'
    if (view.status === 'done') return 'Flight is done — links.evaluationZip is the deliverable archive. Point the user at reviewing it now: unzip and open evaluation.html (per-test reasoning + verdicts; video playback where the tests drive a browser). Reviewing the evaluation IS the core loop, not an optional extra.'
    return ''
  }
  const flightsUnavailable = () => errorResult('flightsRequest dependency is not configured')

  registerTool('start_flight', {
    description: 'Start (or resume) a Flight: one background pipeline that takes bare product repo(s) to a green, covered, healed run ending in an evaluation export (similarity → scout → scaffold → env → docs → PRD → specs↔coverage → portify → run → heal → export). The server conducts every stage and computes every verdict; you approve checkpoints via respond_flight_checkpoint and can feed docs via write_feature_doc (content or link_path). Autopilot is ON by default: checkpoints with a safe default answer themselves — config-approval→approve (the scaffolded on-disk config), prd-source→continue (only when requirement docs already exist), coverage-stuck→accept-partial, portify-gate→run, portify-apply→apply, run-failed→export-as-is, export-mode→raw — each decision logged [autopilot] on its stage. The flight still parks on similarity-choice and missing-env (no safe default), on prd-source when NO docs exist yet, and on any RE-parked checkpoint (e.g. a config parse error after an auto-approve). A stage you explicitly RE-ENTER (from_stage / redo) always parks its FIRST checkpoint even under autopilot — choosing to re-run a step IS the intent to answer it differently. Pass autopilot:false to be asked at every checkpoint — do that when you plan to distill THIS conversation into requirement docs at the prd-source stop. ONE flight record per feature: a paused flight is resumed, an ACTIVE one returns its id to follow, and a settled one requires redo:true (restart from stage 1) or from_stage (jump to a chosen stage; prerequisites checked, rejected with the missing one named). A restart WIPES the entry step and every later step back to zero on disk — requirement docs (user-added files/links included), authored specs, captured envsets, portify overlay, run record, evaluation export — as if never run; plain resume never wipes, so warn the user before redo/from_stage on artifacts they still want. A flight\'s repos and intent are FROZEN against MID-PIPELINE re-entry: on from_stage (and on resume) OMIT repoPaths/description and the stored values are reused — passing DIFFERENT ones is rejected with type:"flight_frozen". A full restart (redo:true) accepts new repoPaths/description and replaces the stored ones (omit to reuse); deleting the flight (web UI only, no tool) removes the record itself. A queued flight (status:"paused", pauseReason:"queued") is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees — re-calling start_flight resumes it early. `agent` picks which CLI (claude|codex) conducts the flight\'s stage agents — sticky per record (jump/continue reuse it; only redo may change it); the run stage\'s auto-heal follows the workspace heal setting instead.',
    inputSchema: {
      repoPaths: z.array(z.string()).min(1).optional().describe('Absolute path(s) of the product repo(s); several paths become ONE feature spanning them. REQUIRED for a fresh start; OMIT on redo / from_stage / resume — the flight\'s repos are frozen and the stored set is reused (a different set is rejected with flight_frozen).'),
      description: z.string().optional().describe('What to test, e.g. "checkout flow". REQUIRED for a fresh start; OMIT on redo / from_stage / resume — the flight\'s intent is frozen and the stored value is reused (a different one is rejected with flight_frozen).'),
      feature: z.string().optional().describe('Feature name; defaults to a slug of the first repo basename.'),
      env: z.string().optional().describe('Envset name (default "local").'),
      coverage_target: z.number().min(0).max(100).optional().describe('Coverage % the specs↔coverage loop must reach (default 100).'),
      base: z.string().optional().describe('Base branch for diff-inferred requirements (auto-detected when omitted).'),
      yolo: z.boolean().optional().describe('Skip every checkpoint except missing env secrets.'),
      autopilot: z.boolean().optional().describe('Default true: safe checkpoints answer themselves (logged [autopilot]); similarity-choice, missing-env, docs-less prd-source, and re-parked checkpoints still park. Pass false to be asked at every checkpoint (e.g. to add conversation docs at the prd-source stop).'),
      fresh: z.boolean().optional().describe('Do not resume a paused flight — start over.'),
      agent: z.enum(['claude', 'codex']).optional().describe('R79: which CLI conducts the flight\'s stage agents (scout, requirements collector, PRD summary, spec author, coverage mapper). STICKY per record: jump/continue reuse the stored one; only redo:true may change it. Absent = the stored value, or claude for a fresh start.'),
      redo: z.boolean().optional().describe('Restart the feature\'s existing flight from stage 1. WIPES every step\'s on-disk artifacts back to zero — requirement docs (user-added included), specs, envsets, portify overlay, run record, export — as if the flight never ran; warn the user first if they may still want them.'),
      from_stage: z.string().optional().describe('Start at this stage instead of stage 1 (e.g. "specs-coverage", "run"). Prerequisite artifacts are checked; rejected with the missing one named. WIPES this step\'s and every later step\'s on-disk artifacts (user-added inputs included) back to zero before re-running; earlier steps keep theirs.'),
    },
  }, async ({ repoPaths, description, feature, env, coverage_target, base, yolo, autopilot, agent, fresh, redo, from_stage }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    // Repos + intent are frozen once a flight exists, so redo / from_stage /
    // resume may OMIT repoPaths/description — but then we need `feature` to
    // locate the record (there is no repo set to match on).
    if ((repoPaths === undefined || repoPaths.length === 0) && !feature) {
      return errorResult('start_flight needs repoPaths for a fresh start, or `feature` to redo / jump / resume an existing flight (its frozen repos + intent are reused).')
    }
    const list = await deps.flightsRequest({ method: 'GET', url: '/api/flights' })
    const flights = ((list.body as { flights?: Array<{ flightId: string; feature?: string; status: string; repoPaths?: string[] }> }).flights ?? [])
    const targets = new Set((repoPaths ?? []).map((p) => path.resolve(p)))
    const latest = flights.find((f) =>
      targets.size > 0
        ? (f.repoPaths ?? []).some((p) => targets.has(path.resolve(p)))
        : f.feature === feature,
    )
    if (latest && (latest.status === 'running' || latest.status === 'waiting-for-approval') && !redo && !from_stage) {
      const current = await deps.flightsRequest({ method: 'GET', url: `/api/flights/${encodeURIComponent(latest.flightId)}` })
      const view = flightView(current.body)
      return asJsonResult({ ...view, note: 'a flight is already active for these repos — following it', next: flightNext(view) })
    }
    if (latest && latest.status === 'paused' && !fresh && !redo && !from_stage) {
      const resumed = await deps.flightsRequest({ method: 'POST', url: `/api/flights/${encodeURIComponent(latest.flightId)}/resume` })
      if (resumed.statusCode !== 200) return errorResult(`resume failed (${resumed.statusCode}): ${String((resumed.body as { error?: string }).error ?? '')}`)
      const view = flightView(resumed.body)
      return asJsonResult({ ...view, note: 'resumed the paused flight from its first open stage', next: flightNext(view) })
    }
    const hasRepos = repoPaths !== undefined && repoPaths.length > 0
    const started = await deps.flightsRequest({
      method: 'POST',
      url: '/api/flights',
      payload: {
        // Repos + intent are frozen on the record: send them only when the
        // caller actually provided them (a fresh start, or an explicit —
        // matching — reuse). Omitting them on redo / jump lets the server
        // reuse the stored values; a DIFFERENT value would 409 flight_frozen.
        ...(hasRepos ? { repoPaths } : {}),
        ...(description !== undefined ? { description } : {}),
        feature: feature ?? (hasRepos ? deriveFeatureSlug(repoPaths[0]) : ''),
        ...(env ? { env } : {}),
        ...(coverage_target !== undefined ? { coverageTarget: coverage_target } : {}),
        ...(base ? { base } : {}),
        ...(yolo ? { yolo } : {}),
        ...(autopilot === false ? { autopilot: false } : {}),
        ...(agent ? { agent } : {}),
        ...(redo ? { mode: 'redo' } : from_stage ? { mode: 'jump' } : {}),
        ...(from_stage ? { fromStage: from_stage } : {}),
      },
    })
    const startedBody = started.body as { error?: string; type?: string; options?: string[]; existingFlightId?: string; existingStatus?: string }
    if (started.statusCode === 409 && startedBody.type === 'flight_exists_requires_choice') {
      return asJsonResult({
        type: 'flight_exists_requires_choice',
        feature: feature ?? null,
        existingFlightId: startedBody.existingFlightId,
        existingStatus: startedBody.existingStatus,
        options: startedBody.options,
        next: 'This feature already has a flight record. Re-call start_flight with redo:true to restart from stage 1, or from_stage:"<stage>" to jump (prerequisites checked) — OMIT repoPaths/description so the frozen stored values are reused. Either flag WIPES the re-entered step\'s and every later step\'s on-disk artifacts (user-added docs included) back to zero. A paused record resumes automatically without either flag — resume never wipes.',
      })
    }
    if (started.statusCode === 409 && startedBody.type === 'flight_frozen') {
      return errorResult(`${String(startedBody.error ?? 'this flight\'s repos and intent are frozen')}. Re-call start_flight WITHOUT repoPaths/description (the stored values are reused), or delete the flight in the web UI to start fresh with different ones.`)
    }
    if (started.statusCode !== 201) {
      return errorResult(`start_flight failed (${started.statusCode}): ${String(startedBody.error ?? '')}`)
    }
    const view = flightView(started.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('get_flight', {
    description: 'Fetch one flight (stage rail + open checkpoint) by id, or list all flights when flightId is omitted. Poll this to follow a running flight; it parks on checkpoints (respond via respond_flight_checkpoint) and settles to done/paused/failed. A paused flight carries pauseReason: "queued" means it is waiting its turn behind another flight on the same repo(s) and auto-starts when that repo frees (narrate it as waiting, not stuck — do not ask the user to resume it); "user"/"stage-failed"/"restart" are the resumable pauses. When a stage failed on uncommitted repo changes the result carries `remedy` — the still-dirty repos (live git re-check) — and `next` says how to help the user stash/commit them before resuming.',
    inputSchema: {
      flightId: z.string().optional().describe('Omit to list all flights (slim rows).'),
    },
  }, async ({ flightId }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    if (!flightId) {
      const list = await deps.flightsRequest({ method: 'GET', url: '/api/flights' })
      const rows = ((list.body as { flights?: Array<Record<string, unknown>> }).flights ?? []).map((f) => ({
        flightId: f.flightId, feature: f.feature, status: f.status,
        ...(f.pauseReason ? { pauseReason: f.pauseReason } : {}),
        currentStage: f.currentStage, repoPaths: f.repoPaths,
      }))
      return asJsonResult({ flights: rows })
    }
    const resp = await deps.flightsRequest({ method: 'GET', url: `/api/flights/${encodeURIComponent(flightId)}` })
    if (resp.statusCode !== 200) return errorResult(`flight not found: ${flightId}`)
    const view = flightView(resp.body)
    // Read-time remedy for a failed stage (live git re-check, never stored):
    // give the agent the machine-actionable fix, not just the error prose.
    const remedy = await flightStageRemedy(resp.body as FlightManifest).catch(() => null)
    if (remedy) {
      const fix = remedy.repos.length === 0
        ? `The failed ${remedy.stage} stage blamed uncommitted changes, but every repo is CLEAN now (fixed outside this conversation) — just start_flight(feature) to resume.`
        : `The failed ${remedy.stage} stage is blocked by uncommitted changes in ${remedy.repos.map((r) => `"${r.name}" (${r.modified} files, ${r.path})`).join(', ')}. Help the user clean each repo — \`git stash push -u\` (undoable) or commit — then start_flight(feature) to resume; the stage retries automatically.`
      return asJsonResult({ ...view, remedy, next: `${flightNext(view)} ${fix}`.trim() })
    }
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  registerTool('respond_flight_checkpoint', {
    description: 'Release a flight parked waiting-for-approval: pass the choice (from the checkpoint\'s options), user-supplied env values for missing-env, or an edited configSource via data for config-approval (the config is the scaffolded feature\'s REAL on-disk file — data.configSource writes through to it). Under autopilot (the default) only similarity-choice, missing-env, a docs-less prd-source, and re-parked checkpoints reach you; a flight started with autopilot:false parks at every checkpoint. A prd-source park is a two-path fork: supply the docs yourself (write_feature_doc with content or link_path, then respond "continue"), or have Canary\'s agent gather them guided by the flight\'s frozen intent — respond "collect-repo-docs" (copies in repo docs relevant to the intent) or "infer-from-diff" (derives requirements from the branch diff vs base); optional feedback rides a retry into the agent\'s prompt. A portify-gate park is the upfront parallel-readiness ask BEFORE any agent/double-boot cost: "run" starts the portify workflow (a sibling feature\'s saved overlay for the same app is reused and verified first — the agent only runs if that fails), "skip" keeps the feature serial and the flight continues. A portify-apply park is a verified-diff review: "apply" saves the overlay (nothing lands in the product repos), "revise" REQUIRES feedback:"<what to change>" and re-runs the agent + double-boot re-verify (the checkpoint re-parks with the new diff), "cancel" discards the edits and SKIPS the stage — the flight continues without parallel readiness (the feature stays serial; a later flight can retry). export-mode picks the evaluation flavor: raw (fast) or localized (agent-rewritten reasoning).',
    inputSchema: {
      flightId: z.string(),
      choice: z.string().optional().describe('One of the checkpoint\'s options.'),
      values: z.record(z.string(), z.string()).optional().describe('missing-env only: KEY→value map, written to the missing env file then captured.'),
      data: z.unknown().optional().describe('config-approval only: { configSource } with the hand-edited config — written through to the feature\'s on-disk feature.config.cjs before validation.'),
      feedback: z.string().optional().describe('prd-source agent choices and portify-apply "revise" only: for prd-source, what went wrong last time (added to the collector agent\'s prompt); for portify-apply revise (where it is REQUIRED), what the agent should change before the double-boot re-verify.'),
    },
  }, async ({ flightId, choice, values, data, feedback }) => {
    if (!deps.flightsRequest) return flightsUnavailable()
    const resp = await deps.flightsRequest({
      method: 'POST',
      url: `/api/flights/${encodeURIComponent(flightId)}/respond`,
      payload: { response: { ...(choice ? { choice } : {}), ...(values ? { values } : {}), ...(data !== undefined ? { data } : {}), ...(feedback ? { feedback } : {}) } },
    })
    if (resp.statusCode !== 200) {
      return errorResult(`respond failed (${resp.statusCode}): ${String((resp.body as { error?: string }).error ?? '')}`)
    }
    const view = flightView(resp.body)
    return asJsonResult({ ...view, next: flightNext(view) })
  })

  // ── Port-ification (make a feature's apps use injectable ports) ──────────
  registerTool('start_external_portify', {
    description: "Start a port-ification workflow YOU drive — no local agent. Canary sets up a scratch worktree per repo and returns the edit paths + task. Edit the listeners to read injected ports IN PLACE, declare the `ports` slots in the feature config, then submit_external_portify to verify (concurrent double-boot); save_portify captures the result as the feature's overlay. Async — returns a workflowId + targets; one workflow PER FEATURE (different features can port-ify concurrently up to a resource cap, so you can fan out a subagent per feature; at capacity start_external_portify returns a 429 — wait for one to finish, or save/cancel it).",
    inputSchema: {
      feature: z.string().describe('Feature name (from list_features).'),
      session_id: z.string().describe('Stable id for your conversation — reuse it across calls.'),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ feature, session_id, client_kind, conversation_name, external_session_url }) => {
    if (!deps.startExternalPortify) return errorResult('startExternalPortify dependency is not configured')
    try {
      const result = await deps.startExternalPortify({
        feature,
        clientKind: client_kind,
        sessionId: session_id,
        ...(conversation_name ? { conversationName: conversation_name } : {}),
        ...(external_session_url ? { sessionUrl: external_session_url } : {}),
      })
      return asJsonResult({
        ...result,
        status: 'editing',
        canaryLabBehavior: 'tracking-only',
        statusMeaning: 'You edit the scratch worktrees in place; Canary Lab is not running a local agent — it verifies + saves.',
        nextSteps: ['submit_external_portify'],
        next: `Edit each target's source (in its worktree path) so the listener reads an injected port, declare the matching \`ports\` slots in ${result.configPath}, then call submit_external_portify with workflowId "${result.workflowId}". Poll get_portify; save_portify once status is "ready-to-save".`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('submit_external_portify', {
    description: 'Submit your in-place edits for an external port-ification workflow: Canary Lab captures the worktree diff and boots the stack twice concurrently on different ports to verify. Async — the workflow goes to verifying, then ready-to-save (passed) or back to editing (failed — read verification.failureDetail, fix the worktree, and submit again). Poll get_portify. Only valid while the workflow is in "editing".',
    inputSchema: { workflowId: z.string() },
  }, async ({ workflowId }) => {
    if (!deps.submitExternalPortify) return errorResult('submitExternalPortify dependency is not configured')
    try {
      const manifest = await deps.submitExternalPortify(workflowId)
      return asJsonResult({
        ...manifest,
        nextSteps: ['get_portify'],
        next: `Poll get_portify with workflowId "${workflowId}": on "ready-to-save" call save_portify; if it returns to "editing", read verification.failureDetail, fix the worktree, and submit_external_portify again. cancel_portify discards the workflow.`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_portify', {
    description: 'Read a port-ification workflow: status (planning/editing/verifying/ready-to-save/saved/failed/aborted), attempt count, and the double-boot verification result. The full unified diff is OMITTED by default (it can be a large multi-file patch) — `diffStats` summarizes it; pass includeDiff:true to inline the patch text.',
    inputSchema: {
      workflowId: z.string(),
      includeDiff: z.boolean().default(false).describe('Inline the full unified diff. Off by default (the patch can be large); diffStats gives files/additions/deletions. Call again with includeDiff:true for the patch text.'),
    },
  }, async ({ workflowId, includeDiff }) => {
    if (!deps.getPortify) return errorResult('getPortify dependency is not configured')
    const manifest = deps.getPortify(workflowId)
    if (!manifest) return errorResult(`port-ification workflow not found: ${workflowId}`)
    if (includeDiff) return asJsonResult(manifest)
    const { diff, ...rest } = manifest
    return asJsonResult({
      ...rest,
      ...(diff ? { diffStats: summarizeUnifiedDiff(diff), diffOmitted: true, diffHint: 'call get_portify with includeDiff:true to inline the patch' } : {}),
    })
  })

  registerTool('list_portify_status', {
    description: "List every feature with whether it is PORTIFIED — i.e. has a saved port overlay (features/<feature>/portify/) so it can boot concurrently (benchmark arms / parallel runs) without an EADDRINUSE clash. `portified` is the source of truth: a VERIFIED overlay exists (proven by the double-boot at save time). `declaredSlots` lists the port slots each service/command declares (informational). Use it to see which features still need start_portify.",
    inputSchema: {},
  }, async () => {
    const features = loadFeatures(deps.featuresDir).map((f) => {
      const pf = computePortPreflight(f)
      return { feature: f.name, portified: portifyOverlayExists(f.featureDir), declaredSlots: pf.repos }
    })
    const portified = features.filter((f) => f.portified).length
    return asJsonResult({
      features,
      summary: { total: features.length, portified, notPortified: features.length - portified },
    })
  })

  registerTool('save_portify', {
    description: "Save a verified port-ification workflow as the feature's EPHEMERAL OVERLAY (captured patch under features/<feature>/portify/) and discard the scratch worktree — NOTHING is committed or merged; the product repo stays pristine. The overlay is applied into a fresh per-run worktree before each run and reverse-applied at teardown. Only valid when status is ready-to-save. Requires confirm: true.",
    inputSchema: {
      workflowId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against saving an unreviewed rewrite.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  }, async ({ workflowId }) => {
    if (!deps.savePortify) return errorResult('savePortify dependency is not configured')
    try {
      const manifest = await deps.savePortify(workflowId)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult({
        ...manifest,
        next: `Overlay saved to features/${manifest.feature}/portify/. The feature now boots with injectable ports on every run — concurrent runs and benchmark arms will not clash — without ever modifying the product repo.`,
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('cancel_portify', {
    description: 'Cancel a port-ification workflow — discards its scratch worktree + branch and restores the feature config. Requires confirm: true.',
    inputSchema: {
      workflowId: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against discarding in-flight work.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ workflowId }) => {
    if (!deps.cancelPortify) return errorResult('cancelPortify dependency is not configured')
    try {
      return asJsonResult(await deps.cancelPortify(workflowId))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('remove_portification', {
    description: "Un-portify a SAVED feature: reverts its feature config (the declared `ports` slots + the `${port.x}` health-check rewrites) and deletes the port overlay, so it boots on its hardcoded ports again and is no longer portified. Always auto-cleans — overlays carry a pre-Portify config snapshot, so the revert is exact. Legacy overlays (no snapshot) best-effort strip the slots; their health-check tokens need a re-run of Portify to regenerate. Requires confirm: true.",
    inputSchema: {
      feature: z.string(),
      confirm: z.literal(true).describe('Must be true. Guards against discarding a saved overlay + reverting config.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ feature }) => {
    if (!deps.removePortification) return errorResult('removePortification dependency is not configured')
    try {
      const result = deps.removePortification(feature)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return asJsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_heal_context', {
    description: 'Compact failure handoff packet an external heal agent needs first: current failures, artifact URLs, heal-index, journal, repo branches, lifecycle, and heal prompt map. Use get_run_snapshot for verbose raw summary/debugging fields.',
    inputSchema: {
      runId: z.string(),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput,
    },
  }, async ({ runId, session_id, client_kind }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (session_id) {
      ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    }
    const context = buildExternalHealContext({
      detail,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    })
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(context)
  })

  registerTool('get_failure_detail', {
    description:
      'One failing test\'s detail: error, location, resolved pointer dirs (trace-extract, playwright-mcp), curated trace summary, and the full error text — both inlined in full (never truncated; a large file over the inline budget is swapped for a `traceSummaryPath`/`errorTextPath` to Read in chunks). Use `failureId` from a failedTests[] entry (get_heal_context / wait_for_heal_task). Built for fan-out: hand each failureId to its own read-only sub-agent to investigate AND draft a proposed patch in parallel; the claim owner then applies the patches serially and signals once.',
    inputSchema: {
      runId: z.string(),
      failureId: z.string().describe('The failureId (== failed test name) from a failedTests[] entry.'),
      session_id: z.string().optional().describe('External heal session id. When provided, refreshes the session heartbeat.'),
      client_kind: clientKindInput,
    },
  }, async ({ runId, failureId, session_id, client_kind }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (session_id) {
      ensureExternalClaimForMcpCall(deps, runId, session_id, client_kind)
    }
    const failure = buildExternalFailureDetail({ detail, logsDir: deps.store.logsDir, failureId })
    if (!failure) return errorResult(`failure not found: ${failureId} (use a failureId from failedTests[])`)
    if (session_id) deps.broker.touch(runId, session_id)
    return asJsonResult(failure)
  })

}
