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

export { comparisonPatchRows, type PatchRow } from '@shared/comparison-patch'
