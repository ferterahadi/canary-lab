import { z } from 'zod'
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import type { ExternalWorkCheckpointData, FlightManifest, FlightCheckpointResponse } from '../../../../shared/flights/types'
import { readDocsCollection } from '../features/coverage/logic/coverage/docs-collection'
import { elicitationAdviceFor } from './client-surface'
import { resolveDocuments } from './document-resolution'
import { issueCheckpointInput } from '../features/flights/logic/checkpoint-input'
import { featureInputUrl } from './document-input'
import { requestUserInput, inputPending, resumeUrlInput } from './elicitation'
import { asJsonResult, type ToolGroupContext } from './tool-support'

export async function requestFlightCheckpoint(
  ctx: ToolGroupContext,
  request: ServerContext | undefined,
  flightId: string,
  documentSource: 'form' | 'upload' | undefined,
  resolution: unknown,
  respond: (response: FlightCheckpointResponse) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const scope = ['flight-checkpoint', ctx.deps.projectRoot, flightId, documentSource, resolution]
  const facts = ctx.clientFacts()
  const resumed = resumeUrlInput(request, facts, scope)
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
  // `advice` is set only when the CLIENT is why no question opened. The two
  // structural callers below (no UI URL, no options) pass nothing, so a missing
  // URL is never reported to the agent as a client limitation.
  const fallback = (advice?: string) => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', flightId,
    next: [advice, secret
      ? 'Open the Canary Lab input URL and enter missing environment values there. Never request secrets in chat or a form elicitation.'
      : 'ASK THE USER for the checkpoint choice or requirements in chat, then call respond_flight_checkpoint with their response. Never invent requirements.',
    ].filter(Boolean).join(' '),
  })
  const unchanged = async (): Promise<CallToolResult | undefined> => {
    const current = await read()
    return !current || current.updatedAt !== flight.updatedAt || current.status !== 'waiting-for-approval'
      ? inputPending('The flight changed while source documents were being resolved. Nothing was applied; read get_flight.') : undefined
  }
  if (docs) {
    const checkpointData = cp.data as { documentResolution?: unknown; lastAttempt?: { reason?: string; outcome?: string } } | undefined
    const context = handoff?.context as { mode?: string } | undefined
    if (external && context?.mode === 'infer-from-diff' && !resolution && !documentSource) return asJsonResult({
      flightId, checkpoint: cp, next: 'The user already authorized inference from the diff. Follow the current handoff and submit with its handOffId; do not ask again.',
    })
    return resolveDocuments({
      ctx, request, feature: flight.feature, scope, revision: [flight.updatedAt, stage.key, cp],
      resolution: resolution ?? checkpointData?.documentResolution ?? (checkpointData?.lastAttempt ? {
        status: 'missing', searched: flight.repoPaths?.length ? flight.repoPaths : ['Flight document collector'],
        reason: checkpointData.lastAttempt.reason ?? `The document collector returned ${checkpointData.lastAttempt.outcome ?? 'no material'}.`,
      } : undefined),
      documentSource, repoPaths: flight.repoPaths, intent: flight.description,
      command: `respond_flight_checkpoint(flightId:"${flightId}")`, beforeWrite: unchanged,
      ready: async (featureDir) => {
        const blocked = await unchanged()
        if (blocked) return blocked
        const sources = readDocsCollection(featureDir)
        if (!sources.entries.length) return inputPending('No requirements documents have been imported yet.')
        if (external) return asJsonResult({ flightId, status: 'documents-ready', docs: sources.entries.map((entry) => ({ relPath: entry.relPath, docsDir: sources.docsDir })),
          next: `Use only these selected source documents for the current docs handoff. Write its required output and submit with handOffId ${handoff?.handOffId}. Preserve the existing flight; do not start a separate coverage job or ask again.`,
        })
        return respond({ choice: 'continue', expectedUpdatedAt: flight.updatedAt })
      },
    })
  }
  if (secret || JSON.stringify(cp.data ?? {}).length > 8000) {
    const inputUrl = featureInputUrl(ctx, flight.feature, stage.key, flightId, cp.kind)
    if (!inputUrl) return fallback()
    const url = new URL(inputUrl)
    url.searchParams.set('inputToken', issueCheckpointInput(flight))
    return requestUserInput(request, facts, {
      scope, mode: 'url', url: url.toString(),
      message: secret ? 'Enter the missing environment values directly in Canary Lab. Secrets stay outside this conversation.' : 'Review this checkpoint or import the requirements in Canary Lab, then return here.',
      fallback: () => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', flightId, url: url.toString(),
        next: `${elicitationAdviceFor(facts, 'url')} Open this Canary Lab URL to provide input, then resume. Never paste credentials into chat.` }),
    }, async () => {
      const current = await read()
      return current && current.updatedAt !== flight.updatedAt
        ? asJsonResult({ flightId, status: current.status, next: 'Read get_flight and continue from the current checkpoint.' })
        : inputPending('The checkpoint is still waiting for input in Canary Lab. Opening the URL does not complete it.')
    })
  }
  const choices = cp.options ?? []
  if (choices.length === 0) return fallback()
  const schema = z.object({
    choice: z.enum(choices as [string, ...string[]]),
    feedback: z.string().max(4000).optional(),
  }).refine((value) => value.choice !== 'revise' || !!value.feedback?.trim())
  return requestUserInput(request, facts, {
    scope, revision: [flight.updatedAt, stage.key, cp], mode: 'form', schema,
    message: cp.message,
    fallback: () => fallback(elicitationAdviceFor(facts, 'form')),
  }, async (answer) => {
    return respond({ choice: answer.choice, ...(answer.feedback ? { feedback: answer.feedback } : {}), expectedUpdatedAt: flight.updatedAt })
  })
}
