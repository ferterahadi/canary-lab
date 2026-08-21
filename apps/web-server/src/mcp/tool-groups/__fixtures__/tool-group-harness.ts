import { CLIENT_KIND, type ToolGroupContext } from '../../tool-support'
import type { McpClientFacts } from '../../client-surface'

// Drives one tool group without a server: capture the handlers it registers,
// then call them directly against fake deps. What these tools branch on is the
// DEPENDENCY's answer, not the transport, so an MCP client over HTTP would add
// a server boot and a port per assertion and prove nothing extra.

type Handler = (args: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>

export interface ToolConfig {
  inputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface CapturedTools {
  /** Call a tool and parse its JSON result — what `asJsonResult` returns. */
  call: (tool: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Call a tool and read its raw text — `errorResult` returns plain prose. */
  text: (tool: string, args?: Record<string, unknown>) => Promise<string>
  configs: Map<string, ToolConfig>
  toolNames: string[]
}

export const DEFAULT_CLIENT_FACTS: McpClientFacts = { surface: 'other', canFanOut: false, sampling: false }

/** `deps` is deliberately `unknown`-ish: every group reads a different slice of
 *  CanaryLabMcpDeps, and a test that wired the whole thing would be asserting
 *  its own fixture. Each suite passes only what its tools touch. */
export function captureTools(
  register: (ctx: ToolGroupContext) => void,
  deps: Record<string, unknown>,
  clientFacts: McpClientFacts = DEFAULT_CLIENT_FACTS,
): CapturedTools {
  const handlers = new Map<string, Handler>()
  const configs = new Map<string, ToolConfig>()
  const ctx = {
    registerTool: ((name: string, config: ToolConfig, handler: Handler) => {
      handlers.set(name, handler)
      configs.set(name, config)
    }) as unknown as ToolGroupContext['registerTool'],
    deps: deps as unknown as ToolGroupContext['deps'],
    clientFacts: () => clientFacts,
    clientKindInput: CLIENT_KIND.default('other'),
  } as unknown as ToolGroupContext
  register(ctx)

  const text = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const handler = handlers.get(tool)
    if (!handler) throw new Error(`tool-group harness: no such tool "${tool}"`)
    const result = await handler(args)
    return result.content?.[0]?.text ?? ''
  }
  return {
    text,
    call: async (tool, args) => JSON.parse(await text(tool, args)) as Record<string, unknown>,
    configs,
    toolNames: [...handlers.keys()],
  }
}
