export interface TextPart { text: string; changed: boolean }

/** Preserve every character, including whitespace. Bound the quadratic alignment
 * work so a captured minified line cannot freeze the review screen. */
export function compareText(before: string, after: string): { before: TextPart[]; after: TextPart[] } {
  const tokenize = (text: string): string[] => text.match(/@[\p{L}\p{N}_-]+|[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []
  const a = tokenize(before)
  const b = tokenize(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const left: TextPart[] = []
  const right: TextPart[] = []
  const append = (parts: TextPart[], text: string, changed: boolean): void => {
    if (!text) return
    const last = parts.at(-1)
    if (last?.changed === changed) last.text += text
    else parts.push({ text, changed })
  }
  const prefix = a.slice(0, start).join('')
  append(left, prefix, false)
  append(right, prefix, false)
  const height = endA - start + 1
  const width = endB - start + 1
  if (height * width > 250_000) {
    append(left, a.slice(start, endA).join(''), true)
    append(right, b.slice(start, endB).join(''), true)
  } else {
    const lengths = new Uint32Array(height * width)
    for (let i = height - 2; i >= 0; i--) {
      for (let j = width - 2; j >= 0; j--) {
        lengths[i * width + j] = a[start + i] === b[start + j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < height - 1 || j < width - 1) {
      if (i < height - 1 && j < width - 1 && a[start + i] === b[start + j]) {
        append(left, a[start + i++], false)
        append(right, b[start + j++], false)
      } else if (i < height - 1 && (j === width - 1 || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
        append(left, a[start + i++], true)
      } else append(right, b[start + j++], true)
    }
  }
  const suffix = a.slice(endA).join('')
  append(left, suffix, false)
  append(right, suffix, false)
  return { before: left, after: right }
}

export type PatchRow = { kind: 'section'; text: string } | { kind: 'values'; before: string | null; after: string | null }

/** Pair adjacent deletion/addition blocks without crossing context or file
 * boundaries. Hunk counts distinguish source starting with ---/+++ from headers. */
export function comparisonPatchRows(diff: string): PatchRow[] {
  const rows: PatchRow[] = []
  let removed: string[] = []
  let added: string[] = []
  let oldRemaining = 0
  let newRemaining = 0
  const flush = (): void => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ kind: 'values', before: removed[i] ?? null, after: added[i] ?? null })
    }
    removed = []
    added = []
  }
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      flush()
      oldRemaining = Number(hunk[2] ?? 1)
      newRemaining = Number(hunk[4] ?? 1)
      rows.push({ kind: 'section', text: line })
    } else if (line.startsWith('-') && (oldRemaining > 0 || !line.startsWith('--- '))) {
      if (added.length) flush()
      removed.push(line.slice(1))
      oldRemaining = Math.max(0, oldRemaining - 1)
    } else if (line.startsWith('+') && (newRemaining > 0 || !line.startsWith('+++ '))) {
      added.push(line.slice(1))
      newRemaining = Math.max(0, newRemaining - 1)
    } else {
      flush()
      if (line.startsWith(' ') && (oldRemaining > 0 || newRemaining > 0)) {
        rows.push({ kind: 'values', before: line.slice(1), after: line.slice(1) })
        oldRemaining = Math.max(0, oldRemaining - 1)
        newRemaining = Math.max(0, newRemaining - 1)
      } else rows.push({ kind: 'section', text: line })
    }
  }
  flush()
  return rows
}
