import { randomUUID } from 'crypto'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { linkFeatureDoc, writeFeatureDoc } from '../features/config/logic/feature-authoring'
import { readDocsCollection } from '../features/coverage/logic/coverage/docs-collection'
import { resolveFeatureDir } from '../features/coverage/logic/coverage/service'
import path from 'path'
import { elicitationAdviceFor } from './client-surface'
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
  ready: (paths: string[]) => Promise<CallToolResult | InputRequiredResult>,
  options: { revision?: unknown; message?: string; command: string; beforeWrite?: () => CallToolResult | undefined | Promise<CallToolResult | undefined> },
): Promise<CallToolResult | InputRequiredResult> {
  const url = featureInputUrl(ctx, feature)
  if (upload) {
    if (!url) return fallback()
    const featureDir = resolveFeatureDir(ctx.deps.featuresDir, feature)
    const before = readDocsCollection(featureDir, { includeExcluded: true })
    const facts = ctx.clientFacts()
    return requestUserInput(request, facts, {
      scope, mode: 'url', url,
      message: `Import the requirements documents for ${feature} in Canary Lab, then return here.`,
      fallback: () => asJsonResult({ status: 'needs-docs', feature, url, next: `${elicitationAdviceFor(facts, 'url')} Open the document import URL, add the requirements, then retry ${options.command}. Do not invent a document.` }),
    }, async () => {
      const check = options.beforeWrite?.()
      const blocked = check instanceof Promise ? await check : check
      if (blocked) return blocked
      const after = readDocsCollection(featureDir, { includeExcluded: true })
      const changed = after.entries.filter((entry) => !before.entries.some((old) => old.relPath === entry.relPath && old.content === entry.content))
      return changed.length > 0 ? ready(changed.map((entry) => path.join(after.docsDir, entry.relPath))) : inputPending('The document import is not complete. Add the documents in Canary Lab before resuming.')
    })
  }
  const schema = z.object({
    source: z.enum(['paste', 'local-file', 'upload']).describe('Paste requirements, link a local Markdown file on the Canary server, or import attachments in Canary Lab.'),
    content: z.string().max(32_000).optional().describe('Requirements text when source is paste. Never include passwords or API keys.'),
    local_path: z.string().max(4096).optional().describe('Markdown file path on the machine running Canary Lab, only for local-file.'),
  }).refine((v) => v.source === 'upload' || (v.source === 'paste' ? !!v.content?.trim() : !!v.local_path?.trim()))
  return requestUserInput(request, ctx.clientFacts(), {
    scope, revision: options.revision, mode: 'form', schema,
    message: options.message ?? `Requirements for ${feature} need your input. Provide the document or choose upload for attachments.`,
    fallback,
  }, async (value) => {
    if (value.source === 'upload') return asJsonResult({
      status: 'needs-docs', feature, ...(url ? { url } : {}),
      next: `The user chose attachments. Call ${options.command} again with document_source:"upload" and the same arguments to open document import. Do not ask the same question in chat.`,
    })
    const check = options.beforeWrite?.()
    const blocked = check instanceof Promise ? await check : check
    if (blocked) return blocked
    const relPath = `user-${randomUUID()}.md`
    const result = value.source === 'paste'
      ? writeFeatureDoc(authoringCtx(ctx.deps), { feature, relPath, content: value.content! })
      : linkFeatureDoc(authoringCtx(ctx.deps), { feature, relPath, targetPath: value.local_path! })
    return result.ok ? ready([result.writtenPath]) : errorResult(result.error)
  })
}
