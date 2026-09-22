import { z } from 'zod'
import { elicitationAdviceFor } from '../client-surface'
import { requestUserInput, inputPending, inputFingerprint } from '../elicitation'
import { asJsonResult, errorResult, summarizeUnifiedDiff, type ToolGroupContext } from '../tool-support'

export function registerPortifyReviewTool(ctx: ToolGroupContext): void {
  ctx.registerTool('review_portify', {
    description: 'After showing the verified diff with get_portify(includeDiff:true), request the user\'s save, revise, or discard decision through MCP 2.0 elicitation. Returns the chosen next command; existing save/cancel confirmation gates remain. Only for standalone workflows; a flight owns its own review.',
    inputSchema: { workflowId: z.string() },
  }, async ({ workflowId }, request) => {
    const manifest = ctx.deps.getPortify?.(workflowId)
    if (!manifest) return errorResult(`port-ification workflow not found: ${workflowId}`)
    if (manifest.status !== 'ready-to-save') return inputPending(`The workflow is ${manifest.status}, so there is no verified review to answer.`)
    const proof = { verification: manifest.verification, diffStats: summarizeUnifiedDiff(manifest.diff ?? '') }
    const facts = ctx.clientFacts()
    return requestUserInput(request, facts, {
      scope: ['portify-review', ctx.deps.projectRoot, workflowId], revision: manifest,
      mode: 'form',
      schema: z.object({ choice: z.enum(['save', 'revise', 'discard']), feedback: z.string().max(4000).optional() })
        .refine((value) => value.choice !== 'revise' || !!value.feedback?.trim()),
      message: `Review ${manifest.feature}: ${JSON.stringify(proof)}. Save the verified overlay, request changes, or discard the scratch work?`,
      fallback: () => asJsonResult({ workflowId, ...proof, status: 'needs-input', reason: 'elicitation-unavailable',
        next: `${elicitationAdviceFor(facts, 'form')} Show the verified diff and ASK THE USER whether to save, revise, or discard. Use save_portify/cancel_portify with confirm:true only for their chosen action; revise_external_portify requires their feedback.` }),
    }, async (answer) => asJsonResult({
      workflowId, decision: answer.choice, review_revision: inputFingerprint(manifest), ...(answer.feedback ? { feedback: answer.feedback } : {}),
      next: answer.choice === 'revise'
        ? 'The user requested changes. Call revise_external_portify with this workflowId, feedback, and review_revision.'
        : `The user chose ${answer.choice}. Call ${answer.choice === 'save' ? 'save_portify' : 'cancel_portify'} with this workflowId, review_revision, and confirm:true. Do not ask for the same confirmation again.`,
    }))
  })
}
