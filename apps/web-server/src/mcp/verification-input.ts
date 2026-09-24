import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { FeatureConfig } from '../../../../shared/launcher/types'
import { deriveVerificationTargets } from '../features/coverage/logic/verification'
import { requestUserInput } from './elicitation'
import { asJsonResult, type ToolGroupContext } from './tool-support'

export function requestVerificationUrls(
  ctx: ToolGroupContext,
  request: ServerContext | undefined,
  feature: FeatureConfig,
  scope: unknown,
  revision: unknown,
  envset: string,
  save: (urls: Record<string, string>) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const { targets } = deriveVerificationTargets(feature, envset)
  const schema = z.object(Object.fromEntries(targets.map((target) => [target.id,
    z.url().refine((value) => {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hostname !== 'replace.invalid'
    }).describe(`Base URL for ${target.name}. HTTP or HTTPS; no credentials or placeholder URLs.`),
  ])))
  return requestUserInput(request, ctx.clientFacts(), {
    scope, revision: [revision, targets], mode: 'form', schema,
    message: `Provide the deployed service URLs for ${feature.name}. Saving this configuration does not run tests.`,
    fallback: () => asJsonResult({ status: 'needs-input', reason: 'elicitation-unavailable', targets,
      next: 'ASK THE USER for these target URLs in chat, then retry with targetUrls. Never invent URLs or select production implicitly.' }),
  }, save)
}
