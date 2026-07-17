// Recover the final assistant text from claude `--output-format=stream-json`
// stdout. stream-json is consumed ONLY so that (a) the idle clock can reset on
// each chunk — claude `-p` is otherwise silent for the whole final-message
// composition — and (b) we can pull the answer back out, since stdout is no
// longer the plain final message. The live view still comes from the session
// JSONL tail; this never touches display.
//
// Defensive: a non-JSON or unexpected line is skipped, and we fall back to the
// concatenated assistant text, then to the raw stdout, so a schema drift
// degrades to "use whatever we got" rather than throwing.

/** One pass over stream-json stdout: the terminal result text (if any) and
 *  every assistant text block, in order across ALL turns. Both recover* helpers
 *  read from this so they can't drift apart. */
function collectClaudeText(stdout: string): { resultText: string | null; assistant: string[] } {
  let resultText: string | null = null
  const assistant: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(trimmed) as Record<string, unknown> } catch { continue }
    if (!o || typeof o !== 'object') continue
    // Terminal result envelope: { type:'result', result:'<final text>' }
    if (o.type === 'result' && typeof o.result === 'string') {
      resultText = o.result
      continue
    }
    // A complete assistant message: { type:'assistant', message:{ content:[...] } }
    if (o.type === 'assistant') {
      const content = (o.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === 'text' && typeof block.text === 'string') assistant.push(block.text)
        }
      }
    }
  }
  return { resultText, assistant }
}

export function recoverClaudeFinalText(stdout: string): string {
  const { resultText, assistant } = collectClaudeText(stdout)
  return resultText ?? (assistant.join('') || stdout)
}

// Every assistant turn's text joined, NOT just the final message. For callers
// that parse structured output (a ```json fence) out of the transcript: an
// agent that answers with the JSON in one turn and then signs off with prose in
// a later turn would otherwise lose the JSON — recoverClaudeFinalText returns
// only that trailing prose. Joining all turns keeps the earlier answer intact.
export function recoverClaudeAssistantText(stdout: string): string {
  const { resultText, assistant } = collectClaudeText(stdout)
  // Fold the terminal result in too (it may hold text no assistant block did).
  const parts = resultText && !assistant.includes(resultText) ? [...assistant, resultText] : assistant
  return parts.join('\n') || stdout
}
