import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  EXEC_TOOL_NAME,
  FULL_TOOLS,
  asJsonResult,
  errorResult,
  type CanaryLabMcpExecCallEvent,
  type CanaryLabMcpExecCommand,
  type CanaryLabMcpToolName,
} from './tool-support'
import type {
  CanaryLabToolConfig,
  CanaryLabToolDefinition,
} from './tool-registry'

const LIST_TOOLS_COMMAND = 'list_tools'
const SEARCH_TOOLS_COMMAND = 'search_tools'
const DESCRIBE_TOOL_COMMAND = 'describe_tool'
const META_COMMANDS = [LIST_TOOLS_COMMAND, SEARCH_TOOLS_COMMAND, DESCRIBE_TOOL_COMMAND] as const
type MetaCommand = typeof META_COMMANDS[number]

const listToolsInput = z.object({}).strict()
const searchToolsInput = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(25).default(10),
}).strict()
const describeToolInput = z.object({
  command: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(500).optional(),
}).strict()

const META_DEFINITIONS: ReadonlyMap<MetaCommand, { description: string; inputSchema: z.ZodRawShape }> = new Map([
  [LIST_TOOLS_COMMAND, {
    description: 'List every exact Canary Lab command name available through exec.',
    inputSchema: listToolsInput.shape,
  }],
  [SEARCH_TOOLS_COMMAND, {
    description: 'Search exact command names and descriptions. Use this when you know the workflow but not the command name.',
    inputSchema: searchToolsInput.shape,
  }],
  [DESCRIBE_TOOL_COMMAND, {
    description: 'Describe one command and its structured arguments. Pass path to inspect a nested JSON Schema field.',
    inputSchema: describeToolInput.shape,
  }],
])

export const COMPACT_EXEC_DESCRIPTION = `Run one Canary Lab command by its exact internal tool name.

Input is always structured JSON: {"command":"<exact_tool_name>","arguments":{"feature":"<feature_name>"}} for a feature-scoped command. The command value is the tool name; arguments follow that command's schema. Do not invent verbs such as "learn" or "call", put JSON in a string, or translate it into flags. Keep safety fields such as confirm:true inside arguments.

Discovery commands use the same shape: list_tools, search_tools, and describe_tool. Results come directly from the existing atomic handler.`

export const COMPACT_EXEC_CONFIG = {
  title: 'Canary Lab command',
  description: COMPACT_EXEC_DESCRIPTION,
  inputSchema: {
    command: z.string().trim().min(1).max(200).describe('Exact Canary Lab command name.'),
    arguments: z.record(z.string(), z.unknown()).default({}).describe('Structured arguments for that command.'),
  },
  _meta: { 'anthropic/alwaysLoad': true },
} satisfies CanaryLabToolConfig

export interface CompactExecOptions {
  onCall?: (event: CanaryLabMcpExecCallEvent) => void
}

export function registerCompactExecTool(
  server: McpServer,
  registry: ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition>,
  opts: CompactExecOptions = {},
): void {
  const handler = createCompactExecHandler(registry, opts)
  const register = server.registerTool as unknown as (
    name: string,
    config: CanaryLabToolConfig,
    callback: typeof handler,
  ) => unknown
  register.call(server, EXEC_TOOL_NAME, COMPACT_EXEC_CONFIG, handler)
}

export function createCompactExecHandler(
  registry: ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition>,
  opts: CompactExecOptions = {},
): (
  input: { command: string; arguments?: Record<string, unknown> },
  ctx: ServerContext,
) => Promise<CallToolResult | InputRequiredResult> {
  return async (input, ctx) => {
    const startedAt = Date.now()
    const command = classifyCommand(input.command, registry)
    let success = false
    let validationError = false

    try {
      const args = input.arguments ?? {}
      if (command === 'unknown') {
        return errorResult(
          `Unknown Canary Lab command "${input.command}". Call exec with command:"search_tools" and arguments:{"query":"${safeQueryHint(input.command)}"}.`,
        )
      }

      if (isMetaCommand(command)) {
        const result = runMetaCommand(command, args, registry)
        success = !result.isError
        validationError = !!result.isError
        return result
      }

      // classifyCommand only returns an atomic name present in this registry.
      const definition = registry.get(command)!
      const parsed = z.object(definition.config.inputSchema).safeParse(args)
      if (!parsed.success) {
        validationError = true
        return errorResult(formatValidationError(command, parsed.error))
      }

      const result = await definition.handler(parsed.data as Record<string, unknown>, ctx)
      success = result.isError !== true
      return result
    } finally {
      notify(opts.onCall, {
        command,
        durationMs: Date.now() - startedAt,
        success,
        ...(validationError ? { validationError: true } : {}),
      })
    }
  }
}

