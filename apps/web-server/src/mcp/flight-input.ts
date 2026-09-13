import { randomUUID } from 'crypto'
import path from 'path'
import { z } from 'zod'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import type { ExternalWorkCheckpointData, FlightManifest, FlightCheckpointResponse } from '../../../../shared/flights/types'
import { linkFeatureDoc, writeFeatureDoc } from '../features/config/logic/feature-authoring'
import { listFeatureDocs } from '../features/coverage/logic/coverage/feature-docs'
import { issueCheckpointInput } from '../features/flights/logic/checkpoint-input'
import { featureInputUrl } from './document-input'
import { requestUserInput, inputPending, resumeUrlInput } from './elicitation'
import { asJsonResult, authoringCtx, errorResult, type ToolGroupContext } from './tool-support'

export async function requestFlightCheckpoint(
  ctx: ToolGroupContext,
  request: ServerContext | undefined,
  flightId: string,
  upload: boolean,
  respond: (response: FlightCheckpointResponse) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const scope = ['flight-checkpoint', ctx.deps.projectRoot, flightId, upload]
  const resumed = resumeUrlInput(request, ctx.clientFacts(), scope)
  if (resumed) return resumed
  const read = async () => {
    const result = await ctx.deps.flightsRequest!({ method: 'GET', url: `/api/flights/${encodeURIComponent(flightId)}` })
    return result.statusCode === 200 ? result.body as FlightManifest : null
  }
  const flight = await read()
  const stage = flight?.stages.find((s) => s.status === 'waiting-for-approval')
  const cp = stage?.checkpoint
  if (!flight || flight.status !== 'waiting-for-approval' || !cp) return inputPending('The flight has no open checkpoint. Read get_flight for its current state.')
  const external = cp.kind === 'external-work'
  const handoff = cp.data as ExternalWorkCheckpointData | undefined
  if (external && (stage.key !== 'docs' || handoff?.takeoverRequestedAt)) return asJsonResult({
    flightId, checkpoint: cp,
    next: 'This checkpoint is agent work, not a user question. Follow get_flight and submit with its current handOffId; honor any takeover request.',
  })
  const docs = cp.kind === 'prd-source' || external
  const secret = cp.kind === 'missing-env'
  const fallback = () => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', flightId,
    next: secret
      ? 'Open the Canary Lab input URL and enter missing environment values there. Never request secrets in chat or a form elicitation.'
      : 'ASK THE USER for the checkpoint choice or requirements in chat, then call respond_flight_checkpoint with their response. Never invent requirements.',
  })
  const docsReady = async (): Promise<CallToolResult> => {
    if (listFeatureDocs(ctx.deps.featuresDir, flight.feature).sourceDocCount === 0) return inputPending('No requirements documents have been imported yet.')
    const current = await read()
    if (!current || current.updatedAt !== flight.updatedAt || current.status !== 'waiting-for-approval') return inputPending('The flight moved on while documents were imported. Read get_flight before continuing.')
    if (external) return asJsonResult({ flightId, status: 'input-received', docsSource: 'user',
      next: `The user supplied documents. Read list_feature_docs and the docs checkpoint prompt; use these requirements instead of gathering. Write the required output and submit with handOffId ${handoff?.handOffId}. Never invent a document.`,
    })
    return respond({ choice: 'continue', expectedUpdatedAt: current.updatedAt })
  }
  if (secret || upload || JSON.stringify(cp.data ?? {}).length > 8000) {
    const inputUrl = featureInputUrl(ctx, flight.feature, upload ? 'docs' : stage.key, upload ? undefined : flightId, cp.kind)
    if (!inputUrl) return fallback()
    const url = new URL(inputUrl)
    if (!upload) url.searchParams.set('inputToken', issueCheckpointInput(flight))
    return requestUserInput(request, ctx.clientFacts(), {
      scope, mode: 'url', url: url.toString(),
      message: secret ? 'Enter the missing environment values directly in Canary Lab. Secrets stay outside this conversation.' : 'Review this checkpoint or import the requirements in Canary Lab, then return here.',
      fallback: () => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', flightId, url: url.toString(),
        next: 'Open this Canary Lab URL to provide input, then resume. Never paste credentials into chat.' }),
    }, async () => {
      if (upload) return docsReady()
      const current = await read()
      return current && current.updatedAt !== flight.updatedAt
        ? asJsonResult({ flightId, status: current.status, next: 'Read get_flight and continue from the current checkpoint.' })
        : inputPending('The checkpoint is still waiting for input in Canary Lab. Opening the URL does not complete it.')
    })
  }
  const choices = docs
    ? [...(external ? ['gather'] : cp.options ?? []), 'supply-docs', 'upload-docs']
    : cp.options ?? []
  if (choices.length === 0) return fallback()
  const schema = z.object({
    choice: z.enum(choices as [string, ...string[]]),
    feedback: z.string().max(4000).optional(),
    ...(docs ? {
      content: z.string().max(32_000).optional().describe('Requirements text for supply-docs; no credentials.'),
      local_path: z.string().max(4096).optional().describe('A requirements file on the Canary server for supply-docs.'),
    } : {}),
  }).refine((value) => value.choice !== 'revise' || !!value.feedback?.trim())
    .refine((value) => value.choice !== 'supply-docs' || (typeof value.content === 'string' && !!value.content.trim()) || (typeof value.local_path === 'string' && !!value.local_path.trim()))
  return requestUserInput(request, ctx.clientFacts(), {
    scope, revision: [flight.updatedAt, stage.key, cp], mode: 'form', schema,
    message: docs ? 'Do you have requirements to provide, or should the agent gather them using this flight’s intent? Choose supply-docs to paste text or link a file, upload-docs for attachments.' : cp.message,
    fallback,
  }, async (answer) => {
    if (answer.choice === 'upload-docs') return asJsonResult({ flightId, status: 'input-received',
      next: 'The user chose attachments. Call respond_flight_checkpoint with this flightId and document_source:"upload"; do not start a separate coverage job.' })
    if (answer.choice === 'gather') return asJsonResult({ flightId, status: 'input-received', docsSource: 'gather',
      next: 'The user chose gathering. Follow the existing docs checkpoint prompt and frozen intent; do not ask again. Submit your work with the current handOffId.' })
    if (answer.choice === 'supply-docs') {
      const context = handoff?.context as { outPath?: string } | undefined
      const relPath = external && context?.outPath ? path.basename(context.outPath) : `user-${randomUUID()}.md`
      const content = typeof answer.content === 'string' ? answer.content : undefined
      const localPath = typeof answer.local_path === 'string' ? answer.local_path : ''
      const result = content?.trim()
        ? writeFeatureDoc(authoringCtx(ctx.deps), { feature: flight.feature, relPath, content })
        : linkFeatureDoc(authoringCtx(ctx.deps), { feature: flight.feature, relPath, targetPath: localPath })
      return result.ok ? docsReady() : errorResult(result.error)
    }
    return respond({ choice: answer.choice, ...(answer.feedback ? { feedback: answer.feedback } : {}), expectedUpdatedAt: flight.updatedAt })
  })
}
