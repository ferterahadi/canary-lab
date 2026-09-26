// MCP tools — envset capture/inspection, feature deletion, and the feature repo
// branch surface.
import { z } from 'zod'
import { captureFeatureEnvFiles, checkoutFeatureRepoBranch, getFeatureEnvsetSummary, getFeatureRepoStatus, updateFeatureRepoBranch, type EnvFileSource } from '../../features/config/logic/feature-authoring'
import { deleteSuite } from '../../features/config/logic/feature-deletion'
import { publishWorkspaceEvent } from '../../shared/workspace-events'
import { type ToolGroupContext, asJsonResult, authoringCtx, errorResult, failureResult, isToolErrorPayload } from '../tool-support'

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
        sourcePath: z.string().describe('Existing file whose actual contents are copied into the workspace envset.'),
        env: z.string().optional(),
        slot: z.string().optional(),
        target: z.string().optional().describe('File the consumer reads during a run. Defaults to sourcePath when omitted; set explicitly when importing from elsewhere. Suite default: $CANARY_LAB_PROJECT_ROOT/features/<feature>/.env. Never an envset source or .runtime/envsets path.'),
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
      return failureResult(err)
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
      return failureResult(err)
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
    // Keep MCP's confirmation-first error even when the suite is missing.
    if (confirmName !== feature) return errorResult('confirmName must match the feature name')
    const result = deleteSuite({ featuresDir: deps.featuresDir, workspaceEvents: deps.workspaceEvents,
      removeFlightRecordsFor: deps.removeFlightRecordsFor }, { feature, confirmName })
    if (!result.ok) return errorResult(result.error)
    return asJsonResult({ deleted: true, feature, featureDir: result.featureDir, flightRecordsRemoved: result.flightRecordsRemoved })
  })

  registerTool('get_feature_repo_status', {
    description: 'Get git status for a repo declared in feature.config.cjs: branch, dirty files, headSha, and where the pinned branch stands against its upstream (upstream, upstreamSha, aheadUpstream, behindUpstream). behindUpstream > 0 means a run would boot a stale commit — update_feature_repo_branch (or start_run update_repos:true) fast-forwards it. trackUpstream reports the repo\'s `track: \'upstream\'` setting.',
    inputSchema: {
      feature: z.string(),
      repo: z.string(),
      fetch: z.boolean().default(true).describe('Contact the remote first so the counts describe its current tip (default). false reads the last fetch only; a failed fetch is reported as fetchError beside the stale counts.'),
    },
  }, async ({ feature, repo, fetch }) => {
    const status = await getFeatureRepoStatus({ projectRoot: deps.projectRoot, featuresDir: deps.featuresDir }, feature, repo, { fetch })
    if (!status) return errorResult(`repo not found: ${feature}/${repo}`)
    return asJsonResult(status)
  })

  registerTool('update_feature_repo_branch', {
    description: 'Fast-forward a declared repo\'s checkout to its upstream tip (git fetch + merge --ff-only) so the next run boots the branch\'s latest commit. Targets the feature\'s pinned branch (else the checked-out one). Refused — nothing changes — when the checkout is dirty, detached, on another branch, has diverged from upstream, or the fetch fails; local commits ahead of upstream are left alone. Confirm-gated because it changes the user repo checkout.',
    inputSchema: {
      feature: z.string(),
      repo: z.string(),
      confirm: z.literal(true),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  }, async ({ feature, repo, confirm }) => {
    const result = await updateFeatureRepoBranch(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir, workspaceEvents: deps.workspaceEvents },
      { feature, repo, confirm },
    )
    if (isToolErrorPayload(result)) return errorResult(result.error)
    return asJsonResult(result)
  })

  registerTool('checkout_feature_repo_branch', {
    description: 'Checkout a branch in a repo declared in feature.config.cjs. Confirm-gated because it changes the user repo checkout. To bring an already-checked-out branch to its upstream tip use update_feature_repo_branch instead.',
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
