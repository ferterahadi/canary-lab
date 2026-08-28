import type { EnglishNode, EnglishSegment } from './ir'

// Layout is part of the language definition, not presentation preference:
// identical IR must always produce identical text. A node renders on one line
// exactly when nothing in it demands structure; otherwise every segment takes
// its own line and nested structure indents by one step.

export const ENGLISH_INDENT = '    '

export function isInline(node: EnglishNode): boolean {
  if (node.kind === 'atom') return true
  if (node.kind === 'seq') return node.parts.every(isInline)
  if (node.layout === 'block') return false
  return node.segments.every(segmentIsInline)
}

function segmentIsInline(segment: EnglishSegment): boolean {
  if (segment.separate) return false
  if (segment.child && !isInline(segment.child)) return false
  // A list stays inline only when every item is a single atom: joining
  // structured items with " and " would blur item boundaries against the
  // "and"s inside the items themselves.
  if (segment.list && !segment.list.every((item) => item.kind === 'atom')) return false
  return true
}

/** Join inline list items as prose: `a`, `b` and `c`. */
function joinInline(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

export function renderInline(node: EnglishNode): string {
  if (node.kind === 'atom') return node.text
  if (node.kind === 'seq') return node.parts.map(renderInline).join(' ')
  return node.segments.map(renderInlineSegment).join(' ')
}

function renderInlineSegment(segment: EnglishSegment): string {
  const rendered = segment.child
    ? renderInline(segment.child)
    : segment.list
      ? joinInline(segment.list.map(renderInline))
      : ''
  return rendered ? (segment.label ? `${segment.label} ${rendered}` : rendered) : segment.label
}

export function renderLines(node: EnglishNode, depth = 0): string[] {
  const pad = ENGLISH_INDENT.repeat(depth)
  if (node.kind === 'atom' || isInline(node)) return [pad + renderInline(node)]
  if (node.kind === 'seq') {
    // A phrase forced into block layout by a structural part: each part keeps
    // the phrase's own depth, so the phrase reads as consecutive lines.
    return node.parts.flatMap((part) => renderLines(part, depth))
  }
  const lines: string[] = []
  for (const segment of node.segments) {
    if (segment.child) {
      if (!segment.separate && isInline(segment.child)) {
        lines.push(pad + renderInlineSegment(segment))
      } else if (segment.label) {
        lines.push(`${pad}${segment.label}:`)
        lines.push(...renderLines(segment.child, depth + 1))
      } else {
        // A label-less structural child continues the clause at its own depth.
        lines.push(...renderLines(segment.child, depth))
      }
      continue
    }
    if (segment.list) {
      if (segment.list.length === 0) {
        lines.push(pad + segment.label)
        continue
      }
      lines.push(`${pad}${segment.label}:`)
      for (const item of segment.list) lines.push(...renderLines(item, depth + 1))
      continue
    }
    lines.push(pad + segment.label)
  }
  return lines
}

export function renderEnglish(node: EnglishNode): string {
  return renderLines(node).join('\n')
}

/** One-line digest for surfaces that cannot show a block (flowchart node
 *  titles): the full inline text when the node is inline, otherwise its first
 *  line marked as elided. */
export function renderSummary(node: EnglishNode): string {
  if (isInline(node)) return renderInline(node)
  return `${renderLines(node)[0]} …`
}
