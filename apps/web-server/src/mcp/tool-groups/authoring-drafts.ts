// MCP tools — the external test-authoring draft lifecycle.
// Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { loadFeatures } from '../../shared/feature-loader'
import { applyExternalDraftFiles } from '../../features/config/logic/feature-authoring'
import {
  createDraft,
  paths as draftPaths,
  readDraft,
  writeDraft,
  type DraftRecord,
  type ExternalDraftStage,
} from '../../features/wizard/logic/draft-store'
import { publishWorkspaceEvent } from '../../shared/workspace-events'
import { type ToolGroupContext, EXTERNAL_DRAFT_STAGE, asJsonResult, errorResult, externalDraftAuthoringNextSteps, externalDraftView, gettingStartedBusyResult, newDraftId, statusForExternalStage } from '../tool-support'

export function registerExternalDraftTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

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
    // Getting Started demo tracking: claim BEFORE the record exists so a second
    // demo can't slip in between; attach right after the write links the claim.
    const claim = deps.gettingStartedDemo?.claim('author', feature) ?? null
    if (claim?.kind === 'busy') return gettingStartedBusyResult(claim)
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
    if (claim?.kind === 'claimed') deps.gettingStartedDemo?.attach(claim.sessionId, { kind: 'draft', id: draftId, feature })
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
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: current.featureName })
    return asJsonResult({
      draftId,
      feature: current.featureName,
      status: 'applied',
      written: applied.written,
    })
  })
}
