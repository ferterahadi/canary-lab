import type { AgentActivity } from '../../../../../../shared/flights/types'

// Derive "what is the agent doing right now" from claude's
// `--include-partial-messages` stdout.
//
// That stdout was already being consumed for two things (see agent-process.ts):
// resetting the idle clock, and recovering the final answer. It was explicitly
// NOT used for display — the live view came from the session-JSONL tail. But the
// JSONL only gains a line when a whole content block COMPLETES, so an agent that
// thinks for two minutes and then writes for ninety seconds produces two rows,
// minutes apart, and the viewer looks hung. The partial stream is the only source
// that can fill those gaps, because it is the only one that sees a block mid-flight.
//
// Pure and synchronous on purpose: no clock, no I/O, no persistence. The caller
// owns how often a snapshot is published (agent-progress.ts throttles it) and
// this stays unit-testable against recorded stdout without spawning an agent.
//
// Defensive in the same shape as agent-stream.ts: an unparseable or unexpected
// line is skipped rather than thrown, so a CLI schema change degrades to "fewer
// updates" instead of failing the stage that only wanted to report progress.

/** How much of the answer text rides along. Enough to see sentences forming and
 *  recognise the shape of what is being written; small enough that republishing
 *  it every second is not a payload concern. */
const TAIL_CHARS = 240

export interface CompositionTracker {
  /** Feed one raw stdout chunk. Chunks split anywhere, including mid-line.
   *  Returns the updated snapshot when a viewer would notice a difference, and
   *  null when the chunk carried only noise — so a caller can treat a non-null
   *  return as "worth republishing". */
  push(chunk: string): AgentActivity | null
}

export function createCompositionTracker(): CompositionTracker {
  // Whatever arrived without its terminating newline. Held back rather than
  // parsed, because half a JSON object is indistinguishable from corruption.
  let pending = ''
  let phase: AgentActivity['phase'] = 'requesting'
  let tool = ''
  let thinkingTokens = 0
  let chars = 0
  let tail = ''

  const snapshot = (): AgentActivity =>
    phase === 'tool'
      ? { phase, thinkingTokens, chars, tail, tool }
      : { phase, thinkingTokens, chars, tail }

  const applyBlockStart = (block: Record<string, unknown>): boolean => {
    if (block.type === 'thinking') {
      phase = 'thinking'
      return true
    }
    if (block.type === 'text') {
      // A new answer block supersedes the last one, so the counters describe
      // THIS answer rather than accumulating across a turn's blocks.
      phase = 'writing'
      chars = 0
      tail = ''
      return true
    }
    // A tool_use with no usable name leaves the phase alone: the union pairs
    // `tool` with the phase, so "calling nothing" has no representation.
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      phase = 'tool'
      tool = block.name
      return true
    }
    return false
  }

  const applyDelta = (delta: Record<string, unknown>): boolean => {
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      phase = 'writing'
      chars += delta.text.length
      tail = (tail + delta.text).slice(-TAIL_CHARS)
      return true
    }
    if (delta.type === 'thinking_delta') {
      phase = 'thinking'
      // The model reports its running estimate on the delta as well as on the
      // system line; both feed one counter so either source alone is enough.
      if (typeof delta.estimated_tokens === 'number') thinkingTokens = delta.estimated_tokens
      return true
    }
    // signature_delta / input_json_delta carry nothing a reader can use.
    return false
  }

  const applyStreamEvent = (event: Record<string, unknown>): boolean => {
    if (event.type === 'content_block_start') {
      const block = event.content_block
      return typeof block === 'object' && block !== null
        ? applyBlockStart(block as Record<string, unknown>)
        : false
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      return typeof delta === 'object' && delta !== null
        ? applyDelta(delta as Record<string, unknown>)
        : false
    }
    // Thinking tokens are counted per turn, so a fresh response zeroes them.
    if (event.type === 'message_start' && thinkingTokens !== 0) {
      thinkingTokens = 0
      return true
    }
    return false
  }

  const applySystem = (line: Record<string, unknown>): boolean => {
    if (line.subtype === 'thinking_tokens') {
      const total = line.estimated_tokens
      if (typeof total === 'number' && total !== thinkingTokens) {
        thinkingTokens = total
        return true
      }
      return false
    }
    // `requesting` is the CLI reporting an open HTTP call with nothing back yet
    // — the one phase no content block can announce, and precisely the silence
    // that used to look like a hang.
    if (line.subtype === 'status' && line.status === 'requesting' && phase !== 'requesting') {
      phase = 'requesting'
      return true
    }
    return false
  }

  const apply = (line: Record<string, unknown>): boolean => {
    if (line.type === 'system') return applySystem(line)
    if (line.type === 'stream_event') {
      const event = line.event
      return typeof event === 'object' && event !== null
        ? applyStreamEvent(event as Record<string, unknown>)
        : false
    }
    return false
  }

  return {
    push(chunk) {
      pending += chunk
      // Split at the LAST newline: everything before it is whole lines, the rest
      // stays buffered. `lastIndexOf` rather than split-and-pop because pop's
      // `undefined` case is unreachable (String.split never yields an empty
      // array) and a fallback for it would be an arm no test could reach.
      const end = pending.lastIndexOf('\n')
      if (end < 0) return null
      const complete = pending.slice(0, end)
      pending = pending.slice(end + 1)
      let changed = false
      for (const line of complete.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue // Not our envelope (or split oddly) — nothing to report.
        }
        if (typeof parsed !== 'object' || parsed === null) continue
        if (apply(parsed as Record<string, unknown>)) changed = true
      }
      return changed ? snapshot() : null
    },
  }
}
