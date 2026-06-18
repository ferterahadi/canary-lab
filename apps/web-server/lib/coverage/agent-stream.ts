// Parse Claude's `--output-format=stream-json` stdout (R: live agent output).
//
// The coverage + summary agents are single `claude -p` completions, so the
// on-disk session JSONL the AgentSessionView tails only gains the final answer
// at completion — it can't token-stream. The genuine live stream is claude's
// stream-json stdout: a sequence of JSON objects, one per line. This module
// turns that stream into (a) readable text to append to the live job log as the
// model writes, and (b) the final answer text the engine parses.
//
// These helpers are pure + unit-tested so the logic is verifiable without a live
// claude (the exact wire shapes can only be confirmed in the user's env, so the
// parser is defensive and the caller falls back to the deterministic lane on any
// miss — generation never breaks, it just degrades).

export type ClaudeStreamPiece =
  | { t: 'delta'; text: string }       // incremental assistant text (partial messages)
  | { t: 'assistant'; text: string }   // a complete assistant text block
  | { t: 'thinking'; text: string }    // a complete thinking block
  | { t: 'tool'; name: string }        // a tool_use the model emitted
  | { t: 'result'; text: string }      // the terminal result envelope

/** Parse one stream-json line into a typed piece, or null if it carries nothing
 *  user-visible. Tolerant of the known shape variants across claude versions. */
export function parseClaudeStreamLine(line: string): ClaudeStreamPiece | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(trimmed) as Record<string, unknown> } catch { return null }
  if (!o || typeof o !== 'object') return null

  const type = o.type

  // Terminal result envelope: { type:'result', result:'<final text>' }
  if (type === 'result') {
    const r = o.result
    if (typeof r === 'string') return { t: 'result', text: r }
    return null
  }

  // Partial token delta. Two observed shapes:
  //   { type:'stream_event', event:{ type:'content_block_delta', delta:{ type:'text_delta', text } } }
  //   { type:'content_block_delta', delta:{ type:'text_delta', text } }
  const evt = (type === 'stream_event' ? (o.event as Record<string, unknown> | undefined) : o) ?? undefined
  if (evt && (evt.type === 'content_block_delta')) {
    const delta = evt.delta as { type?: unknown; text?: unknown; thinking?: unknown } | undefined
    if (delta) {
      if (delta.type === 'text_delta' && typeof delta.text === 'string') return { t: 'delta', text: delta.text }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') return { t: 'delta', text: delta.thinking }
    }
    return null
  }

  // A complete assistant message: { type:'assistant', message:{ content:[...] } }
  if (type === 'assistant') {
    const content = (o.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(content)) {
      const parts: string[] = []
      let toolName: string | null = null
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block?.type === 'tool_use' && typeof block.name === 'string') toolName = block.name
      }
      if (parts.length) return { t: 'assistant', text: parts.join('') }
      if (toolName) return { t: 'tool', name: toolName }
    }
    return null
  }

  return null
}

export interface ClaudeStreamSink {
  /** Feed a raw stdout chunk (may contain partial lines). */
  push(chunk: string): void
  /** The best final answer text after the stream closes. */
  finalText(): string
}

/**
 * Build a stateful sink that line-buffers claude stream-json stdout, streams
 * readable text to `onOutput` as the model writes (token deltas when present,
 * otherwise complete blocks — never both, so the log isn't duplicated), and
 * exposes the final answer text. Falls back to raw stdout if nothing parsed.
 */
export function makeClaudeStreamSink(onOutput?: (chunk: string) => void): ClaudeStreamSink {
  let buf = ''
  let raw = ''
  let sawDelta = false
  let assistantConcat = ''
  let resultText: string | null = null

  const handleLine = (line: string): void => {
    const piece = parseClaudeStreamLine(line)
    if (!piece) return
    switch (piece.t) {
      case 'delta':
        sawDelta = true
        onOutput?.(piece.text)
        break
      case 'assistant':
        assistantConcat += piece.text
        // Only echo the complete block if we never saw token deltas for it,
        // so partial-message streams don't print the text twice.
        if (!sawDelta) onOutput?.(piece.text)
        break
      case 'thinking':
        onOutput?.(piece.text)
        break
      case 'tool':
        onOutput?.(`\n[tool: ${piece.name}]\n`)
        break
      case 'result':
        resultText = piece.text
        break
    }
  }

  return {
    push(chunk: string): void {
      raw += chunk
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handleLine(line)
      }
    },
    finalText(): string {
      // Flush any trailing partial line.
      if (buf.trim()) { handleLine(buf); buf = '' }
      return resultText ?? (assistantConcat || raw)
    },
  }
}
