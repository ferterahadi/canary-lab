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

export function recoverClaudeFinalText(stdout: string): string {
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
  return resultText ?? (assistant.join('') || stdout)
}
