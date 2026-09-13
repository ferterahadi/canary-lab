import { createHash, randomUUID } from 'crypto'
import { inputRequired, type CallToolResult, type ElicitRequestFormParams, type InputRequiredResult, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { McpClientFacts } from './client-surface'
import { asJsonResult, errorResult } from './tool-support'

type ToolResult = CallToolResult | InputRequiredResult
type InputSpec<T> = {
  scope: unknown
  revision?: unknown
  message: string
  fallback: () => CallToolResult
} & ({ mode: 'form'; schema: z.ZodType<T> } | { mode: 'url'; url: string })

interface PendingInput {
  scope: string
  revision: string
  expiresAt: number
  result?: Promise<ToolResult>
  url?: { spec: InputSpec<never> & { mode: 'url' }; complete: () => Promise<ToolResult> }
}

// Opaque random handles keep client-echoed requestState out of business logic.
// Shared across per-request MCP server instances; a restart expires open forms.
// Completed receipts also make retried/concurrent answers apply at most once.
const pending = new Map<string, PendingInput>()
const INPUT_TTL_MS = 30 * 60 * 1000
const MAX_PENDING_INPUTS = 1000

export function inputFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
}

export function inputPending(reason: string): CallToolResult {
  return asJsonResult({
    status: 'needs-input',
    reason,
    next: 'Leave this work pending. Do not repeat the question in chat or retry automatically; continue only when the user asks to resume.',
  })
}

/** URL input can advance the domain state before the MCP call resumes. Keep
 * its original completion check so a retry cannot answer a newer checkpoint. */
export function resumeUrlInput(
  ctx: ServerContext | undefined,
  facts: McpClientFacts,
  scope: unknown,
): Promise<ToolResult> | undefined {
  const state = ctx?.mcpReq.requestState?.()
  const entry = typeof state === 'string' ? pending.get(state) : undefined
  if (!entry?.url) return undefined
  return requestUserInput(ctx, facts, { ...entry.url.spec, scope }, entry.url.complete)
}

/** MCP SDK 2.0 multi-round-trip elicitation. Its default legacy shim handles
 * older peers; never call the deprecated push-style elicitInput API here. */
export async function requestUserInput<T>(
  ctx: ServerContext | undefined,
  facts: McpClientFacts,
  spec: InputSpec<T>,
  apply: (value: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id)
  }
  const scope = inputFingerprint([ctx?.sessionId, spec.scope])
  const revision = inputFingerprint(spec.revision)
  const state = ctx?.mcpReq.requestState?.()
  if (state !== undefined) {
    const entry = typeof state === 'string' ? pending.get(state) : undefined
    if (!entry || entry.scope !== scope) return inputPending('The input request expired or belongs to a different operation. Nothing was applied.')
    if (entry.result) return entry.result
    if (entry.revision !== revision) return inputPending('The work changed while the question was open. Nothing was applied; review its current state before resuming.')
    const response = z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.unknown().optional() }).safeParse(ctx?.mcpReq.inputResponses?.answer)
    if (!response.success) return errorResult('Invalid elicitation response. Nothing was applied.')
    if (response.data.action !== 'accept') {
      entry.result = Promise.resolve(inputPending(`The user chose ${response.data.action}. Nothing was applied.`))
    } else if (spec.mode === 'form') {
      const parsed = spec.schema.safeParse(response.data.content)
      if (!parsed.success) return errorResult('The submitted input does not match the requested fields. Nothing was applied.')
      entry.result = Promise.resolve().then(() => apply(parsed.data))
    } else {
      // URL-mode carries no input data. Completion must be checked in the
      // existing domain store by apply(), never inferred from opening a URL.
      entry.result = Promise.resolve().then(() => apply(undefined as T))
    }
    return entry.result
  }

  const supported = facts.elicitation?.[spec.mode] === true
  if (!ctx || !supported) return spec.fallback()
  if (pending.size >= MAX_PENDING_INPUTS) return inputPending('Too many open input requests. Resume after an earlier request expires.')
  const id = randomUUID()
  pending.set(id, {
    scope, revision, expiresAt: now + INPUT_TTL_MS,
    ...(spec.mode === 'url' ? { url: { spec, complete: () => apply(undefined as T) } } : {}),
  })
  return inputRequired({
    requestState: id,
    inputRequests: {
      answer: spec.mode === 'url'
        ? inputRequired.elicitUrl({ message: spec.message, url: spec.url })
        : inputRequired.elicit({
            message: spec.message,
            requestedSchema: z.toJSONSchema(spec.schema) as ElicitRequestFormParams['requestedSchema'],
          }),
    },
  })
}
