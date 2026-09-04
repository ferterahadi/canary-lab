import { describe, expect, it } from 'vitest'
import { CLIENT_KIND, FULL_TOOLS, type CanaryLabMcpDeps } from './tool-support'
import { createCanaryLabToolRegistry } from './tool-registry'

const inertDeps = {} as CanaryLabMcpDeps

describe('Canary Lab MCP tool registry', () => {
  it('captures every atomic handler exactly once in the canonical order', () => {
    const registry = createCanaryLabToolRegistry({
      deps: inertDeps,
      clientKindInput: CLIENT_KIND.default('other'),
      clientFacts: () => ({ surface: 'other', canFanOut: false, sampling: false }),
    })

    expect(FULL_TOOLS).toHaveLength(64)
    expect([...registry.keys()]).toEqual(FULL_TOOLS)
    expect(registry.size).toBe(64)
    for (const definition of registry.values()) {
      expect(definition.config.inputSchema).toBeDefined()
      expect(typeof definition.handler).toBe('function')
    }
  })
})
