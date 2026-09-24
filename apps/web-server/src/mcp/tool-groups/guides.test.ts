import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CANARY_LAB_MCP_WORKFLOWS, WORKFLOW_GUIDES } from '../instructions'
import { createCanaryLabToolRegistry } from '../tool-registry'
import { CLIENT_KIND, type CanaryLabMcpDeps } from '../tool-support'

const inertDeps = {} as CanaryLabMcpDeps

describe('get_workflow_guide', () => {
  const registry = createCanaryLabToolRegistry({
    deps: inertDeps,
    clientKindInput: CLIENT_KIND.default('other'),
    clientFacts: () => ({ surface: 'other', canFanOut: false, sampling: false }),
  })
  const definition = registry.get('get_workflow_guide')!

  it('is read-only and accepts exactly the known workflows', () => {
    expect(definition.config.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    const schema = z.object(definition.config.inputSchema)
    for (const workflow of CANARY_LAB_MCP_WORKFLOWS) expect(schema.safeParse({ workflow }).success).toBe(true)
    expect(schema.safeParse({ workflow: 'lifecycle' }).success).toBe(false)
  })

  it.each(CANARY_LAB_MCP_WORKFLOWS)('returns the complete %s guide as plain text', async (workflow) => {
    const result = await definition.handler({ workflow }, {} as never)
    expect(result).toEqual({ content: [{ type: 'text', text: WORKFLOW_GUIDES[workflow] }] })
  })
})
