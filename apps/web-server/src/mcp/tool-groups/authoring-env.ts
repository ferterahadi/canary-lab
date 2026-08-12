// MCP tools — envset capture/inspection, feature deletion, and the feature repo
// branch surface. Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { captureFeatureEnvFiles, checkoutFeatureRepoBranch, deleteFeature, getFeatureEnvsetSummary, getFeatureRepoStatus, type EnvFileSource } from '../../features/config/logic/feature-authoring'
import { publishWorkspaceEvent } from '../../shared/workspace-events'
import { type ToolGroupContext, asJsonResult, authoringCtx, errorResult, isToolErrorPayload } from '../tool-support'

export function registerFeatureEnvTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

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
      const result = captureFeatureEnvFiles(authoringCtx(deps), { feature, sources: sources as EnvFileSource[] })
      if (!result.ok) return errorResult(result.error)
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
    const result = deleteFeature(authoringCtx(deps), { feature, confirmName })
    if (!result.ok) return errorResult(result.error)
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
}
