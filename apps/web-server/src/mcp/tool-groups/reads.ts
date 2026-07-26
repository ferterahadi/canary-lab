// MCP tools — reads.
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
  asJsonResult,
  asToonResult,
  errorResult,
  verificationResult } from '../tool-support'

export function registerReadTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  // ─── reads ────────────────────────────────────────────────────────────

  registerTool('list_features', {
    description: 'List existing Canary Lab features when you need to choose or inspect one. Do not call this before random/new feature creation; call create_feature directly with a unique name and retry on collision. Returned as a TOON table `[N]{name,description,envs,repos}:`. To keep one flat row per feature, the list-valued columns are packed: `envs` is `|`-joined env names; `repos` is `|`-joined repo entries, each `name@localPath@branch` (branch empty if none). Split on `|` then `@` to unpack.',
    inputSchema: {},
  }, async () => {
    const features = loadFeatures(deps.featuresDir).map((f) => ({
      name: f.name,
      description: f.description ?? '',
      // Pack the list-valued fields into delimited scalars so the array reaches
      // the TOON tabular form (one flat row per feature) instead of the verbose
      // list form. Lossless for paths/branches that don't contain `@` or `|`.
      envs: (f.envs ?? []).join('|'),
      repos: (f.repos ?? [])
        .map((r) => [r.name, r.localPath, r.branch ?? ''].join('@'))
        .join('|'),
    }))
    return asToonResult(features)
  })

  registerTool('list_runs', {
    description: 'List Canary Lab runs, newest first (default 20 — raise `limit` for more history). Optionally filter by feature. Each row is already slim (id, feature, status, timestamps); fetch one run\'s detail with get_run. Returned as a TOON table: a `[N]{col,...}:` header line followed by one comma-separated row per run (quoted cells are JSON-escaped strings).',
    inputSchema: {
      feature: z.string().optional().describe('Feature name. Omit to list across all features.'),
      limit: z.number().int().positive().max(200).default(20).describe('Max runs to return, newest first. Default 20.'),
    },
  }, async ({ feature, limit }) => {
    return asToonResult(deps.store.list(feature ? { feature } : {}).slice(0, limit))
  })

  registerTool('get_run', {
    description: 'Fetch one run\'s core detail: manifest + summary + artifact base URL. The bulky raw arrays (lifecycleEvents, playwrightArtifacts, playbackEvents) are OMITTED by default to protect context — pass includeRaw:true to inline them when you need them. Never poll this to wait for a result; block on wait_for_heal_task.',
    inputSchema: {
      runId: z.string(),
      includeRaw: z.boolean().default(false).describe('Inline the full lifecycleEvents[] + playwrightArtifacts[] + playbackEvents[]. Off by default (they can be large); call again with includeRaw:true when you need the raw timeline/artifacts.'),
    },
  }, async ({ runId, includeRaw }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    // Eval-review-first: a terminal run's next stop is the evaluation export —
    // reviewing it (per-test reasoning + playback) IS the core canary loop.
    const next = isTerminalRunStatus(detail.manifest.status)
      ? { next: `Run is terminal (${detail.manifest.status}) — the next step is the evaluation export: start_external_evaluation_export(runId) to produce it (status preserved, even for a failed run), then get_evaluation_export / download_evaluation_export and point the user at reviewing evaluation.html.` }
      : {}
    if (includeRaw) return asJsonResult({ ...detail, ...next })
    const { lifecycleEvents: _lifecycleEvents, playwrightArtifacts: _playwrightArtifacts, playbackEvents: _playbackEvents, ...core } = detail
    return asJsonResult({
      ...core,
      artifactsBase: `/api/runs/${encodeURIComponent(runId)}/artifacts/`,
      raw: { omitted: ['lifecycleEvents', 'playwrightArtifacts', 'playbackEvents'], hint: 'call get_run with includeRaw:true to inline them' },
      ...next,
    })
  })

  registerTool('get_run_snapshot', {
    description: 'Verbose external-heal run snapshot: summary, full counts, failed tests, artifact base, heal prompt map, and the heal index + journal as on-disk PATHS (Read them for the full markdown — never inlined, so a long heal loop can\'t bloat the response). For verbose debugging only; never poll it to wait — block on wait_for_heal_task.',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    return asJsonResult(buildExternalRunSnapshotSlim({
      detail,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    }))
  })

  registerTool('get_run_actions', {
    description: 'Which actions are valid right now for a run (pauseHeal, stop, cancelHeal, delete, restartHeal, signal kinds, evaluation export).',
    inputSchema: { runId: z.string() },
  }, async ({ runId }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    const status = detail.manifest.status
    return asJsonResult({
      status,
      availability: deriveRunActionAvailability(status, null),
      signal: { rerun: isActiveRunStatus(status), restart: isActiveRunStatus(status), heal: isActiveRunStatus(status) },
      evaluationExport: { available: isTerminalRunStatus(status) },
      externalClaim: deps.broker.getSession(runId),
    })
  })

  registerTool('list_verification_configs', {
    description: 'List saved Verify configurations for a Canary Lab feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
    },
  }, async ({ featureId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    return asJsonResult(listVerificationConfigs(feature))
  })

  registerTool('get_verification_config', {
    description: 'Fetch one saved Verify configuration for a Canary Lab feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      configId: z.string().describe('Verification config id.'),
    },
  }, async ({ featureId, configId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    const config = getVerificationConfig(feature, configId)
    if (!config) return errorResult(`verification config not found: ${configId}`)
    return asJsonResult(config)
  })

  registerTool('create_verification_config', {
    description: 'Create a saved Verify configuration for a feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      name: z.string().describe('Configuration name, e.g. Beta or Staging.'),
      targetUrls: z.record(z.string(), z.string()).describe('Target URLs keyed by verification target id.'),
      playwrightEnvsetId: z.string().describe('Playwright envset to apply for verification.'),
    },
  }, async ({ featureId, name, targetUrls, playwrightEnvsetId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    try {
      const created = createVerificationConfig(feature, { name, targetUrls, playwrightEnvsetId })
      // Refresh an open Verify dialog on other clients without a reopen.
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'verification-config-changed', feature: featureId })
      return asJsonResult(created)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('update_verification_config', {
    description: 'Update a saved Verify configuration for a feature.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      configId: z.string().describe('Verification config id.'),
      name: z.string().describe('Configuration name, e.g. Beta or Staging.'),
      targetUrls: z.record(z.string(), z.string()).describe('Target URLs keyed by verification target id.'),
      playwrightEnvsetId: z.string().describe('Playwright envset to apply for verification.'),
    },
  }, async ({ featureId, configId, name, targetUrls, playwrightEnvsetId }) => {
    const feature = loadFeatures(deps.featuresDir).find((candidate) => candidate.name === featureId)
    if (!feature) return errorResult(`feature not found: ${featureId}`)
    try {
      const config = updateVerificationConfig(feature, configId, { name, targetUrls, playwrightEnvsetId })
      if (!config) return errorResult(`verification config not found: ${configId}`)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'verification-config-changed', feature: featureId })
      return asJsonResult(config)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('execute_verification', {
    description: 'Execute Verify for a deployed environment. This never starts local services and never starts healing.',
    inputSchema: {
      featureId: z.string().describe('Feature name.'),
      configId: z.string().optional().describe('Saved verification config id.'),
      targetUrls: z.record(z.string(), z.string()).optional().describe('Target URLs keyed by verification target id.'),
      playwrightEnvsetId: z.string().optional().describe('Playwright envset to apply for verification.'),
    },
  }, async ({ featureId, configId, targetUrls, playwrightEnvsetId }) => {
    if (!deps.startVerification) return errorResult('startVerification dependency is not configured')
    try {
      const started = await deps.startVerification(featureId, {
        ...(configId ? { configId } : {}),
        ...(targetUrls ? { targetUrls } : {}),
        ...(playwrightEnvsetId ? { playwrightEnvsetId } : {}),
      })
      const detail = deps.store.get(started.runId)
      if (!detail) {
        return asJsonResult({
          executionId: started.runId,
          executionType: 'verify',
          status: 'queued',
          targetUrls: targetUrls ?? {},
          playwrightEnvsetId: playwrightEnvsetId ?? '',
        })
      }
      return asJsonResult(verificationResult(detail))
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('get_verification_result', {
    description: 'Retrieve Verify result and diagnostics for a verification execution.',
    inputSchema: {
      executionId: z.string().describe('Verification execution id.'),
    },
  }, async ({ executionId }) => {
    const detail = deps.store.get(executionId)
    if (!detail) return errorResult(`verification result not found: ${executionId}`)
    if ((detail.manifest.executionType ?? 'run') !== 'verify') {
      return errorResult(`execution is not verify: ${executionId}`)
    }
    return asJsonResult(verificationResult(detail))
  })

}
