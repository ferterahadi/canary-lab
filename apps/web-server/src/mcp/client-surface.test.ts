import { describe, expect, it } from 'vitest'
import { classifyMcpClient, clientKindFromFacts, fanOutAdviceFor, type McpClientSurface } from './client-surface'

// The `name` values below are the ones real clients send, not invented examples:
// the Claude Code CLI and Desktop's local-agent mode both identify as
// claude-code (local-agent mode IS the CLI — observed as
// `claude-code/2.1.156 (local-agent, agent-sdk/0.3.156)`), while Desktop's plain
// chat client identifies as claude-ai.

describe('classifyMcpClient — which surface is connected', () => {
  it('treats the Claude Code CLI as able to fan out', () => {
    const facts = classifyMcpClient({ name: 'claude-code', version: '2.1.220' })
    expect(facts).toMatchObject({ surface: 'claude-code', canFanOut: true, version: '2.1.220' })
  })

  // Observed live on this machine: Desktop's local-agent mode identifies itself as
  // `local-agent-mode-<serverName>`, NOT `claude-code` — even though it runs the
  // real CLI through the Agent SDK and therefore HAS Task subagents. Matching only
  // on `claude-code` classified it as unknown and told the one capable Desktop
  // surface to read serially.
  it.each(['local-agent-mode-Canary_Lab', 'local-agent-mode-something-else'])(
    'treats Desktop local-agent mode (%s) as claude-code — it HAS subagents',
    (name) => {
      const facts = classifyMcpClient({ name, version: '1.0.0' })
      expect(facts.surface).toBe('claude-code')
      expect(facts.canFanOut).toBe(true)
    },
  )

  it('still recognises a plain claude-code client', () => {
    const facts = classifyMcpClient({ name: 'claude-code', version: '2.1.156' })
    expect(facts.surface).toBe('claude-code')
    expect(facts.canFanOut).toBe(true)
  })

  it('treats the Desktop chat client as having no subagent primitive', () => {
    const facts = classifyMcpClient({ name: 'claude-ai', version: '1.24012.9' })
    expect(facts).toMatchObject({ surface: 'claude-desktop-chat', canFanOut: false })
  })

  it.each(['claude', 'Claude Desktop'])('classifies %s as the chat surface', (name) => {
    expect(classifyMcpClient({ name }).surface).toBe('claude-desktop-chat')
  })

  it('classifies codex as its own surface with no subagent primitive', () => {
    expect(classifyMcpClient({ name: 'codex-cli' })).toMatchObject({ surface: 'codex', canFanOut: false })
  })

  it('is conservative about an unknown or absent client', () => {
    expect(classifyMcpClient({ name: 'mcp-inspector' })).toMatchObject({ surface: 'other', canFanOut: false })
    expect(classifyMcpClient(undefined)).toMatchObject({ surface: 'other', canFanOut: false })
    expect(classifyMcpClient({}).name).toBeUndefined()
  })

  it('omits version when the client did not send one', () => {
    expect('version' in classifyMcpClient({ name: 'claude-code' })).toBe(false)
  })
})

describe('classifyMcpClient — sampling capability', () => {
  // No shipped client declares sampling today (verified against both binaries).
  // This is read rather than assumed so it stops being false without a code change.
  it('reports sampling absent when the client declares none', () => {
    expect(classifyMcpClient({ name: 'claude-code' }, {}).sampling).toBe(false)
    expect(classifyMcpClient({ name: 'claude-code' }, undefined).sampling).toBe(false)
  })

  it('reports sampling present when a client eventually declares it', () => {
    expect(classifyMcpClient({ name: 'claude-code' }, { sampling: {} }).sampling).toBe(true)
    expect(classifyMcpClient({ name: 'claude-code' }, { sampling: { tools: {} } }).sampling).toBe(true)
  })
})

describe('fanOutAdviceFor', () => {
  it('tells a subagent-capable client to divide the reading', () => {
    const advice = fanOutAdviceFor(classifyMcpClient({ name: 'claude-code' }))
    expect(advice).toMatch(/supports subagents/i)
    expect(advice).toMatch(/fan-out rule/i)
  })

  it('tells the Desktop chat client to read serially, and where to go for parallel', () => {
    const advice = fanOutAdviceFor(classifyMcpClient({ name: 'claude-ai' }))
    expect(advice).toMatch(/no subagent primitive/i)
    expect(advice).toMatch(/read serially/i)
    // Naming the alternative is the point — the capable surface is one app away.
    expect(advice).toMatch(/local-agent mode/i)
  })

  it('tells an unknown client to read serially without implying a defect', () => {
    const advice = fanOutAdviceFor(classifyMcpClient({ name: 'mcp-inspector' }))
    expect(advice).toMatch(/read serially/i)
    expect(advice).toMatch(/advisory/i)
  })
})

describe('clientKindFromFacts — branding fallback when the connect URL had no client_kind', () => {
  // The incident this pins: a raw HTTP client (no bridge, so no client_kind
  // param) whose handshake said `claude-code` was branded "AI Agent" in the
  // Heal Agent panel. The fallback must brand by handshake identity instead.
  it.each([
    ['claude-code', 'claude'],
    ['local-agent-mode-Canary_Lab', 'claude'],
    ['claude-ai', 'claude'],
    ['codex-cli', 'codex'],
    ['mcp-inspector', 'other'],
  ])('brands a %s handshake as %s', (name, kind) => {
    expect(clientKindFromFacts(classifyMcpClient({ name }))).toBe(kind)
  })

  it('brands an absent handshake as other', () => {
    expect(clientKindFromFacts(classifyMcpClient(undefined))).toBe('other')
  })

  it('never mints a claim-suppressing *-pty kind from a handshake, for any surface', () => {
    // Exhaustive over McpClientSurface: the *-pty kinds may only arrive via the
    // explicit client_kind the runner's spawn config sets, never by inference —
    // otherwise a handshake string could flip heal-claim suppression.
    const surfaces: McpClientSurface[] = ['claude-code', 'claude-desktop-chat', 'codex', 'other']
    for (const surface of surfaces) {
      const kind = clientKindFromFacts({ surface, canFanOut: false, sampling: false })
      expect(['claude', 'codex', 'other']).toContain(kind)
    }
  })
})
