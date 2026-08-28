import type { ReadableStoryItem } from '../api/types'

export interface ReadableStorySequenceEntry {
  item: ReadableStoryItem
  sequence: readonly number[]
  sequenceLabel: string
  localSequenceLabel: string
}

export interface StoryCodeLineNumber {
  /** Complete English path, retained for inspection and accessibility. */
  sequence: string
  /** Compact number shown beside source whose indentation already conveys depth. */
  label: string
}

interface StoryCandidate {
  depth: number
  sourceSpan: number
}

export function storySequenceLabel(sequence: readonly number[]): string {
  return sequence.map((part, index) => index === 0 ? String(part).padStart(2, '0') : String(part)).join('.')
}

export function storyLocalSequenceLabel(sequence: readonly number[]): string {
  const local = String(sequence.at(-1)!)
  return sequence.length === 1 ? local.padStart(2, '0') : local
}

export function readableStorySequenceEntries(
  steps: readonly ReadableStoryItem[],
  parentSequence: readonly number[] = [],
): ReadableStorySequenceEntry[] {
  return steps.flatMap((item, index) => {
    const sequence = [...parentSequence, index + 1]
    const entry: ReadableStorySequenceEntry = {
      item,
      sequence,
      sequenceLabel: storySequenceLabel(sequence),
      localSequenceLabel: storyLocalSequenceLabel(sequence),
    }
    return item.kind === 'flow'
      ? [entry, ...readableStorySequenceEntries(item.children, sequence)]
      : [entry]
  })
}

/** Return the most specific English row that owns one source line. Nested
 * story rows can overlap their parent flow's range, so depth wins first and
 * the narrower source range breaks ties. */
export function storyItemIdForSourceLine(
  steps: readonly ReadableStoryItem[],
  file: string,
  sourceLine: number,
): string | undefined {
  let best: (StoryCandidate & { id: string }) | undefined
  for (const entry of readableStorySequenceEntries(steps)) {
    const { source } = entry.item
    if (
      source.file !== file
      || sourceLine < source.startLine
      || sourceLine > source.endLine
    ) continue

    const candidate = {
      id: entry.item.id,
      depth: entry.sequence.length,
      sourceSpan: source.endLine - source.startLine,
    }
    if (isMoreSpecificStoryCandidate(candidate, best)) best = candidate
  }
  return best?.id
}

/** Link each visible source line to its most specific English story row. A
 * parent flow and its first child can share a line in compact source; the child
 * wins because it describes that line more precisely, while both remain in the
 * English tree. */
export function storyCodeLineNumbers(
  steps: readonly ReadableStoryItem[],
  file: string,
  visibleStartLine: number,
  visibleEndLine: number,
): ReadonlyMap<number, StoryCodeLineNumber> {
  type Candidate = StoryCodeLineNumber & StoryCandidate

  const candidates = new Map<number, Candidate>()
  for (const entry of readableStorySequenceEntries(steps)) {
    const { source } = entry.item
    if (
      source.file !== file
      || source.endLine < visibleStartLine
      || source.startLine > visibleEndLine
    ) continue

    // A selected block can hide its standalone wrapper brace. Clamp that
    // block's label to the first source row that remains visible.
    const sourceLine = Math.max(source.startLine, visibleStartLine)
    const candidate: Candidate = {
      sequence: entry.sequenceLabel,
      label: entry.localSequenceLabel,
      depth: entry.sequence.length,
      sourceSpan: source.endLine - source.startLine,
    }
    const current = candidates.get(sourceLine)
    if (isMoreSpecificStoryCandidate(candidate, current)) candidates.set(sourceLine, candidate)
  }

  return new Map([...candidates].map(([line, { sequence, label }]) => [line, { sequence, label }]))
}

function isMoreSpecificStoryCandidate(
  candidate: StoryCandidate,
  current: StoryCandidate | undefined,
): boolean {
  return !current
    || candidate.depth > current.depth
    || (candidate.depth === current.depth && candidate.sourceSpan < current.sourceSpan)
}
