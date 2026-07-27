// MCP tools — the externally-driven PRD-summary and coverage-mapping passes.
// Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { FeatureNotFoundError } from '../../features/coverage/logic/coverage/service'
import { CoverageJobRunStore } from '../../features/coverage/logic/coverage/jobs/store'
import { CoverageJobConflictError } from '../../features/coverage/logic/coverage/jobs/runner'
import {
  startExternalCoverage,
  submitExternalCoverage,
  startExternalSummary,
  submitExternalSummary,
} from '../../features/coverage/logic/coverage/jobs/external'
import type { ParsedRequirement } from '../../features/coverage/logic/coverage/prd-summary'
import type { ProposedMapping } from '../../../../../shared/coverage/types'
import { type ToolGroupContext, asJsonResult, coverageMappingInput, errorResult, summaryRequirementInput, variantDimensionInput } from '../tool-support'

export function registerCoverageAuthoringTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

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
}
