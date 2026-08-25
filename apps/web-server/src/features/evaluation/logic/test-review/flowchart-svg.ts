import path from 'path'
import { escapeAttr, escapeHtml, inline } from './text'
import type { FlowNode } from './types'

export function renderFlowchartSvg(nodes: FlowNode[], title: string, chartIndex: number): string {
  // Every chart owns its <defs> ids. Sharing one `#nodeShadow` across all charts
  // means the whole report's node shapes vanish the moment the case that happens
  // to hold the first definition is collapsed — a `display:none` subtree stops
  // providing a usable filter, and every reference to it renders as nothing.
  const arrowId = `arrow-${chartIndex}`
  const shadowId = `node-shadow-${chartIndex}`
  const width = 1280
  const nodesPerRow = 4
  const rowHeight = 150
  const rows = Math.max(1, Math.ceil(nodes.length / nodesPerRow))
  const height = 36 + rows * rowHeight
  const nodeWidth = 230
  const nodeHeight = 84
  const gap = 62
  const startX = 50
  const startY = 38
  // Every colour is a CSS custom property so the inline SVG recolours with the
  // document's light/dark switch — an SVG with baked hex fills is a white slab
  // in dark mode.
  const colors: Record<FlowNode['kind'], { fill: string; stroke: string; text: string }> = {
    start: { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' },
    setup: { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' },
    action: { fill: 'var(--flow-action-fill)', stroke: 'var(--flow-action-line)', text: 'var(--flow-action-text)' },
    helper: { fill: 'var(--flow-helper-fill)', stroke: 'var(--flow-helper-line)', text: 'var(--flow-helper-text)' },
    assertion: { fill: 'var(--flow-assert-fill)', stroke: 'var(--flow-assert-line)', text: 'var(--flow-assert-text)' },
    end: { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' },
  }
  const body = nodes.map((node, idx) => {
    const row = Math.floor(idx / nodesPerRow)
    const col = idx % nodesPerRow
    const x = startX + col * (nodeWidth + gap)
    const y = startY + row * rowHeight
    const color = node.kind === 'end' ? resultColor(node.title) : colors[node.kind]
    const titleLines = clampSvgText(node.title, 25, 2)
    const detailLines = node.detail ? clampSvgText(node.detail, 31, 2) : []
    const text = renderNodeText({ x, y, width: nodeWidth, height: nodeHeight, color: color.text, titleLines, detailLines })
    const next = idx < nodes.length - 1 ? {
      row: Math.floor((idx + 1) / nodesPerRow),
      col: (idx + 1) % nodesPerRow,
    } : null
    const arrow = next
      ? next.row === row
        ? `<path class="connector" d="M${x + nodeWidth + 10} ${y + nodeHeight / 2} L${x + nodeWidth + gap - 12} ${y + nodeHeight / 2}" marker-end="url(#${arrowId})" />`
        : rowWrapConnector({ x, y, nodeWidth, nodeHeight, rowHeight, startX, nextTop: startY + next.row * rowHeight, arrowId })
      : ''
    const codeAttr = typeof node.codeLine === 'number' ? ` data-code-line="${node.codeLine}" tabindex="0"` : ''
    return `<g class="flow-node"${codeAttr}>
      <title>${escapeHtml(node.detail ? `${node.title}: ${node.detail}` : node.title)}</title>
      ${nodeShape(node.kind, x, y, nodeWidth, nodeHeight, color.fill, color.stroke, shadowId)}
      ${text}
      ${arrow}
    </g>`
  }).join('\n')
  return `<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Evaluation flow for ${escapeAttr(title)}">
  <defs>
    <marker id="${arrowId}" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L7,3 z" class="arrowhead" />
    </marker>
    <filter id="${shadowId}" x="-10%" y="-20%" width="120%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" />
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="14" fill="var(--flow-bg)" />
  <style>.connector{fill:none;stroke:var(--flow-line);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.arrowhead{fill:var(--flow-line)}feDropShadow{flood-color:var(--flow-shadow);flood-opacity:1}.flow-node{cursor:pointer}.flow-node:focus{outline:none}.flow-node.is-active rect,.flow-node.is-active polygon,.flow-node.is-active path{stroke-width:3}</style>
  <style>text{font-family:var(--font-sans)}</style>
  ${body}
</svg>
`
}

/** The step that carries on to the next row. Drawn as a stepped path down into
 *  the gutter, back along it and down into the next row's first node — a single
 *  bezier across the full width read as a stray swoop under the diagram. */
export function rowWrapConnector(args: {
  x: number
  y: number
  nodeWidth: number
  nodeHeight: number
  rowHeight: number
  startX: number
  nextTop: number
  arrowId: string
}): string {
  const radius = 10
  const from = args.x + args.nodeWidth / 2
  const to = args.startX + args.nodeWidth / 2
  const gutter = args.y + args.nodeHeight + (args.rowHeight - args.nodeHeight) / 2
  const d = [
    `M${from} ${args.y + args.nodeHeight + 6}`,
    `V${gutter - radius}`,
    `Q${from} ${gutter} ${from - radius} ${gutter}`,
    `H${to + radius}`,
    `Q${to} ${gutter} ${to} ${gutter + radius}`,
    `V${args.nextTop - 10}`,
  ].join(' ')
  return `<path class="connector" d="${d}" marker-end="url(#${args.arrowId})" />`
}

export function renderNodeText(args: {
  x: number
  y: number
  width: number
  height: number
  color: string
  titleLines: string[]
  detailLines: string[]
}): string {
  const titleSize = 14
  const detailSize = 11
  const titleGap = 16
  const detailGap = 14
  const blockGap = args.titleLines.length && args.detailLines.length ? 8 : 0
  const blockHeight =
    (args.titleLines.length * titleGap) +
    blockGap +
    (args.detailLines.length * detailGap)
  let cursor = args.y + (args.height - blockHeight) / 2 + 12
  const title = args.titleLines.map((line) => {
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${titleSize}" font-weight="800" fill="${args.color}">${escapeHtml(line)}</text>`
    cursor += titleGap
    return out
  })
  if (blockGap) cursor += blockGap
  const detail = args.detailLines.map((line) => {
    const out = `<text x="${args.x + args.width / 2}" y="${cursor}" text-anchor="middle" font-size="${detailSize}" fill="var(--flow-detail-text)">${escapeHtml(line)}</text>`
    cursor += detailGap
    return out
  })
  return [...title, ...detail].join('')
}

export function resultColor(title: string): { fill: string; stroke: string; text: string } {
  const normalized = title.toLowerCase()
  if (normalized.includes('passed') || normalized.includes('succeed') || normalized.includes('success')) {
    return { fill: 'var(--flow-pass-fill)', stroke: 'var(--flow-pass-line)', text: 'var(--flow-pass-text)' }
  }
  if (normalized.includes('failed') || normalized.includes('fail')) {
    return { fill: 'var(--flow-fail-fill)', stroke: 'var(--flow-fail-line)', text: 'var(--flow-fail-text)' }
  }
  return { fill: 'var(--flow-neutral-fill)', stroke: 'var(--flow-neutral-line)', text: 'var(--flow-neutral-text)' }
}

export function nodeShape(kind: FlowNode['kind'], x: number, y: number, width: number, height: number, fill: string, stroke: string, filterId: string): string {
  if (kind === 'assertion') {
    const points = [
      `${x + 18},${y}`,
      `${x + width - 18},${y}`,
      `${x + width},${y + height / 2}`,
      `${x + width - 18},${y + height}`,
      `${x + 18},${y + height}`,
      `${x},${y + height / 2}`,
    ].join(' ')
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
  }
  if (kind === 'start' || kind === 'end') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
  }
  if (kind === 'setup') {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="6 5" filter="url(#${filterId})" />`
  }
  if (kind === 'helper') {
    return `<path d="M${x} ${y + 10} Q${x} ${y} ${x + 10} ${y} H${x + width - 10} Q${x + width} ${y} ${x + width} ${y + 10} V${y + height - 10} Q${x + width} ${y + height} ${x + width - 10} ${y + height} H${x + 10} Q${x} ${y + height} ${x} ${y + height - 10} Z M${x + 12} ${y} V${y + height}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
  }
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5" filter="url(#${filterId})" />`
}

export function wrapSvgText(text: string, maxChars: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').flatMap((word) => splitLongWord(word, maxChars)).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (!current) {
      current = word
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

export function clampSvgText(text: string, maxChars: number, maxLines: number): string[] {
  const lines = wrapSvgText(text, maxChars)
  if (lines.length <= maxLines) return lines
  const out = lines.slice(0, maxLines)
  out[maxLines - 1] = `${out[maxLines - 1].slice(0, Math.max(0, maxChars - 1)).replace(/\s+$/g, '')}…`
  return out
}

export function splitLongWord(word: string, maxChars: number): string[] {
  if (word.length <= maxChars) return [word]
  const parts: string[] = []
  for (let idx = 0; idx < word.length; idx += maxChars) parts.push(word.slice(idx, idx + maxChars))
  return parts
}
