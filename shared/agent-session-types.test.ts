import { expectTypeOf, it } from 'vitest'
import type { AgentSessionEvent, AgentSessionMeta, SubagentIdentity, SubagentThread } from './agent-session-types'

it('keeps the normalized session payload contract shared by both applications', () => {
  expectTypeOf<AgentSessionEvent['kind']>().toEqualTypeOf<'user-message' | 'assistant-message' | 'assistant-thinking' | 'tool-call' | 'tool-result'>()
  expectTypeOf<Extract<AgentSessionEvent, { kind: 'user-message' }>>().toEqualTypeOf<{ kind: 'user-message'; timestamp: string; text: string }>()
  expectTypeOf<Extract<AgentSessionEvent, { kind: 'assistant-message' }>>().toEqualTypeOf<{ kind: 'assistant-message'; timestamp: string; text: string; apiError?: boolean }>()
  expectTypeOf<Extract<AgentSessionEvent, { kind: 'assistant-thinking' }>>().toEqualTypeOf<{ kind: 'assistant-thinking'; timestamp: string; text: string }>()
  expectTypeOf<Extract<AgentSessionEvent, { kind: 'tool-call' }>>().toEqualTypeOf<{ kind: 'tool-call'; timestamp: string; toolId: string; name: string; input: unknown }>()
  expectTypeOf<Extract<AgentSessionEvent, { kind: 'tool-result' }>>().toEqualTypeOf<{ kind: 'tool-result'; timestamp: string; toolId: string; output: string; isError?: boolean }>()
  expectTypeOf<AgentSessionMeta>().toEqualTypeOf<{ model?: string; effort?: string }>()
  expectTypeOf<SubagentIdentity>().toEqualTypeOf<{ agentId: string; parentToolId: string; agentType: string; description: string; spawnDepth: number; logPath: string }>()
  expectTypeOf<SubagentThread['events']>().toEqualTypeOf<AgentSessionEvent[]>()
  expectTypeOf<Omit<SubagentThread, 'events'>>().toEqualTypeOf<SubagentIdentity>()
})
