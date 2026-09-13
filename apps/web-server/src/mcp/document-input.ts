import { randomUUID } from 'crypto'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { linkFeatureDoc, writeFeatureDoc } from '../features/config/logic/feature-authoring'
import { listFeatureDocs } from '../features/coverage/logic/coverage/feature-docs'
import { requestUserInput, inputPending } from './elicitation'
import { asJsonResult, authoringCtx, errorResult, type ToolGroupContext } from './tool-support'

export function featureInputUrl(ctx: ToolGroupContext, feature: string, stage = 'docs', flightId?: string, checkpointKind?: string): string | undefined {
  const base = ctx.deps.getUiUrl?.()
  if (!base) return undefined
  const url = new URL(base)
  url.search = new URLSearchParams(flightId ? { view: 'flights', flight: flightId, stage } : { view: 'coverage', feature }).toString()
  if (flightId && checkpointKind) url.searchParams.set('elicitation', `${flightId}:${checkpointKind}`)
  return url.toString()
}

export async function requestDocuments(
  ctx: ToolGroupContext,
  request: ServerContext | undefined,
  feature: string,
  scope: unknown,
  upload: boolean,
  fallback: () => CallToolResult,
  ready: () => Promise<CallToolResult | InputRequiredResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const url = featureInputUrl(ctx, feature)
  if (upload) {
    if (!url) return fallback()
    return requestUserInput(request, ctx.clientFacts(), {
      scope, mode: 'url', url,
      message: `Import the requirements documents for ${feature} in Canary Lab, then return here.`,
      fallback: () => asJsonResult({ status: 'needs-docs', feature, url, next: 'Open the document import URL, add the requirements, then retry start_external_summary. Do not invent a document.' }),
    }, async () => {
      return listFeatureDocs(ctx.deps.featuresDir, feature).sourceDocCount > 0 ? ready() : inputPending('The document import is not complete. Add the documents in Canary Lab before resuming.')
    })
  }
  const schema = z.object({
    source: z.enum(['paste', 'local-file', 'upload']).describe('Paste requirements, link a local Markdown file on the Canary server, or import attachments in Canary Lab.'),
    content: z.string().max(32_000).optional().describe('Requirements text when source is paste. Never include passwords or API keys.'),
    local_path: z.string().max(4096).optional().describe('Markdown file path on the machine running Canary Lab, only for local-file.'),
  }).refine((v) => v.source === 'upload' || (v.source === 'paste' ? !!v.content?.trim() : !!v.local_path?.trim()))
  return requestUserInput(request, ctx.clientFacts(), {
    scope, mode: 'form', schema,
    message: `Coverage for ${feature} needs your requirements. Provide the document or choose upload for attachments.`,
    fallback,
  }, async (value) => {
    if (value.source === 'upload') return asJsonResult({
      status: 'needs-docs', feature, ...(url ? { url } : {}),
      next: 'The user chose attachments. Call start_external_summary again with document_source:"upload" and the same feature/session_id to open document import. Do not ask the same question in chat.',
    })
    const relPath = `user-${randomUUID()}.md`
    const result = value.source === 'paste'
      ? writeFeatureDoc(authoringCtx(ctx.deps), { feature, relPath, content: value.content! })
      : linkFeatureDoc(authoringCtx(ctx.deps), { feature, relPath, targetPath: value.local_path! })
    return result.ok ? ready() : errorResult(result.error)
  })
}