function runMetaCommand(
  command: MetaCommand,
  args: Record<string, unknown>,
  registry: ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition>,
): CallToolResult {
  if (command === LIST_TOOLS_COMMAND) {
    const parsed = listToolsInput.safeParse(args)
    if (!parsed.success) return errorResult(formatValidationError(command, parsed.error))
    return asJsonResult({
      commands: [...META_COMMANDS, ...FULL_TOOLS],
      count: META_COMMANDS.length + FULL_TOOLS.length,
    })
  }

  if (command === SEARCH_TOOLS_COMMAND) {
    const parsed = searchToolsInput.safeParse(args)
    if (!parsed.success) return errorResult(formatValidationError(command, parsed.error))
    const query = parsed.data.query.toLowerCase()
    const matches = commandCatalog(registry)
      .map((entry) => ({ ...entry, score: matchScore(entry, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))
      .slice(0, parsed.data.limit)
      .map(({ score: _score, ...entry }) => entry)
    return asJsonResult({ query: parsed.data.query, matches, count: matches.length })
  }

  const parsed = describeToolInput.safeParse(args)
  if (!parsed.success) return errorResult(formatValidationError(command, parsed.error))
  const definition = commandDefinition(parsed.data.command, registry)
  if (!definition) {
    return errorResult(
      `Unknown Canary Lab command "${parsed.data.command}". Use search_tools to find the exact command name.`,
    )
  }

  const jsonSchema = z.toJSONSchema(z.object(definition.inputSchema), { io: 'input' }) as Record<string, unknown>
  const selected = parsed.data.path ? schemaAtPath(jsonSchema, parsed.data.path) : jsonSchema
  if (selected === undefined) {
    return errorResult(
      `No schema field exists at path "${parsed.data.path}" for command "${parsed.data.command}". Describe the command without path to see its top-level fields.`,
    )
  }
  const result = {
    command: parsed.data.command,
    description: definition.description,
    annotations: definition.annotations,
    path: parsed.data.path,
    inputSchema: selected,
  }
  return boundedJsonResult(result, {
    command: parsed.data.command,
    description: truncate(definition.description, 500),
    inputSchema: {
      type: 'object',
      properties: Object.keys(jsonSchema.properties as Record<string, unknown>),
    },
    truncated: true,
  })
}

function commandCatalog(
  registry: ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition>,
): Array<{ command: string; description: string }> {
  const meta = META_COMMANDS.map((command) => ({
    command,
    description: META_DEFINITIONS.get(command)!.description,
  }))
  const atomic = [...registry.values()].map(({ name, config }) => ({
    command: name,
    description: truncate(config.description ?? '', 300),
  }))
  return [...meta, ...atomic]
}

function commandDefinition(
  command: string,
  registry: ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition>,
): { description: string; inputSchema: z.ZodRawShape; annotations?: unknown } | undefined {
  if (isMetaCommand(command)) {
    const meta = META_DEFINITIONS.get(command)!
    return { description: meta.description, inputSchema: meta.inputSchema }
  }
  const atomic = registry.get(command as CanaryLabMcpToolName)
  if (!atomic) return undefined
  return {
    description: atomic.config.description ?? '',
    inputSchema: atomic.config.inputSchema,
    ...(atomic.config.annotations ? { annotations: atomic.config.annotations } : {}),
  }
}

function classifyCommand(
  raw: string,
  registry: ReadonlyMap<CanaryLabMcpToolName, CanaryLabToolDefinition>,
): CanaryLabMcpExecCommand {
  if (isMetaCommand(raw)) return raw
  return registry.has(raw as CanaryLabMcpToolName) ? raw as CanaryLabMcpToolName : 'unknown'
}

function isMetaCommand(value: string): value is MetaCommand {
  return (META_COMMANDS as readonly string[]).includes(value)
}

function matchScore(entry: { command: string; description: string }, query: string): number {
  const command = entry.command.toLowerCase()
  const description = entry.description.toLowerCase()
  if (command === query) return 100
  if (command.startsWith(query)) return 80
  if (command.includes(query)) return 60
  const terms = query.split(/[^a-z0-9]+/).filter(Boolean)
  if (terms.length === 0) return 0
  const commandHits = terms.filter((term) => command.includes(term)).length
  const descriptionHits = terms.filter((term) => description.includes(term)).length
  return commandHits * 10 + descriptionHits * 2
}

function formatValidationError(command: string, error: z.ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : 'arguments'
    return `${field}: ${issue.message}`
  })
  return `Invalid arguments for Canary Lab command "${command}": ${issues.join('; ')}. Call describe_tool for its schema.`
}

function schemaAtPath(schema: Record<string, unknown>, path: string): unknown {
  const segments = path.startsWith('/')
    ? path.slice(1).split('/')
    : path.split('.')
  let current: unknown = schema
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
    if (current === undefined) return undefined
  }
  return current
}

function boundedJsonResult(value: unknown, fallback: unknown): CallToolResult {
  return JSON.stringify(value).length <= 8_000 ? asJsonResult(value) : asJsonResult(fallback)
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function safeQueryHint(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, ' ').trim().slice(0, 80) || 'coverage'
}

function notify(
  callback: CompactExecOptions['onCall'],
  event: CanaryLabMcpExecCallEvent,
): void {
  try {
    callback?.(event)
  } catch {
    // Telemetry cannot change the command result.
  }
}
