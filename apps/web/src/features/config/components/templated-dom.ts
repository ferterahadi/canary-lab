// A drop-in TextInput replacement that supports `${...}` tokens rendered as
// inline pills inside a contentEditable shell; typing `${` opens a picker,
// clicking a pill reopens the picker pre-filled, clicking the × on a pill
// turns it back into literal text the user can edit.
//
// Two token namespaces exist, offered per the `namespaces` prop:
//   - `envset`: `${slot.key}` — resolves from the selected env's slot files,
//     in feature-config values (commands, health checks) ONLY.
//   - `port`: `${port.<slot>}` — the per-run injected port; resolves in
//     feature-config values AND inside applied envset files. It is the only
//     namespace that resolves inside envset files, so envset value editors
//     pass `namespaces={['port']}`.
//
// The string value is the single source of truth — every keystroke reads the
// DOM back into a string and calls onChange. External value changes only
// re-render the DOM when the serialized DOM differs.

export const TOKEN_RE = /\$\{([a-zA-Z0-9._-]+)\.([a-zA-Z0-9_-]+)\}/g

// ─── DOM helpers ──────────────────────────────────────────────────────────

export function serializeDom(root: HTMLElement): string {
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.matches('[data-pill]')) {
      const slot = el.getAttribute('data-slot') ?? ''
      const key = el.getAttribute('data-key') ?? ''
      out += `\${${slot}.${key}}`
      return
    }
    if (el.tagName === 'BR') {
      out += '\n'
      return
    }
    for (const child of Array.from(el.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  return out
}

export function renderValueIntoDom(root: HTMLElement, value: string): void {
  while (root.firstChild) root.removeChild(root.firstChild)
  let last = 0
  for (const m of value.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0
    if (start > last) {
      root.appendChild(document.createTextNode(value.slice(last, start)))
    }
    root.appendChild(makePillNode(m[1], m[2]))
    last = start + m[0].length
  }
  if (last < value.length) {
    root.appendChild(document.createTextNode(value.slice(last)))
  }
}

export function makePillNode(slot: string, key: string): HTMLElement {
  const span = document.createElement('span')
  span.setAttribute('data-pill', '')
  span.setAttribute('data-slot', slot)
  span.setAttribute('data-key', key)
  span.setAttribute('contenteditable', 'false')
  const label = document.createElement('span')
  label.textContent = `\${${slot}.${key}}`
  span.appendChild(label)
  const x = document.createElement('button')
  x.setAttribute('data-detach', '')
  x.setAttribute('type', 'button')
  x.setAttribute('aria-label', 'Detach token')
  x.textContent = '×'
  span.appendChild(x)
  return span
}

export function caretAnchor(range: Range | null, fallback: HTMLElement): { top: number; left: number } {
  // A collapsed Range between text nodes can return a 0×0 rect in some
  // browsers. Detect that and fall back to the editor's bottom-left so the
  // picker still anchors to a visible place.
  if (range) {
    const r = range.getBoundingClientRect()
    if (r.top !== 0 || r.left !== 0 || r.width !== 0 || r.height !== 0) {
      return { top: r.bottom + 4, left: r.left }
    }
  }
  const f = fallback.getBoundingClientRect()
  return { top: f.bottom + 4, left: f.left }
}

export function textBeforeCaret(root: HTMLElement, range: Range): string {
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const tmp = document.createElement('div')
  tmp.appendChild(pre.cloneContents())
  return serializeDom(tmp)
}

export function stripTrailingDollarBrace(): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const text = node.textContent ?? ''
  const offset = range.startOffset
  if (offset < 2 || text.slice(offset - 2, offset) !== '${') return null
  node.textContent = text.slice(0, offset - 2) + text.slice(offset)
  const newRange = document.createRange()
  newRange.setStart(node, offset - 2)
  newRange.setEnd(node, offset - 2)
  sel.removeAllRanges()
  sel.addRange(newRange)
  return newRange
}

export function insertNodeAtSelection(root: HTMLElement, node: Node): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.appendChild(node)
    return
  }
  const range = sel.getRangeAt(0)
  range.deleteContents()
  range.insertNode(node)
  const after = document.createRange()
  after.setStartAfter(node)
  after.setEndAfter(node)
  sel.removeAllRanges()
  sel.addRange(after)
}
