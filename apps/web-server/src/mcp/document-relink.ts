import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { linkFeatureDoc } from '../features/config/logic/feature-authoring'
import { readDocsCollection } from '../features/coverage/logic/coverage/docs-collection'
import { readDocumentSelection } from '../features/coverage/logic/coverage/document-resolution'
import { listFeatureDocs } from '../features/coverage/logic/coverage/feature-docs'
import { elicitationAdviceFor } from './client-surface'
import { featureInputUrl } from './document-input'
import { completedUserInput, inputFingerprint, inputPending, requestUserInput } from './elicitation'
import { asJsonResult, authoringCtx, errorResult, type ToolGroupContext } from './tool-support'

/** Repair source identity before discovery can accidentally omit a missing
 * requirement. Relinking never adopts new contents or replaces the baseline. */
export async function requestBrokenDocumentPath(options: {
  ctx: ToolGroupContext
  request: ServerContext | undefined
  feature: string
  featureDir: string
  scope: unknown
  revision?: unknown
  command: string
  beforeWrite?: () => CallToolResult | undefined | Promise<CallToolResult | undefined>
}): Promise<CallToolResult | InputRequiredResult | undefined> {
  const { ctx, request, feature, featureDir, command } = options
  const scope = ['document-relink', options.scope]
  const completed = completedUserInput(request, scope)
  if (completed) return completed
  const snapshot = () => ({
    broken: listFeatureDocs(ctx.deps.featuresDir, feature).docs
      .filter((doc) => doc.broken && !doc.generated)
      .map(({ relPath, linkTarget }) => ({ relPath, linkTarget })),
    docsHash: readDocsCollection(featureDir, { includeExcluded: true }).docsHash,
    selection: readDocumentSelection(featureDir),
  })
  const before = snapshot()
  const doc = before.broken[0]
  if (!doc) return undefined
  const url = featureInputUrl(ctx, feature)
  const facts = ctx.clientFacts()
  return requestUserInput(request, facts, {
    scope, revision: [options.revision, before], mode: 'form',
    message: `The source document ${doc.relPath} for ${feature} is unavailable. Previous path: ${doc.linkTarget ?? 'unknown'}. Where is the file now? Enter its new path on the machine running Canary Lab. This repairs the symlink without creating a recovery copy.`,
    schema: z.object({ local_path: z.string().trim().min(1).max(4096).describe('New absolute or ~/ path to the moved source document on the Canary Lab server.') }),
    fallback: () => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', feature, brokenDoc: doc, ...(url ? { url } : {}),
      next: `${elicitationAdviceFor(facts, 'form')} Ask the user to repair ${doc.relPath} with Relink in Canary Lab, then retry ${command} with the same arguments. Do not omit the missing source or create a recovery copy.` }),
  }, async ({ local_path }) => {
    const blocked = await options.beforeWrite?.()
    if (blocked) return blocked
    if (inputFingerprint(snapshot()) !== inputFingerprint(before)) return inputPending('The documents changed while the relink question was open. Nothing was applied; review their current state.')
    const result = linkFeatureDoc(authoringCtx(ctx.deps), { feature, relPath: doc.relPath, targetPath: local_path, relink: true })
    if (!result.ok) return errorResult(`${result.error}. The link was not replaced. Retry ${command} to provide another path.`)
    return asJsonResult({ status: 'document-relinked', feature, relativePath: result.relativePath, linked: true,
      next: `Retry ${command} with the same arguments to continue. Remaining broken links still require input; changed contents must pass the existing document discovery and drift checks.` })
  })
}
