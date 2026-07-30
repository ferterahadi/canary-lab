// Who is on the other end of an MCP session, and what can they actually do.
//
// Canary used to instruct every external client identically and then conclude
// from silence that a client "wouldn't fan out". Two facts make that wrong:
//
//   1. `clientInfo.name` distinguishes the surfaces. Claude Desktop has TWO MCP
//      clients — its plain chat client (`claude-ai`) and its local-agent mode,
//      which runs the real Claude Code CLI (`claude-code`) and therefore HAS the
//      Task subagent primitive. "Desktop can't fan out" is only true of the chat
//      client.
//   2. Nothing declares `sampling`. Verified against the shipped binaries: the
//      Claude Code CLI's sole client-capability literal is
//      `{roots:{listChanged:true}, elicitation:{}, …}` and Desktop's
//      local-agent-mode client declares roots + a UI extension — neither carries
//      a `sampling` key. So server-driven completions are not an option today;
//      we READ the capability rather than assume it, so the day one ships this
//      answers itself instead of needing a code change.
//
// Reading this is what lets Canary tell a client to divide its work only when the
// client can, instead of emitting prose it will silently skip.

export type McpClientSurface = 'claude-code' | 'claude-desktop-chat' | 'codex' | 'other'

export interface McpClientFacts {
  name?: string
  version?: string
  surface: McpClientSurface
  /** Can this client dispatch its own subagents / background agents? Drives
   *  whether a hand-off tells the agent to fan the reading out or to read
   *  serially. Conservative by default: an unknown client is told to read
   *  serially, which is slower but never asks for something impossible. */
  canFanOut: boolean
  /** Did the client declare `sampling` at initialize? Currently false for every
   *  shipped client — kept as a real read so this stops being true silently. */
  sampling: boolean
}

/** Shapes accepted from the SDK's `getClientVersion()` / `getClientCapabilities()`
 *  without importing their types: both are `Implementation | undefined` and
 *  `ClientCapabilities | undefined`, and we only need two fields. */
export interface RawClientInfo {
  name?: string
  version?: string
}

export interface RawClientCapabilities {
  sampling?: unknown
}

export function classifyMcpClient(
  info?: RawClientInfo | undefined,
  caps?: RawClientCapabilities | undefined,
): McpClientFacts {
  const name = info?.name
  const lower = (name ?? '').toLowerCase()
  // Desktop's local-agent mode reports as claude-code because it IS claude-code
  // (`claude-code/2.1.156 (local-agent, agent-sdk/0.3.156)`), so this one branch
  // correctly covers both the CLI and Desktop's agent surface.
  const surface: McpClientSurface = lower.includes('claude-code')
    ? 'claude-code'
    : lower.includes('claude-ai') || lower === 'claude' || lower.includes('desktop')
      ? 'claude-desktop-chat'
      : lower.includes('codex')
        ? 'codex'
        : 'other'
  return {
    ...(name === undefined ? {} : { name }),
    ...(info?.version === undefined ? {} : { version: info.version }),
    surface,
    canFanOut: surface === 'claude-code',
    sampling: caps?.sampling !== undefined && caps.sampling !== null,
  }
}

/** One line of guidance to append where a hand-off tells an agent how to divide
 *  its work. Kept as prose in ONE place so the three shipped skill channels and
 *  every tool result agree about what each surface can do. */
export function fanOutAdviceFor(facts: McpClientFacts): string {
  if (facts.canFanOut) {
    return 'Your client supports subagents — follow the prompt\'s fan-out rule and divide the reading across a single parallel round.'
  }
  if (facts.surface === 'claude-desktop-chat') {
    return 'This Claude Desktop chat client has no subagent primitive, so ignore the prompt\'s fan-out rule and read serially — it still works, it is just not parallel. For a parallel run, drive the same flight from Claude Code (Desktop\'s local-agent mode counts) instead.'
  }
  return 'This client does not advertise a subagent primitive, so read serially rather than trying to fan out; the prompt\'s fan-out rule is advisory and skipping it changes nothing about the result.'
}
