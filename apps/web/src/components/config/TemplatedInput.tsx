import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '../../api/client'

// A drop-in TextInput replacement that supports `${slot.key}` tokens which
// resolve from the current envset's slot files at run time. Tokens render as
// inline pills inside a contentEditable shell; typing `${` opens a slot/key
// picker, clicking a pill reopens the picker pre-filled, clicking the × on a
// pill turns it back into the literal `${slot.key}` text the user can edit.
//
// The string value is the single source of truth — every keystroke reads the
// DOM back into a string and calls onChange. External value changes only
// re-render the DOM when the serialized DOM differs.

const TOKEN_RE = /\$\{([a-zA-Z0-9._-]+)\.([a-zA-Z0-9_-]+)\}/g

interface PickerState {
  caret: { top: number; left: number }
  // When set, the picker replaces this existing pill instead of inserting at caret.
  replacingPill: HTMLElement | null
  initialSlot?: string
  initialKey?: string
}

export function TemplatedInput({
  value,
  onChange,
  feature,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  feature: string
  placeholder?: string
  disabled?: boolean
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  // True when we just emitted an onChange from typing — skip the next prop sync
  // so the cursor doesn't jump.
  const skipSync = useRef(false)

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (skipSync.current) {
      skipSync.current = false
      return
    }
    const current = serializeDom(el)
    if (current !== value) renderValueIntoDom(el, value)
  }, [value])

  const handleInput = useCallback((): void => {
    const el = editorRef.current
    if (!el) return
    skipSync.current = true
    const next = serializeDom(el)
    onChange(next)

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const before = textBeforeCaret(el, range)
    if (before.endsWith('${')) {
      const cleanedRange = stripTrailingDollarBrace()
      const cleaned = serializeDom(el)
      if (cleaned !== next) onChange(cleaned)
      setPicker({
        caret: caretAnchor(cleanedRange, el),
        replacingPill: null,
      })
    }
  }, [onChange])

  const handleClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    const pill = target.closest('[data-pill]') as HTMLElement | null
    if (!pill) return
    if (target.closest('[data-detach]')) {
      e.preventDefault()
      const slot = pill.getAttribute('data-slot') ?? ''
      const key = pill.getAttribute('data-key') ?? ''
      pill.replaceWith(document.createTextNode(`\${${slot}.${key}}`))
      skipSync.current = true
      onChange(serializeDom(editorRef.current!))
      return
    }
    e.preventDefault()
    const rect = pill.getBoundingClientRect()
    setPicker({
      caret: { top: rect.bottom + 4, left: Math.max(rect.left, 8) },
      replacingPill: pill,
      initialSlot: pill.getAttribute('data-slot') ?? undefined,
      initialKey: pill.getAttribute('data-key') ?? undefined,
    })
  }

  const handlePick = (slot: string, key: string): void => {
    const el = editorRef.current
    if (!el) return
    const pillNode = makePillNode(slot, key)
    if (picker?.replacingPill) {
      picker.replacingPill.replaceWith(pillNode)
    } else {
      insertNodeAtSelection(el, pillNode)
    }
    skipSync.current = true
    onChange(serializeDom(el))
    setPicker(null)
  }

  return (
    <>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onClick={handleClick}
        data-placeholder={placeholder ?? ''}
        className="templated-input w-full rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
          minHeight: '1.75rem',
          opacity: disabled ? 0.55 : 1,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      />
      <style>{`
        .templated-input:empty::before {
          content: attr(data-placeholder);
          color: var(--text-muted);
          opacity: 0.6;
          pointer-events: none;
        }
        .templated-input [data-pill] {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 1px 4px 1px 6px;
          margin: 0 1px;
          border-radius: 4px;
          background: var(--bg-base);
          border: 1px dashed var(--border-default);
          color: var(--text-primary);
          font-size: 11px;
          line-height: 1.3;
          cursor: pointer;
          user-select: none;
        }
        .templated-input [data-pill]:hover {
          border-style: solid;
        }
        .templated-input [data-detach] {
          all: unset;
          cursor: pointer;
          color: var(--text-muted);
          font-size: 11px;
          padding: 0 2px;
        }
        .templated-input [data-detach]:hover {
          color: #ef4444;
        }
      `}</style>
      {picker && (
        <TokenPicker
          feature={feature}
          state={picker}
          onClose={() => setPicker(null)}
          onPick={handlePick}
        />
      )}
    </>
  )
}

// ─── DOM helpers ──────────────────────────────────────────────────────────

function serializeDom(root: HTMLElement): string {
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

function renderValueIntoDom(root: HTMLElement, value: string): void {
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

function makePillNode(slot: string, key: string): HTMLElement {
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

function caretAnchor(range: Range | null, fallback: HTMLElement): { top: number; left: number } {
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

function textBeforeCaret(root: HTMLElement, range: Range): string {
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const tmp = document.createElement('div')
  tmp.appendChild(pre.cloneContents())
  return serializeDom(tmp)
}

function stripTrailingDollarBrace(): Range | null {
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

function insertNodeAtSelection(root: HTMLElement, node: Node): void {
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

// ─── picker ───────────────────────────────────────────────────────────────

function TokenPicker({
  feature,
  state,
  onClose,
  onPick,
}: {
  feature: string
  state: PickerState
  onClose: () => void
  onPick: (slot: string, key: string) => void
}) {
  const [index, setIndex] = useState<api.EnvsetIndex | null>(null)
  const [slot, setSlot] = useState<string | null>(state.initialSlot ?? null)
  const [keys, setKeys] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.getEnvsetsIndex(feature)
      .then(setIndex)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Load failed'))
  }, [feature])

  useEffect(() => {
    if (!slot || !index || index.envs.length === 0) return
    const env = index.envs[0].name
    api.getEnvsetSlot(feature, env, slot)
      .then((doc) => setKeys(doc.entries.map((e) => e.key)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Load failed'))
  }, [slot, index, feature])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  const slots = index?.envs[0]?.slots ?? []

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-50 w-64 rounded-md p-2 shadow-lg"
      style={{
        top: state.caret.top,
        left: state.caret.left,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div className="mb-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {slot ? `Pick a key from ${slot}` : 'Pick a slot'}
      </div>
      {error && <div className="mb-1 text-[11px]" style={{ color: '#ef4444' }}>{error}</div>}
      {!slot ? (
        slots.length === 0 ? (
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            No slots in this feature. Add one in the Envsets tab.
          </div>
        ) : (
          <div className="max-h-60 overflow-y-auto scrollbar-thin">
            {slots.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSlot(s)}
                className="block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:opacity-80"
                style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
              >
                {s}
              </button>
            ))}
          </div>
        )
      ) : keys === null ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading…</div>
      ) : keys.length === 0 ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Slot has no keys yet. Add some in the Envsets tab.
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => { setSlot(null); setKeys(null) }}
            className="mb-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            ← Back
          </button>
          <div className="max-h-60 overflow-y-auto scrollbar-thin">
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onPick(slot, k)}
                className="block w-full truncate rounded px-2 py-1 text-left text-[11px] hover:opacity-80"
                style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
              >
                {k}
              </button>
            ))}
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
