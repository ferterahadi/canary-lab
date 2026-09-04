import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createCompactExecHandler } from './exec-tool'
import type { CanaryLabMcpExecCallEvent, CanaryLabMcpToolName } from './tool-support'
import type { CanaryLabToolDefinition } from './tool-registry'

const ctx = {} as ServerContext

function resultText(result: CallToolResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : ''
}

describe('compact MCP exec dispatcher', () => {
  it('validates with the atomic schema, applies defaults, and returns the handler result unchanged', async () => {
    const expected: CallToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] }
    const atomicHandler = vi.fn(async () => expected)
    const registry = registryWith({
      name: 'list_features',
      config: {
        description: 'List features.',
        inputSchema: { limit: z.number().int().default(2) },
      },
      handler: atomicHandler,
    })
    const exec = createCompactExecHandler(registry)

    const actual = await exec({ command: 'list_features', arguments: {} }, ctx)

    expect(actual).toBe(expected)
    expect(atomicHandler).toHaveBeenCalledWith({ limit: 2 }, ctx)
  })

  it('keeps destructive confirmation in arguments and rejects a missing confirmation before dispatch', async () => {
    const atomicHandler = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }))
    const registry = registryWith({
      name: 'abort_run',
      config: {
        description: 'Abort a run.',
        inputSchema: { runId: z.string(), confirm: z.literal(true) },
      },
      handler: atomicHandler,
    })
    const exec = createCompactExecHandler(registry)

    const result = await exec({ command: 'abort_run', arguments: { runId: 'r-1' } }, ctx) as CallToolResult

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('confirm')
    expect(atomicHandler).not.toHaveBeenCalled()
  })

  it('discovers coverage by exact internal command name and describes its structured schema', async () => {
    const registry = registryWith({
      name: 'get_feature_coverage',
      config: {
        description: 'Read the semantic requirement-to-test coverage ledger.',
        inputSchema: { feature: z.string().describe('Feature name') },
      },
      handler: async () => ({ content: [] }),
    })
    const exec = createCompactExecHandler(registry)

    const search = await exec({
      command: 'search_tools',
      arguments: { query: 'feature coverage' },
    }, ctx) as CallToolResult
    expect(JSON.parse(resultText(search))).toMatchObject({
      matches: [{ command: 'get_feature_coverage' }],
    })

    const describeResult = await exec({
      command: 'describe_tool',
      arguments: { command: 'get_feature_coverage' },
    }, ctx) as CallToolResult
    expect(JSON.parse(resultText(describeResult))).toMatchObject({
      command: 'get_feature_coverage',
      inputSchema: {
        type: 'object',
        properties: { feature: { type: 'string', description: 'Feature name' } },
        required: ['feature'],
      },
    })
  })

  it('lists the three discovery commands plus all 64 atomic commands', async () => {
    const exec = createCompactExecHandler(new Map())
    const result = await exec({ command: 'list_tools' }, ctx) as CallToolResult
    const parsed = JSON.parse(resultText(result)) as { commands: string[]; count: number }

    expect(parsed.count).toBe(67)
    expect(parsed.commands.slice(0, 3)).toEqual(['list_tools', 'search_tools', 'describe_tool'])
    expect(parsed.commands).toContain('get_feature_coverage')
  })

  it('records only a sanitized unknown command classification in telemetry', async () => {
    const events: CanaryLabMcpExecCallEvent[] = []
    const exec = createCompactExecHandler(new Map(), { onCall: (event) => events.push(event) })

    const result = await exec({
      command: 'secret=value',
      arguments: { token: 'never-log-this' },
    }, ctx) as CallToolResult

    expect(result.isError).toBe(true)
    expect(events).toEqual([{
      command: 'unknown',
      durationMs: expect.any(Number),
      success: false,
    }])
    expect(JSON.stringify(events)).not.toContain('secret')
    expect(JSON.stringify(events)).not.toContain('token')
  })

  it('reports meta-command validation errors without dispatching or logging arguments', async () => {
    const events: CanaryLabMcpExecCallEvent[] = []
    const exec = createCompactExecHandler(new Map(), { onCall: (event) => events.push(event) })

    const list = await exec({
      command: 'list_tools',
      arguments: [] as unknown as Record<string, unknown>,
    }, ctx) as CallToolResult
    const search = await exec({ command: 'search_tools', arguments: { query: '' } }, ctx) as CallToolResult
    const describeResult = await exec({ command: 'describe_tool', arguments: {} }, ctx) as CallToolResult

    expect(resultText(list)).toContain('arguments:')
    expect(resultText(search)).toContain('query')
    expect(resultText(describeResult)).toContain('command')
    expect(events).toEqual([
      expect.objectContaining({ command: 'list_tools', success: false, validationError: true }),
      expect.objectContaining({ command: 'search_tools', success: false, validationError: true }),
      expect.objectContaining({ command: 'describe_tool', success: false, validationError: true }),
    ])
  })

  it('ranks exact, prefix, substring, description-term, and empty-token searches', async () => {
    const registry = registryOf(
      {
        name: 'get_feature_coverage',
        config: {
          description: 'Read the semantic requirement ledger.',
          inputSchema: { feature: z.string() },
        },
        handler: async () => ({ content: [] }),
      },
      {
        name: 'list_features',
        config: { inputSchema: {} },
        handler: async () => ({ content: [] }),
      },
    )
    const exec = createCompactExecHandler(registry)

    const queries = [
      ['get_feature_coverage', 'get_feature_coverage'],
      ['get_feature', 'get_feature_coverage'],
      ['coverage', 'get_feature_coverage'],
      ['semantic ledger', 'get_feature_coverage'],
    ] as const
    for (const [query, expected] of queries) {
      const result = await exec({ command: 'search_tools', arguments: { query, limit: 1 } }, ctx) as CallToolResult
      expect(JSON.parse(resultText(result))).toMatchObject({ matches: [{ command: expected }] })
    }

    const noTokens = await exec({ command: 'search_tools', arguments: { query: '---' } }, ctx) as CallToolResult
    expect(JSON.parse(resultText(noTokens))).toMatchObject({ matches: [], count: 0 })

    const noDescription = await exec({
      command: 'describe_tool',
      arguments: { command: 'list_features' },
    }, ctx) as CallToolResult
    expect(JSON.parse(resultText(noDescription))).toMatchObject({
      command: 'list_features',
      description: '',
    })
  })

  it('describes discovery commands, annotations, nested paths, and invalid paths', async () => {
    const registry = registryWith({
      name: 'get_feature_coverage',
      config: {
        description: 'Read coverage.',
        inputSchema: {
          feature: z.string(),
          nullable: z.null().default(null),
        },
        annotations: { readOnlyHint: true },
      },
      handler: async () => ({ content: [] }),
    })
    const exec = createCompactExecHandler(registry)

    const meta = await exec({
      command: 'describe_tool',
      arguments: { command: 'search_tools' },
    }, ctx) as CallToolResult
    expect(JSON.parse(resultText(meta))).toMatchObject({ command: 'search_tools' })

    const pointer = await exec({
      command: 'describe_tool',
      arguments: { command: 'get_feature_coverage', path: '/properties/feature' },
    }, ctx) as CallToolResult
    expect(JSON.parse(resultText(pointer))).toMatchObject({
      annotations: { readOnlyHint: true },
      path: '/properties/feature',
      inputSchema: { type: 'string' },
    })

    const arrayPath = await exec({
      command: 'describe_tool',
      arguments: { command: 'get_feature_coverage', path: 'required.0' },
    }, ctx) as CallToolResult
    expect(JSON.parse(resultText(arrayPath))).toMatchObject({ inputSchema: 'feature' })

    for (const path of [
      'properties.missing',
      'properties.feature.type.more',
      'properties.nullable.default.more',
    ]) {
      const result = await exec({
        command: 'describe_tool',
        arguments: { command: 'get_feature_coverage', path },
      }, ctx) as CallToolResult
      expect(result.isError).toBe(true)
      expect(resultText(result)).toContain('No schema field exists')
    }

    const unknown = await exec({
      command: 'describe_tool',
      arguments: { command: 'not_a_command' },
    }, ctx) as CallToolResult
    expect(unknown.isError).toBe(true)
    expect(resultText(unknown)).toContain('Unknown Canary Lab command')
  })

  it('bounds oversized schemas while retaining their top-level field names', async () => {
    const inputSchema: Record<string, z.ZodTypeAny> = {}
    for (let index = 0; index < 30; index += 1) {
      inputSchema[`field_${index}`] = z.string().describe('x'.repeat(500))
    }
    const registry = registryWith({
      name: 'list_features',
      config: { description: 'd'.repeat(700), inputSchema },
      handler: async () => ({ content: [] }),
    })
    const exec = createCompactExecHandler(registry)

    const result = await exec({
      command: 'describe_tool',
      arguments: { command: 'list_features' },
    }, ctx) as CallToolResult
    const parsed = JSON.parse(resultText(result)) as {
      truncated: boolean
      description: string
      inputSchema: { properties: string[] }
    }

    expect(parsed.truncated).toBe(true)
    expect(parsed.description).toHaveLength(500)
    expect(parsed.description.endsWith('…')).toBe(true)
    expect(parsed.inputSchema.properties).toHaveLength(30)
    expect(resultText(result).length).toBeLessThan(8_000)
  })

  it('preserves atomic error results and telemetry failures never affect a command', async () => {
    const registry = registryWith({
      name: 'list_features',
      config: { description: 'List features.', inputSchema: {} },
      handler: async () => ({ content: [], isError: true }),
    })
    const onCall = vi.fn(() => { throw new Error('telemetry unavailable') })
    const exec = createCompactExecHandler(registry, { onCall })

    const result = await exec({ command: 'list_features', arguments: {} }, ctx) as CallToolResult

    expect(result.isError).toBe(true)
    expect(onCall).toHaveBeenCalledWith(expect.objectContaining({
      command: 'list_features',
      success: false,
    }))
  })

  it('uses a safe fallback query when an unknown command has no searchable characters', async () => {
    const exec = createCompactExecHandler(new Map())
    const result = await exec({ command: '***', arguments: {} }, ctx) as CallToolResult

    expect(resultText(result)).toContain('"query":"coverage"')
  })
})

function registryWith(
  definition: CanaryLabToolDefinition,
): ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition> {
  return registryOf(definition)
}

function registryOf(
  ...definitions: CanaryLabToolDefinition[]
): ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition]))
}
